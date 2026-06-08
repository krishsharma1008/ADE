import { createHash } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { contextCaptureOutbox, attachmentExtractionJobs } from "@combyne/db";
import { logger } from "../middleware/logger.js";
import { loadConfig } from "../config.js";
import { memoryService, type CreateEntryInput } from "./memory.js";
import { resolveContextDbUrl } from "./context-db.js";
import { contextTrace } from "./context-trace.js"; // CONTEXT-TRACE

const MAX_ATTEMPTS = 12;
const DEFAULT_DRAIN_BATCH = 20;

/**
 * Canonical SERVICE-level company-pin predicate (Cond 1). Returns `true` when the
 * companyId is allowed to write/replay onto the shared context rail: single-DB
 * mode, no pin set, a global (null) row, or the companyId equals the pin. Returns
 * `false` ONLY when a SEPARATE context rail is wired, a pin is set, and the row is
 * a DIFFERENT tenant. This is the non-throwing twin used by the capture chokepoint,
 * the outbox replay, and the attachment drainer so an off-tenant write is SKIPPED
 * (never written, never enqueued, never replayed) instead of throwing into a
 * best-effort background tick. routes/authz.ts has a throwing mirror
 * (`assertPinnedCompany`) for the request-actor paths; kept in sync deliberately.
 */
export function isPinnedForContext(companyId: string | null | undefined): boolean {
  if (companyId === null) return true; // global rows are tenant-agnostic
  const cfg = loadConfig();
  if (resolveContextDbUrl() && cfg.contextCompanyId && companyId !== cfg.contextCompanyId) {
    return false;
  }
  return true;
}

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
): Promise<{ ok: boolean; entryId?: string; skipped?: boolean; queued?: boolean }> {
  // PIN FENCE (Cond 1): this is the single chokepoint EVERY high-value capture
  // funnels through — HOOK 1 human-answer, the manager-answer mirror, HOOK 2
  // PR-approval, and the attachment drainer (via captureAttachmentMemoryDurable).
  // Reject an off-tenant write BEFORE the create AND before the outbox enqueue, so
  // a mistyped/foreign companyId can never land on the shared rail and can never
  // get stuck replaying from the outbox forever. No-op in the default local-first
  // posture (single-DB or no pin), so zero behavior change there.
  if (!isPinnedForContext(entry.companyId)) {
    logger.warn(
      { source: entry.source, companyId: entry.companyId, provenance: entry.provenance },
      "context capture skipped: companyId is off-tenant for the pinned context rail",
    );
    return { ok: false, skipped: true };
  }
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
    // Report whether the replay enqueue actually SUCCEEDED. A caller that deletes its
    // source job on a failed write relies on durability — if the outbox enqueue ALSO
    // failed (double fault on the ops DB) the capture is NOT durable and the job must
    // be retried, not dropped (P1: durable-delete gate in the attachment drainer).
    let queued = false;
    try {
      await enqueueContextCapture(db, {
        source,
        companyId: entry.companyId,
        provenance: entry.provenance ?? null,
        payload: entry,
      });
      queued = true;
    } catch (e) {
      logger.error({ e, source }, "failed to enqueue context capture for replay");
    }
    return { ok: false, queued };
  }
}

/**
 * Trusted attachment-capture helper (INFRA_FIXES_PLAN Phase F). The attachment
 * extraction drainer (attachment-extract.ts) has already (a) run the model, (b)
 * run scanBody redact-before-embed, and (c) chosen the trust posture (human-answer
 * for a faithful PDF transcription, verified-summary for an image description), so
 * this is a thin durable wrapper around captureHumanMemoryDurable: it persists the
 * extracted content as a high-value memory entry and, on a context-DB outage,
 * enqueues to the SAME local ops outbox for replay rather than dropping it. The
 * stable (company_id, source) key makes a re-drain idempotent. NEVER throws back
 * into the drainer (which is itself best-effort on the heartbeat tick).
 */
export async function captureAttachmentMemoryDurable(
  db: Db,
  entry: CreateEntryInput,
): Promise<{ ok: boolean; entryId?: string; skipped?: boolean; queued?: boolean }> {
  return captureHumanMemoryDurable(db, entry);
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
    const payload = row.payload as unknown as CreateEntryInput;
    // PIN FENCE (Cond 1): a row enqueued by an older, un-guarded build (or before a
    // pin was set) may address a foreign tenant. Drop it rather than replay it onto
    // the shared rail — and rather than leave it cycling the queue forever. The
    // live capture path is now fenced at captureHumanMemoryDurable, so new
    // off-tenant rows never reach the outbox; this only cleans up legacy rows. Check
    // the PAYLOAD companyId (what createEntry actually writes) — the denormalized
    // row.companyId zero-uuid sentinel for global rows would otherwise be misread.
    if (!isPinnedForContext(payload.companyId)) {
      logger.warn(
        { source: row.source, companyId: payload.companyId },
        "context capture outbox row dropped: off-tenant for the pinned context rail",
      );
      await db.delete(contextCaptureOutbox).where(eq(contextCaptureOutbox.id, row.id));
      continue;
    }
    try {
      await memoryService(db).createEntry(payload);
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

/**
 * Supported attachment content types for Phase F extraction. Kept LOCAL to this
 * module (rather than imported from attachment-extract.ts) so the answer-route
 * enqueue path does not pull in the model driver, and to avoid an import cycle
 * (attachment-extract.ts imports captureAttachmentMemoryDurable from here).
 */
const EXTRACTABLE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export interface AnswerAttachment {
  assetId: string;
  contentType: string;
  issueCommentId?: string | null;
}

/**
 * Enqueue ONE attachment_extraction_jobs row per SUPPORTED attachment on the answer
 * comment (INFRA_FIXES_PLAN Phase F). Called at answer time AFTER the HOOK 1 text
 * capture, on BOTH the answer-question route and the internal-manager-answer path.
 * Keeps the answer response fast: the (slow, costly) Claude vision/document pass
 * runs out-of-band on the heartbeat tick via drainAttachmentExtractionJobs.
 *
 * Idempotent: the asset_id UNIQUE constraint + onConflictDoNothing means a re-fire
 * of the answer route never piles up duplicate jobs. Best-effort: NEVER throws back
 * into the answer flow — a failed enqueue is logged, and the text answer is already
 * durably captured by HOOK 1 regardless.
 */
export async function enqueueAttachmentExtractionJobs(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    answerCommentId: string;
    questionText: string;
    answerText: string;
    attachments: AnswerAttachment[];
  },
): Promise<{ enqueued: number }> {
  // Only attachments hanging off THIS answer comment, of a supported type.
  const supported = input.attachments.filter(
    (a) =>
      a.assetId &&
      EXTRACTABLE_ATTACHMENT_TYPES.has((a.contentType ?? "").toLowerCase()) &&
      (a.issueCommentId == null || a.issueCommentId === input.answerCommentId),
  );
  if (supported.length === 0) return { enqueued: 0 };

  let enqueued = 0;
  for (const att of supported) {
    try {
      const rows = await db
        .insert(attachmentExtractionJobs)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          answerCommentId: input.answerCommentId,
          assetId: att.assetId,
          questionText: input.questionText,
          answerText: input.answerText,
          contentType: (att.contentType ?? "").toLowerCase(),
          status: "pending",
        })
        .onConflictDoNothing({ target: attachmentExtractionJobs.assetId })
        .returning({ id: attachmentExtractionJobs.id });
      if (rows.length > 0) enqueued += 1;
    } catch (err) {
      logger.error(
        { err, assetId: att.assetId, issueId: input.issueId },
        "failed to enqueue attachment extraction job (text answer already captured)",
      );
    }
  }
  return { enqueued };
}
