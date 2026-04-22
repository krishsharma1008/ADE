import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

// Round 3 Phase 6 PR 6.1 — quarantine for flapping summarization keys.
//
// Codex flagged that the Phase 6 retry loop is unbounded: a bad model choice,
// parser bug, or schema drift would keep re-triggering every cooldown forever.
// This table tracks consecutive failures per (agent, scope, scopeId) and is
// stamped with `quarantined_until` after a threshold (3 failures). The
// summarizer queue consults it before enqueueing.
//
// Migration 0039 defines the unique index with COALESCE(scope_id, zero-uuid)
// since PG treats NULL as distinct by default. No unique index is declared
// here — drizzle doesn't support COALESCE expressions in its index builder.
export const summarizerFailures = pgTable("summarizer_failures", {
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  scopeKind: text("scope_kind").notNull(),
  scopeId: uuid("scope_id"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  quarantinedUntil: timestamp("quarantined_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
