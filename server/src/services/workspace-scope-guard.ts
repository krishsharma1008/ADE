import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { executionWorkspaces } from "@combyne/db";
import { logger } from "../middleware/logger.js";
import { filterDirtyFilesRelatedToIssue } from "./git-state.js";

const execFileAsync = promisify(execFile);

/**
 * Result of inspecting a BASE checkout before realizing an isolated
 * per-issue workspace. `clean: true` means the base is either pristine or
 * only dirty in ways attributable to a prior session of THIS issue.
 * `clean: false` means there is contamination that should block the run
 * (e.g. uncommitted work that belongs to a different issue).
 */
export type WorkspaceScopeCheckResult =
  | { clean: true; reason?: string }
  | { clean: false; reason: string; suggestion: string };

export interface VerifyCleanBaseCheckoutInput {
  baseCwd: string;
  issueId: string;
  issueIdentifier: string | null;
}

async function pathExists(p: string): Promise<boolean> {
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

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const top = await runGit(["rev-parse", "--show-toplevel"], cwd);
    return top.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

interface PriorSessionMeta {
  sessionCount: number | null;
  lastSessionEndedAt: string | null;
  hadPriorSession: boolean;
}

/**
 * Read the most recent execution workspace metadata for this issue to learn
 * whether THIS issue has run before (and therefore could legitimately have
 * left dirty files in a shared base checkout). The metadata keys
 * `sessionCount` / `lastSessionEndedAt` are written by the heartbeat
 * workspace lifecycle; they may be absent on older rows, in which case we
 * fall back to "no prior session known".
 */
async function loadPriorSessionMeta(
  db: Db,
  issueId: string,
): Promise<PriorSessionMeta> {
  try {
    const row = await db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId))
      .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) {
      return { sessionCount: null, lastSessionEndedAt: null, hadPriorSession: false };
    }
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const rawCount = metadata.sessionCount;
    const sessionCount =
      typeof rawCount === "number" && Number.isFinite(rawCount) ? rawCount : null;
    const rawEnded = metadata.lastSessionEndedAt;
    const lastSessionEndedAt = typeof rawEnded === "string" && rawEnded.length > 0 ? rawEnded : null;
    const hadPriorSession =
      (sessionCount !== null && sessionCount > 0) || lastSessionEndedAt !== null;
    return { sessionCount, lastSessionEndedAt, hadPriorSession };
  } catch (err) {
    logger.debug({ err, issueId }, "workspace-scope-guard: failed to load prior session metadata");
    return { sessionCount: null, lastSessionEndedAt: null, hadPriorSession: false };
  }
}

function describeFiles(paths: string[], cap = 8): string {
  const shown = paths.slice(0, cap);
  const extra = Math.max(0, paths.length - shown.length);
  const list = shown.map((p) => `\`${p}\``).join(", ");
  return extra > 0 ? `${list} (and ${extra} more)` : list;
}

/**
 * Verify that a BASE project checkout is clean enough to safely fork an
 * isolated per-issue workspace from it. Read-only — never mutates the repo.
 *
 * Discrimination:
 *  - Pristine checkout            → clean
 *  - Dirty, but every dirty path relates to THIS issue identifier, OR this
 *    issue has a recorded prior session (so leftover work is plausibly ours)
 *                                 → clean
 *  - Dirty with paths unrelated to this issue and no prior session of this
 *    issue to explain them        → UNCLEAN (block the run)
 *
 * Best-effort: any git/IO failure degrades to `clean: true` so a flaky base
 * never hard-fails an otherwise valid run.
 */
export async function verifyCleanBaseCheckoutForIssue(
  db: Db,
  input: VerifyCleanBaseCheckoutInput,
): Promise<WorkspaceScopeCheckResult> {
  const { baseCwd, issueId, issueIdentifier } = input;
  if (!baseCwd || baseCwd.length === 0) return { clean: true, reason: "no_base_cwd" };
  if (!(await pathExists(baseCwd))) return { clean: true, reason: "base_cwd_missing" };
  if (!(await isGitRepo(baseCwd))) return { clean: true, reason: "base_not_git_repo" };

  let dirty;
  try {
    dirty = await filterDirtyFilesRelatedToIssue(issueIdentifier, baseCwd);
  } catch (err) {
    logger.debug({ err, baseCwd, issueId }, "workspace-scope-guard: dirty inspection failed");
    return { clean: true, reason: "dirty_inspection_failed" };
  }

  if (!dirty.hasDirty) {
    return { clean: true, reason: "base_clean" };
  }

  // Some dirty files exist. Decide whether they are attributable to this issue.
  if (dirty.unrelated.length === 0) {
    // Every dirty path mentions this issue identifier — leftover from us.
    return { clean: true, reason: "dirty_related_to_issue" };
  }

  // There are dirty paths that do NOT obviously belong to this issue. They
  // are tolerable ONLY if this issue has run before (a prior session could
  // have legitimately touched files whose paths don't encode the identifier).
  const prior = await loadPriorSessionMeta(db, issueId);
  if (prior.hadPriorSession) {
    return {
      clean: true,
      reason: "dirty_explained_by_prior_session_of_this_issue",
    };
  }

  const unrelatedPaths = dirty.unrelated.map((f) => f.path);
  const identLabel = issueIdentifier ? ` (${issueIdentifier})` : "";
  return {
    clean: false,
    reason:
      `Base checkout \`${baseCwd}\` has ${dirty.unrelated.length} uncommitted file(s) not attributable to this issue${identLabel} ` +
      `and no recorded prior session of this issue to explain them: ${describeFiles(unrelatedPaths)}. ` +
      `Forking an isolated workspace now would inherit another issue's work.`,
    suggestion:
      `Commit, stash, or revert the unrelated changes in \`${baseCwd}\` before running this issue — e.g. ` +
      `\`git -C "${baseCwd}" stash push -u\` — then re-run. If these changes belong to a different ticket, ` +
      `move them to that ticket's branch first.`,
  };
}
