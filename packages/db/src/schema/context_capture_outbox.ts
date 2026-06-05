import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Local-ops durable outbox for high-value context captures (HOOK 1 human-answer,
 * HOOK 2 PR-approval). The SHARED context DB is REMOTE (Cloud SQL) and may be
 * transiently unreachable; a capture failure must NOT silently drop an
 * irreplaceable human-sourced memory (invariant I4). So on failure we enqueue the
 * full create-entry payload here — in the ALWAYS-reachable LOCAL ops DB — and a
 * background drainer replays it (idempotent via the context DB's (company_id,
 * source) onConflictDoNothing).
 *
 * This table lives in the OPS DB and is NEVER routed through resolveContextDb.
 */
export const contextCaptureOutbox = pgTable(
  "context_capture_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The stable (company_id, source) natural key of the memory entry to (re)create.
    // UNIQUE so enqueue is idempotent: a re-fire can't pile up duplicate outbox rows.
    source: text("source").notNull().unique(),
    companyId: uuid("company_id").notNull(),
    provenance: text("provenance"),
    // Full CreateEntryInput (JSON-safe) so the drainer can replay the exact write.
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dueIdx: index("context_capture_outbox_due_idx").on(table.nextAttemptAt),
  }),
);
