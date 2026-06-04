import { pgTable, uuid, text, timestamp, index, real } from "drizzle-orm/pg-core";

/**
 * Durable agent memory: rolling summaries, facts, preferences, and artifact
 * pointers. Scope is one of agent/company/issue. The summarizer writes
 * kind='summary' rows at the end of each run; agents themselves can emit
 * kind='fact' / 'preference' / 'artifact_ref' entries to persist decisions.
 */
export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Logical references into the MAIN DB (companies/agents/issues/heartbeat_runs).
    // Cross-entity FKs dropped in 0053 so agent_memory can live in a separate
    // context DB; the columns keep their values but are not enforced.
    companyId: uuid("company_id").notNull(),
    agentId: uuid("agent_id"),
    issueId: uuid("issue_id"),
    sourceRunId: uuid("source_run_id"),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    // Trust spine subset (migration 0049) so the legacy "# Recent memory"
    // channel is governable with the same vocabulary as memory_entries.
    provenance: text("provenance"),
    authorType: text("author_type"),
    confidence: real("confidence").notNull().default(0.5),
    verificationState: text("verification_state").notNull().default("unverified"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_memory_company_agent_idx").on(table.companyId, table.agentId),
    companyIssueIdx: index("agent_memory_company_issue_idx").on(table.companyId, table.issueId),
    scopeKindIdx: index("agent_memory_scope_kind_idx").on(table.scope, table.kind),
  }),
);
