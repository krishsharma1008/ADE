import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Local-ops durable queue for multi-modal Q&A answer-attachment extraction
 * (INFRA_FIXES_PLAN Phase F). When a human answers a Q&A question with a PDF or
 * image attachment, HOOK 1 captures only the TEXT answer inline. The attachment's
 * CONTENT (PDF transcription / image description) must also reach the central DB,
 * but running the (slow, costly) Claude vision/document pass inline would block the
 * answer response — so at answer time we enqueue ONE row per supported attachment
 * here and a best-effort heartbeat-tick drainer
 * (drainAttachmentExtractionJobs) does the model call + capture out of band.
 *
 * Mirrors the context_capture_outbox reliability pattern: a UNIQUE natural key
 * (asset id) makes enqueue idempotent, attempts/last_error/next_attempt_at drive
 * exponential backoff, and the row is deleted on success. This table lives in the
 * ALWAYS-reachable LOCAL ops DB and is NEVER routed through resolveContextDb; the
 * extracted memory itself lands in the (possibly remote) context DB via the same
 * idempotent (company_id, source) capture seam HOOK 1 uses.
 */
export const attachmentExtractionJobs = pgTable(
  "attachment_extraction_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    // The answer comment the attachment hangs off (HOOK 1 stamps its memory row
    // sourceRefId = this comment; the extraction row references it for lineage).
    answerCommentId: uuid("answer_comment_id").notNull(),
    // The stored object to fetch + extract. UNIQUE so a re-fire of the answer
    // route (or a routing-path re-enqueue) can't pile up duplicate jobs for the
    // same attachment — onConflictDoNothing on this column is the idempotency gate.
    assetId: uuid("asset_id").notNull().unique(),
    // The original question text + the human answer text — carried on the row so
    // the drainer can build the captured memory's subject/body without re-loading
    // (and without coupling the local ops queue to the issue/comment tables).
    questionText: text("question_text").notNull(),
    answerText: text("answer_text").notNull(),
    contentType: text("content_type").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dueIdx: index("attachment_extraction_jobs_due_idx").on(table.nextAttemptAt),
  }),
);
