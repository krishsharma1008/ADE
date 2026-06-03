import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

export interface GitCommitMatch {
  sha: string;
  author: string;
  date: string; // ISO
  subject: string;
}

export interface GitStateInspection {
  workspacePath: string;
  isGitRepo: boolean;
  currentBranch: string | null;
  headSha: string | null;
  dirtyFileCount: number;
  untrackedFileCount: number;
  matchingCommits: GitCommitMatch[];
  matchingBranches: string[];
  matchedBy: Array<"identifier" | "title" | "branch">;
  likelyResolved: boolean;
  recentCommits: GitCommitMatch[];
  summary: string;
}

export interface InspectGitStateOptions {
  cwd: string;
  issueIdentifier: string | null;
  issueTitle: string;
  lookbackCommits?: number;
}

async function pathExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", cwd, ...args], {
    cwd,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000,
  });
}

export interface DirtyFile {
  /** Path relative to the repo root, as reported by `git status --porcelain`. */
  path: string;
  /** Two-character porcelain status code (e.g. " M", "??", "A "). */
  code: string;
  /** Whether the change is untracked (`??`). */
  untracked: boolean;
}

export interface DirtyFilesRelatedToIssue {
  /** All dirty + untracked files in the checkout (relative paths). */
  all: DirtyFile[];
  /**
   * Files whose path appears to relate to the issue identifier
   * (path contains the identifier, slugified or raw). Best-effort.
   */
  related: DirtyFile[];
  /** Dirty files that do NOT obviously relate to the issue identifier. */
  unrelated: DirtyFile[];
  /** True when there is at least one dirty/untracked file. */
  hasDirty: boolean;
}

function parsePorcelainStatus(stdout: string): DirtyFile[] {
  const out: DirtyFile[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    // Rename/copy lines look like "R  old -> new"; keep the destination path.
    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx !== -1) {
      rest = rest.slice(arrowIdx + 4);
    }
    const filePath = rest.trim();
    if (!filePath) continue;
    out.push({ path: filePath, code, untracked: code === "??" });
  }
  return out;
}

/**
 * Read-only classification of a checkout's dirty/untracked files into
 * "related to this issue identifier" vs "unrelated". Used by the workspace
 * scope guard to decide whether a dirty base checkout is leftover from a
 * prior session of the SAME issue (tolerable) or contamination from another
 * issue (unclean).
 *
 * Best-effort and never throws — a non-repo or git failure yields an empty,
 * non-dirty result so callers can degrade gracefully.
 */
export async function filterDirtyFilesRelatedToIssue(
  issueIdentifier: string | null,
  cwd: string,
): Promise<DirtyFilesRelatedToIssue> {
  const empty: DirtyFilesRelatedToIssue = {
    all: [],
    related: [],
    unrelated: [],
    hasDirty: false,
  };
  if (!cwd || cwd.length === 0) return empty;
  if (!(await pathExists(cwd))) return empty;

  let files: DirtyFile[] = [];
  try {
    const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
    files = parsePorcelainStatus(status.stdout);
  } catch {
    return empty;
  }

  if (files.length === 0) {
    return { all: [], related: [], unrelated: [], hasDirty: false };
  }

  const needles: string[] = [];
  if (issueIdentifier && issueIdentifier.trim().length > 0) {
    const raw = issueIdentifier.trim().toLowerCase();
    needles.push(raw);
    // Branch/path slug variants: PAP-12 -> pap-12, pap_12, pap12
    needles.push(raw.replace(/-/g, "_"));
    needles.push(raw.replace(/-/g, ""));
  }

  const related: DirtyFile[] = [];
  const unrelated: DirtyFile[] = [];
  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    const isRelated = needles.length > 0 && needles.some((needle) => lowerPath.includes(needle));
    if (isRelated) related.push(file);
    else unrelated.push(file);
  }

  return { all: files, related, unrelated, hasDirty: files.length > 0 };
}

function parseLogLines(stdout: string): GitCommitMatch[] {
  const out: GitCommitMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\x1f");
    if (parts.length < 4) continue;
    const [sha, author, date, subject] = parts;
    out.push({ sha: sha!.trim(), author: author!.trim(), date: date!.trim(), subject: subject!.trim() });
  }
  return out;
}

function escapeForGrep(raw: string): string {
  return raw.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function sanitizeTitleFragment(title: string): string {
  const slug = title
    .trim()
    .slice(0, 40)
    .replace(/[^\w\s-]/g, "")
    .trim();
  return slug;
}

/**
 * Read-only inspection of the agent's resolved workspace so the heartbeat
 * preamble can tell the agent "your issue key already shows up in commits
 * on branch X". Lets the agent close the loop instead of declaring
 * "nothing to do" when the work has already landed.
 *
 * Never mutates the repo. Best-effort — any git error returns a degraded
 * result rather than throwing, so a broken workspace doesn't fail the run.
 */
export async function inspectGitStateForIssue(
  opts: InspectGitStateOptions,
): Promise<GitStateInspection | null> {
  if (!opts.cwd || opts.cwd.length === 0) return null;
  if (!(await pathExists(opts.cwd))) return null;

  const base: GitStateInspection = {
    workspacePath: opts.cwd,
    isGitRepo: false,
    currentBranch: null,
    headSha: null,
    dirtyFileCount: 0,
    untrackedFileCount: 0,
    matchingCommits: [],
    matchingBranches: [],
    matchedBy: [],
    likelyResolved: false,
    recentCommits: [],
    summary: "",
  };

  try {
    const top = await runGit(["rev-parse", "--show-toplevel"], opts.cwd);
    const repoRoot = top.stdout.trim();
    if (!repoRoot) {
      base.summary = `Workspace \`${opts.cwd}\` is not a git repository — no close-loop inspection available.`;
      return base;
    }
    base.isGitRepo = true;
  } catch {
    base.summary = `Workspace \`${opts.cwd}\` is not a git repository — no close-loop inspection available.`;
    return base;
  }

  try {
    const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], opts.cwd);
    base.currentBranch = branch.stdout.trim() || null;
  } catch {
    // detached HEAD or empty repo
  }

  try {
    const sha = await runGit(["rev-parse", "HEAD"], opts.cwd);
    base.headSha = sha.stdout.trim() || null;
  } catch {
    // empty repo
  }

  try {
    const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], opts.cwd);
    for (const line of status.stdout.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("??")) base.untrackedFileCount++;
      else base.dirtyFileCount++;
    }
  } catch {
    // ignore
  }

  const lookback = Math.max(1, Math.min(opts.lookbackCommits ?? 200, 500));
  const format = ["%H", "%an", "%aI", "%s"].join("\x1f");

  // Build a list of grep terms we care about.
  const terms: string[] = [];
  if (opts.issueIdentifier) {
    terms.push(escapeForGrep(opts.issueIdentifier));
  }
  const titleFragment = sanitizeTitleFragment(opts.issueTitle);
  if (titleFragment.length >= 8) {
    terms.push(escapeForGrep(titleFragment));
  }

  if (terms.length > 0) {
    try {
      const args = [
        "log",
        `-n`,
        String(lookback),
        `--format=${format}`,
        "--all",
        "--extended-regexp",
      ];
      // Multiple --grep terms are OR'd by git.
      for (const t of terms) args.push("--grep", t);
      const logOut = await runGit(args, opts.cwd);
      base.matchingCommits = parseLogLines(logOut.stdout);
      if (base.matchingCommits.length > 0) {
        if (opts.issueIdentifier) base.matchedBy.push("identifier");
        if (titleFragment.length >= 8) base.matchedBy.push("title");
      }
    } catch (err) {
      logger.debug({ err }, "git-state: git log grep failed");
    }
  }

  // Also see if any local or remote branch name contains the identifier.
  if (opts.issueIdentifier) {
    try {
      const branches = await runGit(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
        opts.cwd,
      );
      const needle = opts.issueIdentifier.toLowerCase();
      const matches = branches.stdout
        .split(/\r?\n/)
        .map((b) => b.trim())
        .filter((b) => b && b.toLowerCase().includes(needle));
      if (matches.length > 0) {
        base.matchingBranches = matches.slice(0, 20);
        if (!base.matchedBy.includes("branch")) base.matchedBy.push("branch");
      }
    } catch {
      // ignore
    }
  }

  // Always capture the last handful of commits so the agent can sanity-check
  // whether any very recent work touches the same area.
  try {
    const recent = await runGit(
      ["log", "-n", "10", `--format=${format}`],
      opts.cwd,
    );
    base.recentCommits = parseLogLines(recent.stdout);
  } catch {
    // empty repo
  }

  base.likelyResolved = base.matchingCommits.length > 0 || base.matchingBranches.length > 0;

  const summaryLines: string[] = [];
  if (base.isGitRepo) {
    summaryLines.push(
      `Workspace \`${opts.cwd}\` is a git repo on branch \`${base.currentBranch ?? "(detached)"}\`` +
        (base.headSha ? ` @ \`${base.headSha.slice(0, 10)}\`.` : "."),
    );
    if (base.dirtyFileCount > 0 || base.untrackedFileCount > 0) {
      summaryLines.push(
        `Uncommitted: ${base.dirtyFileCount} tracked, ${base.untrackedFileCount} untracked.`,
      );
    }
    if (base.matchingCommits.length > 0) {
      summaryLines.push(
        `Found ${base.matchingCommits.length} commit(s) mentioning this issue. This work may already be done — confirm with the user before re-implementing.`,
      );
      for (const c of base.matchingCommits.slice(0, 5)) {
        summaryLines.push(`- \`${c.sha.slice(0, 10)}\` ${c.date.slice(0, 10)} — ${c.subject}`);
      }
    }
    if (base.matchingBranches.length > 0) {
      summaryLines.push(`Branches matching this issue id: ${base.matchingBranches.map((b) => `\`${b}\``).join(", ")}.`);
    }
    if (base.matchingCommits.length === 0 && base.matchingBranches.length === 0 && base.recentCommits.length > 0) {
      summaryLines.push(`No direct matches. Most recent commits on HEAD:`);
      for (const c of base.recentCommits.slice(0, 3)) {
        summaryLines.push(`- \`${c.sha.slice(0, 10)}\` ${c.date.slice(0, 10)} — ${c.subject}`);
      }
    }
  } else {
    summaryLines.push(`Workspace \`${opts.cwd}\` is not a git repository — no close-loop inspection available.`);
  }
  base.summary = summaryLines.join("\n");
  return base;
}
