import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

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
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_memory_company_agent_idx").on(table.companyId, table.agentId),
    companyIssueIdx: index("agent_memory_company_issue_idx").on(table.companyId, table.issueId),
    scopeKindIdx: index("agent_memory_scope_kind_idx").on(table.scope, table.kind),
  }),
);
