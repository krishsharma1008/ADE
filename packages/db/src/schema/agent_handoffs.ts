import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * A handoff brief generated when an issue's assignee changes (or a parent
 * agent explicitly delegates a sub-issue). The receiving adapter reads the
 * brief and injects it as the first user turn, preserving chain-of-thought
 * across adapter boundaries (Claude → Codex, etc).
 */
export const agentHandoffs = pgTable(
  "agent_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    fromAgentId: uuid("from_agent_id").references(() => agents.id, { onDelete: "set null" }),
    toAgentId: uuid("to_agent_id")
      .notNull()
      .references(() => agents.id),
    fromRunId: uuid("from_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    brief: text("brief").notNull(),
    openQuestions: jsonb("open_questions").$type<string[]>(),
    artifactRefs: jsonb("artifact_refs").$type<Record<string, unknown>[]>(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("agent_handoffs_company_issue_idx").on(table.companyId, table.issueId),
    toAgentPendingIdx: index("agent_handoffs_to_agent_pending_idx").on(
      table.toAgentId,
      table.consumedAt,
    ),
  }),
);
