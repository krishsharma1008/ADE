// INFRA_FIXES_PLAN Phase F — Multi-modal Q&A answer-attachment extraction.
//
// When a human answers a Q&A question with a PDF or image attachment, HOOK 1
// (routes/issues.ts + agent-question-routing.ts) captures only the TEXT answer
// inline and enqueues ONE attachment_extraction_jobs row per supported
// attachment (so the answer route stays fast — no model call inline). This module
// owns the OUT-OF-BAND side:
//
//   - The INJECTABLE extractor seam ({ extractPdf, describeImage }) — mirrors the
//     summarizer driver-injection seam (summarizer-driver-anthropic.ts) and the
//     embedder driver seam (memory-embedder.ts). A real Anthropic vision/document
//     driver is built from ANTHROPIC_API_KEY; with no key we fall back to a
//     DISABLED driver that skips gracefully (no model call, never throws).
//   - drainAttachmentExtractionJobs(db): the best-effort processor the heartbeat
//     scheduler tick calls next to drainContextCaptureOutbox. For each DUE job it
//     fetches the object bytes from storage, runs the extractor, runs scanBody
//     redact-before-embed, then captures a TRUSTED memory entry via the
//     memory-capture helper (PDF transcription → human-answer/verified; image
//     description → verified-summary/verified). On success the job is deleted; on
//     failure attempts are bumped with exponential backoff (the
//     context_capture_outbox pattern). Everything is wrapped in try/catch so a
//     model/storage hiccup never breaks the answer flow or the heartbeat loop.

import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { attachmentExtractionJobs } from "@combyne/db";
import type { Readable } from "node:stream";
import { logger } from "../middleware/logger.js";
import { scanBody } from "../secret-scan.js";
import { assetService } from "./assets.js";
import type { StorageService } from "../storage/types.js";
import { captureAttachmentMemoryDurable, isPinnedForContext } from "./memory-capture.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_VISION_MODEL = "claude-3-5-sonnet-latest";

const MAX_ATTEMPTS = 12;
const DEFAULT_DRAIN_BATCH = 10;

// PREFLIGHT SIZE CAPS (F5). Anthropic caps the base64 source — images ~5MB, PDF
// docs ~32MB — and base64 is ~1.34x the raw bytes, so we cap on RAW byteSize well
// under the API ceiling to leave JSON headroom: image ~3.7MB, pdf ~24MB. An input
// over the cap is a TERMINAL skip (deterministic on content; a retry can never
// succeed) so an at-cap attachment can never 413 into the retry loop. Overridable
// for tests/ops via env.
const MAX_IMAGE_INPUT_BYTES = Number(process.env.COMBYNE_EXTRACT_MAX_IMAGE_BYTES) || 3_500_000;
const MAX_PDF_INPUT_BYTES = Number(process.env.COMBYNE_EXTRACT_MAX_PDF_BYTES) || 24_000_000;

/** Exponential backoff: 30s, 60s, 120s, … capped at 1h (matches the outbox). */
function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(Math.max(attempts, 1) - 1, 7));
}

/** Supported attachment content types for extraction (gate at enqueue + drain). */
export const EXTRACTABLE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export function isExtractableContentType(contentType: string | null | undefined): boolean {
  return EXTRACTABLE_CONTENT_TYPES.has((contentType ?? "").toLowerCase());
}

export function isPdfContentType(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase() === "application/pdf";
}

/**
 * The injectable extractor seam. A real driver routes both calls through Claude's
 * vision/document content blocks; the disabled driver returns null so the drainer
 * skips gracefully when no key is configured. Tests inject a fake for determinism.
 */
export interface AttachmentExtractor {
  /** Whether a real model will be called. false → drainer leaves the job pending. */
  readonly enabled: boolean;
  /** Transcribe a PDF's text. Returns the extracted text, or null to skip. */
  extractPdf(bytes: Buffer): Promise<string | null>;
  /** Describe/OCR an image. Returns a description, or null to skip. */
  describeImage(bytes: Buffer, mimeType: string): Promise<string | null>;
}

/** The disabled (no-key) extractor: never calls a model, never throws, skips. */
export const disabledAttachmentExtractor: AttachmentExtractor = {
  enabled: false,
  async extractPdf() {
    return null;
  },
  async describeImage() {
    return null;
  },
};

export interface AnthropicExtractorOptions {
  apiKey?: string | null;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

function resolveApiKey(explicit?: string | null): string | null {
  const candidates = [explicit, process.env.ANTHROPIC_API_KEY];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

// Extract plain text from Anthropic's content-blocks response (same shape the
// summarizer driver consumes).
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

const PDF_SYSTEM_PROMPT =
  "You transcribe the FULL text content of a PDF document verbatim. Return ONLY the " +
  "document's text — no preamble, no commentary, no markdown fences. Preserve the " +
  "reading order. If the document is empty, return an empty string.";

const IMAGE_SYSTEM_PROMPT =
  "You describe and OCR an image so its content is searchable. Return ONLY a concise " +
  "factual description plus any legible text you can read from the image — no preamble, " +
  "no commentary, no markdown fences.";

/**
 * Real Anthropic driver: routes PDFs through the `document` content block and
 * images through the `image` content block (base64), via the same Messages API
 * the summarizer driver uses. Built only when an ANTHROPIC_API_KEY is present.
 */
export function makeAnthropicAttachmentExtractor(
  options: AnthropicExtractorOptions = {},
): AttachmentExtractor {
  const endpoint = options.endpoint ?? ANTHROPIC_MESSAGES_URL;
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxTokens = options.maxTokens ?? 4096;

  async function call(systemPrompt: string, contentBlock: unknown, instruction: string): Promise<string | null> {
    const apiKey = resolveApiKey(options.apiKey);
    if (!apiKey) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: [contentBlock, { type: "text", text: instruction }],
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`anthropic_attachment_fetch_failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`anthropic_attachment_http_${response.status}: ${body.slice(0, 500)}`);
    }

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`anthropic_attachment_json_parse_failed: ${(err as Error).message}`);
    }
    return extractText(json.content);
  }

  return {
    enabled: resolveApiKey(options.apiKey) !== null,
    async extractPdf(bytes: Buffer): Promise<string | null> {
      const block = {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
      };
      return call(PDF_SYSTEM_PROMPT, block, "Transcribe the full text of this document.");
    },
    async describeImage(bytes: Buffer, mimeType: string): Promise<string | null> {
      // Anthropic's image block accepts png/jpeg/webp/gif; jpg is an alias for jpeg.
      const mt = mimeType.toLowerCase() === "image/jpg" ? "image/jpeg" : mimeType.toLowerCase();
      const block = {
        type: "image",
        source: { type: "base64", media_type: mt, data: bytes.toString("base64") },
      };
      return call(IMAGE_SYSTEM_PROMPT, block, "Describe and transcribe this image.");
    },
  };
}

/**
 * Build the default extractor from the environment: a real Anthropic driver when
 * ANTHROPIC_API_KEY is set, otherwise the DISABLED driver (skips gracefully).
 */
export function makeDefaultAttachmentExtractor(): AttachmentExtractor {
  if (resolveApiKey() === null) return disabledAttachmentExtractor;
  return makeAnthropicAttachmentExtractor();
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

export interface DrainAttachmentJobsDeps {
  storage: StorageService;
  extractor?: AttachmentExtractor;
  limit?: number;
}

export interface DrainAttachmentJobsResult {
  processed: number;
  captured: number;
  skipped: number;
  failed: number;
}

/**
 * Drain due attachment-extraction jobs. For each job: fetch bytes from storage,
 * run the injected extractor, redact-before-embed (scanBody), capture a trusted
 * memory entry (idempotent on a stable source key → drain-twice is a no-op), and
 * DELETE the job. A disabled extractor or empty extraction leaves the job pending
 * (no capture, no attempt bump). A thrown extractor/storage error bumps attempts +
 * backoff so the TEXT answer (already captured by HOOK 1) is never the casualty.
 *
 * Best-effort: NEVER throws — a failure here must not break the heartbeat loop.
 */
export async function drainAttachmentExtractionJobs(
  db: Db,
  deps: DrainAttachmentJobsDeps,
): Promise<DrainAttachmentJobsResult> {
  const extractor = deps.extractor ?? makeDefaultAttachmentExtractor();
  const limit = deps.limit ?? DEFAULT_DRAIN_BATCH;
  const result: DrainAttachmentJobsResult = { processed: 0, captured: 0, skipped: 0, failed: 0 };

  let due: (typeof attachmentExtractionJobs.$inferSelect)[];
  try {
    // Compare against the DB clock (now()) rather than the Node clock: a freshly
    // enqueued row stamps next_attempt_at = now() on the SERVER, and any skew
    // between the server clock and this process's Date.now() would otherwise make a
    // just-enqueued job look "not yet due" and silently stall it for a tick.
    due = await db
      .select()
      .from(attachmentExtractionJobs)
      .where(
        and(
          // Only 'pending' rows are due. A row driven to 'failed' (retries
          // exhausted, oversized, or otherwise terminal) is parked out of the
          // queue so it is never re-selected, re-fetched, or re-charged (F1/MIG-3).
          eq(attachmentExtractionJobs.status, "pending"),
          lte(attachmentExtractionJobs.nextAttemptAt, sql`now()`),
        ),
      )
      .orderBy(attachmentExtractionJobs.nextAttemptAt)
      .limit(limit);
  } catch (err) {
    logger.error({ err }, "attachment extraction job query failed");
    return result;
  }

  // Skip the model entirely when the extractor is disabled (no key): leave the
  // jobs pending so a later, key-configured boot can process them. The text
  // answer is already captured by HOOK 1, so nothing is lost in the meantime.
  if (!extractor.enabled) {
    if (due.length > 0) {
      logger.debug({ due: due.length }, "attachment extractor disabled; leaving jobs pending");
    }
    result.skipped = due.length;
    return result;
  }

  const assets = assetService(db);

  for (const job of due) {
    result.processed += 1;
    try {
      // PIN FENCE (Cond 1): a job enqueued by an older (un-guarded) answer route — or
      // before a pin was set — may address a foreign tenant. The shared rail is
      // single-tenant under a pin, so this job can never legitimately capture here:
      // drop it (terminal) rather than spend a model call + write off-tenant. No-op in
      // the default local-first posture (single-DB / no pin), so zero behavior change.
      if (!isPinnedForContext(job.companyId)) {
        logger.warn(
          { assetId: job.assetId, jobCompanyId: job.companyId },
          "attachment job dropped: off-tenant for the pinned context rail",
        );
        await db.delete(attachmentExtractionJobs).where(eq(attachmentExtractionJobs.id, job.id));
        result.skipped += 1;
        continue;
      }

      const asset = await assets.getById(job.assetId);
      if (!asset) {
        // The asset is gone (attachment deleted): the job can never succeed — drop it.
        await db.delete(attachmentExtractionJobs).where(eq(attachmentExtractionJobs.id, job.id));
        result.skipped += 1;
        continue;
      }

      // PREFLIGHT SIZE GATE (F5): gate on asset.byteSize BEFORE streaming the object
      // into RAM or calling the model. An oversized input is deterministic on content
      // (it would 413 every time), so abandon it (terminal) rather than loop.
      const isPdf = isPdfContentType(job.contentType);
      const sizeCap = isPdf ? MAX_PDF_INPUT_BYTES : MAX_IMAGE_INPUT_BYTES;
      if (typeof asset.byteSize === "number" && asset.byteSize > sizeCap) {
        logger.warn(
          { assetId: job.assetId, byteSize: asset.byteSize, cap: sizeCap },
          "attachment too large to extract; abandoning job (would exceed model input limit)",
        );
        await db.delete(attachmentExtractionJobs).where(eq(attachmentExtractionJobs.id, job.id));
        result.skipped += 1;
        continue;
      }

      const object = await deps.storage.getObject(asset.companyId, asset.objectKey);
      const bytes = await streamToBuffer(object.stream);

      const extracted = isPdf
        ? await extractor.extractPdf(bytes)
        : await extractor.describeImage(bytes, job.contentType);

      const text = (extracted ?? "").trim();
      if (!text) {
        // An ENABLED driver returned empty (the disabled/no-key driver returns at the
        // !extractor.enabled short-circuit above and never reaches here). Do NOT
        // re-fetch bytes + re-call the paid model every tick: bump attempts + backoff,
        // and after MAX_ATTEMPTS abandon the job so an always-empty attachment stops
        // the per-tick storage-read + model-spend loop (F2).
        const attempts = job.attempts + 1;
        result.skipped += 1;
        if (attempts >= MAX_ATTEMPTS) {
          logger.warn(
            { assetId: job.assetId, attempts },
            "attachment extraction empty after max attempts; abandoning job",
          );
          await db
            .delete(attachmentExtractionJobs)
            .where(eq(attachmentExtractionJobs.id, job.id))
            .catch((e) => logger.error({ e, assetId: job.assetId }, "failed to abandon empty attachment job"));
          continue;
        }
        await db
          .update(attachmentExtractionJobs)
          .set({
            attempts,
            status: "pending",
            lastError: "empty_extraction",
            nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
            updatedAt: new Date(),
          })
          .where(eq(attachmentExtractionJobs.id, job.id))
          .catch((e) => logger.error({ e, assetId: job.assetId }, "failed to bump empty attachment job attempts"));
        continue;
      }

      const questionText = job.questionText.trim() || "(question unavailable)";
      const subject = questionText.slice(0, 480);
      const verb = isPdf ? "Attached document" : "Attached image";

      // REDACT-BEFORE-CAPTURE (F4): scan the WHOLE composed body — the typed answer
      // (which, on the upload-route enqueue, is the UNREDACTED comment body) AND the
      // extracted attachment content — so a secret in EITHER part is redacted at rest
      // regardless of enqueue path and regardless of whether a real embedder runs the
      // redact-before-embed pass (it is skipped on the hash-64 fallback). Matches
      // HOOK 1's at-rest guarantee.
      const composed = `Q: ${questionText}\nA: ${job.answerText.trim()}\n\n${verb} content:\n${text}`;
      const scan = scanBody(composed);
      // A finding ANYWHERE in the composed body force-quarantines to needs_review
      // (overriding the verified posture) so a secret-bearing source never lands in
      // the highest-trust retrievable tier — even though the stored body is redacted.
      const verificationState: "needs_review" | "verified" =
        scan.findings.length > 0 ? "needs_review" : "verified";

      const capture = await captureAttachmentMemoryDurable(db, {
        companyId: job.companyId,
        layer: "workspace",
        kind: "fact",
        subject,
        body: scan.clean,
        // Stable source key (asset id) → re-runs dedup via the context DB's
        // (company_id, source) onConflictDoNothing. A second drain is a no-op.
        source: `attachment-extract:${job.assetId}`,
        // Trust posture (Phase F decision): a PDF is a faithful transcription of a
        // human-supplied source → human-answer/verified. An image DESCRIPTION is a
        // machine summary of a human-supplied source → verified-summary/verified.
        provenance: isPdf ? "human-answer" : "verified-summary",
        verificationState,
        confidence: isPdf ? 0.9 : 0.8,
        // authorType 'user' represents the human Q&A channel (the human provided
        // the source); the trust tier is governed solely by the explicit
        // provenance + verificationState above, NOT by treating this as "typed".
        authorType: "user",
        sourceRefType: "attachment",
        sourceRefId: job.assetId,
      });

      // DURABLE-DELETE GATE (P2): delete the job ONLY when the memory is durable or
      // intentionally terminal:
      //   - capture.ok        → WRITTEN to the context DB.
      //   - capture.skipped   → off-tenant pin skip (terminal; the pre-check above
      //                          normally handles this, but be defensive).
      //   - capture.queued    → context-DB write failed but the FULL payload was
      //                          durably enqueued to the local ops outbox, which
      //                          drainContextCaptureOutbox will replay.
      // If the write failed AND the outbox enqueue ALSO failed (capture.ok === false,
      // !skipped, !queued — a double fault on the ops DB), the capture is NOT durable:
      // do NOT delete. Throw into the catch so attempts are bumped + backed off (and
      // the job becomes terminal only at MAX_ATTEMPTS) — never a silent loss.
      if (capture.ok) {
        await db.delete(attachmentExtractionJobs).where(eq(attachmentExtractionJobs.id, job.id));
        result.captured += 1;
      } else if (capture.skipped || capture.queued) {
        await db.delete(attachmentExtractionJobs).where(eq(attachmentExtractionJobs.id, job.id));
        result.skipped += 1; // terminal skip, or durably queued (not yet in the context DB)
      } else {
        throw new Error("attachment capture failed and could not be durably queued");
      }
    } catch (err) {
      result.failed += 1;
      const attempts = job.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      if (exhausted) {
        logger.error(
          { assetId: job.assetId, attempts },
          "attachment extraction job exhausted retries; marking failed for manual inspection",
        );
      }
      await db
        .update(attachmentExtractionJobs)
        .set({
          attempts,
          // TERMINAL at the ceiling (F1/MIG-3): stamp 'failed' (operator-visible,
          // status != 'pending') and park next_attempt_at ~100y out so the combined
          // status + time drain filter can never re-select it. Below the ceiling it
          // stays 'pending' on the backoff schedule.
          status: exhausted ? "failed" : "pending",
          lastError: err instanceof Error ? err.message : String(err),
          nextAttemptAt: exhausted
            ? new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000)
            : new Date(Date.now() + backoffMs(attempts)),
          updatedAt: new Date(),
        })
        .where(eq(attachmentExtractionJobs.id, job.id))
        .catch((e) => logger.error({ e, assetId: job.assetId }, "failed to bump attachment job attempts"));
    }
  }

  if (result.captured > 0 || result.failed > 0) {
    logger.info({ ...result }, "attachment extraction jobs drained");
  }
  return result;
}
