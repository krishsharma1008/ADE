import { createHash } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { contextCaptureOutbox } from "@combyne/db";
import { logger } from "../middleware/logger.js";
import { memoryService, type CreateEntryInput } from "./memory.js";
import { resolveContextDbUrl } from "./context-db.js";
import { contextTrace } from "./context-trace.js"; // CONTEXT-TRACE

const MAX_ATTEMPTS = 12;
const DEFAULT_DRAIN_BATCH = 20;

/** Exponential backoff: 30s, 60s, 120s, … capped at 1h. */
function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(Math.max(attempts, 1) - 1, 7));
}

/** True when a SEPARATE shared context DB is configured (multi-machine rail). */
export function sharedContextActive(): boolean {
  return resolveContextDbUrl() !== "";
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Stable source key for a human Q&A capture. In SHARED mode the key is a content
 * hash so the same Q+A answered on two machines dedups to ONE shared row (the
 * local issue/comment UUIDs differ per machine and would otherwise duplicate). In
 * single-DB mode we keep the legacy local-UUID form so existing behavior + tests
 * are unchanged.
 */
export function humanAnswerSource(input: {
  companyId: string | null;
  questionText: string;
  answerText: string;
  issueId: string;
  answerCommentId: string;
}): string {
  if (!sharedContextActive()) return `human-answer:${input.issueId}:${input.answerCommentId}`;
  const hash = createHash("sha256")
    .update(`${input.companyId ?? ""}|${normalize(input.questionText)}|${normalize(input.answerText)}`)
    .digest("hex");
  return `human-answer:${hash}`;
}

/**
 * Stable source key for a PR-approval capture. In SHARED mode it uses the
 * GitHub-natural key (provider:repo#pull, or the merge SHA) that is identical on
 * every machine tracking the same PR, so N machines' captures collapse to one
 * verified row. Falls back to the local approvalId in single-DB mode (or when the
 * GitHub coordinates are unavailable).
 */
export function prApprovalSource(input: {
  approvalId: string;
  provider?: string | null;
  repo?: string | null;
  pullNumber?: number | null;
  mergeCommitSha?: string | null;
}): string {
  if (!sharedContextActive() || !input.repo || input.pullNumber == null) {
    return `pr-approval:${input.approvalId}`;
  }
  const ident = input.mergeCommitSha ? `@${input.mergeCommitSha}` : `#${input.pullNumber}`;
  return `pr-approval:${input.provider ?? "github"}:${input.repo}${ident}`;
}

/** Idempotently enqueue a failed capture into the LOCAL ops outbox for replay. */
export async function enqueueContextCapture(
  db: Db,
  input: { source: string; companyId: string | null; provenance?: string | null; payload: CreateEntryInput },
): Promise<void> {
  await db
    .insert(contextCaptureOutbox)
    .values({
      source: input.source,
      companyId: (input.companyId ?? input.payload.companyId ?? "") || "00000000-0000-0000-0000-000000000000",
      provenance: input.provenance ?? input.payload.provenance ?? null,
      payload: input.payload as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: contextCaptureOutbox.source });
}

/**
 * Create a high-value (human-answer / pr-approval) memory entry DURABLY: try the
 * write; on a context-DB failure, do NOT drop it — enqueue to the local ops outbox
 * for background replay. NEVER throws back into the caller's flow.
 */
export async function captureHumanMemoryDurable(
  db: Db,
  entry: CreateEntryInput,
): Promise<{ ok: boolean; entryId?: string }> {
  try {
    const created = await memoryService(db).createEntry(entry);
    // CONTEXT-TRACE: a high-value capture landed in the context DB.
    contextTrace("context_write", {
      provenance: entry.provenance,
      companyId: entry.companyId,
      source: entry.source,
      layer: entry.layer,
      verificationState: entry.verificationState,
      issueId: entry.sourceRefId,
      entryId: created.id,
      shared: sharedContextActive(),
    });
    return { ok: true, entryId: created.id };
  } catch (err) {
    logger.error(
      { err, source: entry.source, companyId: entry.companyId },
      "context capture failed; enqueued for replay (answer NOT lost)",
    );
    const source = entry.source ?? `capture:${entry.companyId ?? "global"}:${entry.sourceRefId ?? "unknown"}`;
    // CONTEXT-TRACE: capture failed → enqueued for replay (not lost).
    contextTrace("context_capture_enqueue", {
      provenance: entry.provenance,
      companyId: entry.companyId,
      source,
      issueId: entry.sourceRefId,
    });
    await enqueueContextCapture(db, {
      source,
      companyId: entry.companyId,
      provenance: entry.provenance ?? null,
      payload: entry,
    }).catch((e) => logger.error({ e, source }, "failed to enqueue context capture for replay"));
    return { ok: false };
  }
}

/**
 * Drain due outbox rows: replay each create-entry against the (now hopefully
 * reachable) context DB. On success delete the row; on failure bump attempts and
 * push next_attempt_at out with exponential backoff. Idempotent — the context
 * DB's (company_id, source) onConflictDoNothing means a replay that races a
 * partially-succeeded earlier write never duplicates.
 */
export async function drainContextCaptureOutbox(
  db: Db,
  opts?: { limit?: number },
): Promise<{ flushed: number; failed: number }> {
  const limit = opts?.limit ?? DEFAULT_DRAIN_BATCH;
  const due = await db
    .select()
    .from(contextCaptureOutbox)
    .where(lte(contextCaptureOutbox.nextAttemptAt, new Date()))
    .orderBy(contextCaptureOutbox.nextAttemptAt)
    .limit(limit);

  let flushed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      await memoryService(db).createEntry(row.payload as unknown as CreateEntryInput);
      await db.delete(contextCaptureOutbox).where(eq(contextCaptureOutbox.id, row.id));
      flushed += 1;
      // CONTEXT-TRACE: a previously-failed capture was replayed into the context DB.
      contextTrace("context_capture_drain", { source: row.source, provenance: row.provenance });
    } catch (err) {
      failed += 1;
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        logger.error(
          { source: row.source, attempts },
          "context capture outbox row has exhausted retries; leaving for manual inspection",
        );
      }
      await db
        .update(contextCaptureOutbox)
        .set({
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
          updatedAt: new Date(),
        })
        .where(eq(contextCaptureOutbox.id, row.id));
    }
  }
  if (flushed > 0 || failed > 0) {
    logger.info({ flushed, failed }, "context capture outbox drained");
  }
  return { flushed, failed };
}
