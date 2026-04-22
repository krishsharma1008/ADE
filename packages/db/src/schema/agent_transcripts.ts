import { pgTable, uuid, text, timestamp, integer, bigint, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { agentTerminalSessions } from "./agent_terminal_sessions.js";

/**
 * Canonical per-agent conversation log.
 *
 * Unlike heartbeat_run_events (ops telemetry with raw stream payloads), this
 * table stores the user/assistant/tool turns in a shape we can cheaply
 * replay, summarize, or inject into a peer adapter on handoff.
 */
export const agentTranscripts = pgTable(
  "agent_transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    terminalSessionId: uuid("terminal_session_id").references(() => agentTerminalSessions.id, {
      onDelete: "set null",
    }),
    seq: integer("seq").notNull(),
    // Global monotonic cursor (populated by a PG sequence; see migration 0039).
    // `seq` resets per run/session and is kept for display; `ordinal` is the
    // durable watermark the summarizer uses. JS-side `default` is omitted —
    // the DB column has `DEFAULT nextval('agent_transcripts_ordinal_seq')`
    // which fires automatically on insert.
    ordinal: bigint("ordinal", { mode: "number" })
      .notNull()
      .default(sql`nextval('agent_transcripts_ordinal_seq')`),
    role: text("role").notNull(),
    contentKind: text("content_kind"),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentCreatedIdx: index("agent_transcripts_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    issueSeqIdx: index("agent_transcripts_issue_seq_idx").on(table.issueId, table.seq),
    runSeqIdx: index("agent_transcripts_run_seq_idx").on(table.runId, table.seq),
    terminalSessionSeqIdx: index("agent_transcripts_terminal_session_seq_idx").on(
      table.terminalSessionId,
      table.seq,
    ),
    agentOrdinalIdx: index("agent_transcripts_agent_ordinal_idx").on(
      table.agentId,
      table.ordinal,
    ),
    issueOrdinalIdx: index("agent_transcripts_issue_ordinal_idx").on(
      table.issueId,
      table.ordinal,
    ),
  }),
);
