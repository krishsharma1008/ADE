import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { issues } from "@combyne/db";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

// Require a non-alphanumeric boundary on both sides so we only match standalone
// tokens, not fragments inside larger words/identifiers.
const ISSUE_IDENTIFIER_RE = /(?<![A-Za-z0-9])([A-Z]+)-(\d+)(?![A-Za-z0-9])/g;

/**
 * All-uppercase prefixes that look like Jira/Linear project keys but are in
 * fact well-known encoding / standard / protocol / algorithm tokens. A commit
 * message such as `Fix UTF-8 decoding` or `Switch SHA-1 to SHA-256` must NOT be
 * read as referencing the imaginary tickets `UTF-8` / `SHA-1`, otherwise the
 * scope-diff guard would flag a perfectly in-scope change as cross-issue and
 * (for opted-in projects) block its auto-close.
 */
const NON_ISSUE_PREFIXES = new Set([
  "UTF", // UTF-8, UTF-16
  "SHA", // SHA-1, SHA-256
  "ISO", // ISO-8601, ISO-9001
  "HTTP", // HTTP-2
  "RFC", // RFC-1234 (a spec ref, not a ticket)
  "IPV", // IPV-4/IPV-6 spellings
  "AES", // AES-256
  "RSA", // RSA-2048
  "BASE", // BASE-64
  "CVE", // CVE-2024-... (security advisory id, not our ticket)
  "WCAG", // WCAG-2
  "PCI", // PCI-3
]);

/**
 * Extract Jira/Linear-style issue identifiers (e.g. `PAP-123`, `ENG-7`) from
 * free text. Returns a de-duplicated, order-preserving list.
 *
 * Filters out well-known non-issue tokens (UTF-8, SHA-1, ISO-8601, …) that share
 * the `LETTERS-DIGITS` shape but never name a ticket. The match is also bounded
 * so it does not fire on fragments embedded inside larger words.
 */
export function extractIssueIdentifiers(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(ISSUE_IDENTIFIER_RE)) {
    const full = match[0];
    const prefix = (match[1] ?? "").toUpperCase();
    if (NON_ISSUE_PREFIXES.has(prefix)) continue;
    if (!seen.has(full)) {
      seen.add(full);
      out.push(full);
    }
  }
  return out;
}

export interface ScopeDiffViolation {
  kind: "cross_issue_commit_reference" | "service_boundary_crossing";
  detail: string;
  evidence: string[];
}

export type ScopeDiffValidationResult =
  | { valid: true; reason?: string }
  | { valid: false; reason: string; violations: ScopeDiffViolation[] };

export interface ValidateScopeDiffInput {
  issueId: string;
  issueIdentifier: string | null;
  changedFiles: string[];
  worktreeCwd: string | null;
  baseRef: string | null;
  /**
   * Project-declared allow-list of top-level service/path segments this issue
   * is permitted to touch beyond its own. Anything not on this list that
   * crosses a service boundary is flagged. When omitted, boundary crossing is
   * not enforced (telemetry-only callers still get the cross-ref check).
   */
  projectScopeExceptions?: string[] | null;
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

/**
 * Read commit subjects/bodies for commits on the worktree that are not on the
 * base ref. Best-effort — returns [] on any failure or when the worktree has
 * no history relative to base (a fresh worktree).
 */
async function loadBranchCommitMessages(
  worktreeCwd: string,
  baseRef: string | null,
): Promise<string[]> {
  const format = "%s%n%b";
  // Prefer the range base..HEAD when we know the base ref; otherwise fall back
  // to the most recent commits on HEAD.
  const candidates: string[][] = [];
  if (baseRef) {
    candidates.push(["log", `${baseRef}..HEAD`, "--no-merges", "--format=" + format]);
  }
  candidates.push(["log", "-n", "50", "--no-merges", "--format=" + format]);

  for (const args of candidates) {
    try {
      const out = await runGit(args, worktreeCwd);
      const text = out.stdout.trim();
      if (text.length === 0) {
        // Empty range — try the next candidate (e.g. fresh worktree at base).
        continue;
      }
      return text.split(/\n{2,}/).map((block) => block.trim()).filter((b) => b.length > 0);
    } catch (err) {
      logger.debug({ err, worktreeCwd, args }, "scope-diff-validator: git log failed");
      // Try next candidate.
    }
  }
  return [];
}

/**
 * Top-level path segment that we treat as a "service boundary". For monorepos
 * this is the first path component (e.g. `packages/foo/...` → `packages`,
 * `services/payments/...` → `services`). We additionally key on the second
 * segment when the first is a generic container (`packages`, `services`,
 * `apps`, `modules`) so two siblings under `services/` count as distinct
 * boundaries.
 */
const GENERIC_CONTAINERS = new Set(["packages", "services", "apps", "modules", "libs"]);

function serviceBoundaryForPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (normalized.length === 0) return null;
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const first = segments[0]!;
  if (GENERIC_CONTAINERS.has(first) && segments.length >= 2) {
    return `${first}/${segments[1]}`;
  }
  return first;
}

/**
 * Heuristic scope validation run right before auto-closing an issue. Two
 * best-effort checks:
 *
 *  (a) Cross-issue commit references — branch commit messages reference a
 *      DIFFERENT issue identifier than this issue's. Indicates the run did
 *      work that belongs to another ticket.
 *  (b) Service-boundary crossing — changed paths span service boundaries that
 *      are not on the project's declared scope-exceptions allow-list.
 *
 * Fresh worktree (no commit history vs base) → fall back to the issue-body
 * cross-reference check only. Never throws — any failure yields `valid: true`.
 */
export async function validateScopeDiffBeforeAutoClose(
  db: Db,
  input: ValidateScopeDiffInput,
): Promise<ScopeDiffValidationResult> {
  const violations: ScopeDiffViolation[] = [];

  // Resolve this issue's canonical identifier(s) — prefer the supplied one,
  // fall back to a DB lookup. Also pull the issue body for the fresh-worktree
  // cross-ref fallback.
  let ownIdentifier = input.issueIdentifier?.trim() || null;
  let issueBody: string | null = null;
  try {
    const row = await db
      .select({ identifier: issues.identifier, description: issues.description, title: issues.title })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (row) {
      if (!ownIdentifier && row.identifier) ownIdentifier = row.identifier.trim();
      issueBody = [row.title, row.description].filter(Boolean).join("\n");
    }
  } catch (err) {
    logger.debug({ err, issueId: input.issueId }, "scope-diff-validator: failed to load issue");
  }

  const ownIdentifiersUpper = new Set<string>();
  if (ownIdentifier) ownIdentifiersUpper.add(ownIdentifier.toUpperCase());

  // (a) Commit-message cross-reference check.
  const worktreeCwd = input.worktreeCwd;
  let hadBranchHistory = false;
  if (worktreeCwd && (await pathExists(worktreeCwd)) && (await isGitRepo(worktreeCwd))) {
    const messages = await loadBranchCommitMessages(worktreeCwd, input.baseRef);
    hadBranchHistory = messages.length > 0;
    const referenced = new Set<string>();
    for (const msg of messages) {
      for (const ident of extractIssueIdentifiers(msg)) {
        referenced.add(ident.toUpperCase());
      }
    }
    const foreign = [...referenced].filter((id) => !ownIdentifiersUpper.has(id));
    if (foreign.length > 0) {
      violations.push({
        kind: "cross_issue_commit_reference",
        detail:
          `Branch commit messages reference issue identifier(s) ${foreign.join(", ")} ` +
          `which differ from this issue${ownIdentifier ? ` (${ownIdentifier})` : ""}.`,
        evidence: foreign,
      });
    }
  }

  // Fresh worktree (or no worktree): fall back to the issue-body cross-ref
  // check only — does the issue body itself name other tickets that the
  // changed files might be implementing?
  if (!hadBranchHistory) {
    const bodyRefs = extractIssueIdentifiers(issueBody).filter(
      (id) => !ownIdentifiersUpper.has(id.toUpperCase()),
    );
    // Body cross-references alone are weak signal; we record them as evidence
    // but do not, by themselves, fail validation. Boundary crossing below is
    // the stronger fresh-worktree signal.
    if (bodyRefs.length > 0) {
      logger.debug(
        { issueId: input.issueId, bodyRefs },
        "scope-diff-validator: issue body references other identifiers (fresh worktree)",
      );
    }
  }

  // (b) Service-boundary crossing — only enforced when an allow-list is
  // provided (telemetry-first callers pass undefined and skip this).
  if (input.projectScopeExceptions !== undefined) {
    const allow = new Set((input.projectScopeExceptions ?? []).map((s) => s.trim()).filter(Boolean));
    const boundaries = new Map<string, string[]>();
    for (const file of input.changedFiles) {
      const boundary = serviceBoundaryForPath(file);
      if (!boundary) continue;
      const list = boundaries.get(boundary) ?? [];
      list.push(file);
      boundaries.set(boundary, list);
    }
    if (boundaries.size > 1) {
      // Multiple service boundaries touched. Everything not on the allow-list
      // is a candidate crossing. We treat the boundary with the most files as
      // the "primary" one and flag the rest unless allow-listed.
      const sorted = [...boundaries.entries()].sort((a, b) => b[1].length - a[1].length);
      const primary = sorted[0]![0];
      const crossing = sorted
        .slice(1)
        .filter(([boundary]) => !allow.has(boundary));
      if (crossing.length > 0) {
        violations.push({
          kind: "service_boundary_crossing",
          detail:
            `Changed files cross ${crossing.length} service boundary(ies) beyond the primary \`${primary}\` ` +
            `that are not on the project's scope-exceptions allow-list: ` +
            crossing.map(([b]) => `\`${b}\``).join(", ") +
            `. If cross-service work is required, it should land under its own ticket.`,
          evidence: crossing.flatMap(([, files]) => files).slice(0, 20),
        });
      }
    }
  }

  if (violations.length === 0) {
    return { valid: true };
  }
  return {
    valid: false,
    reason: violations.map((v) => v.detail).join(" "),
    violations,
  };
}
