import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// Round 3 Item #6 (context budget). Each row is the durable cutoff watermark
// for transcript pruning: raw entries with seq <= cutoff_seq are considered
// summarized. Unique index on (agent_id, scope_kind, scope_id, cutoff_seq)
// prevents duplicate writes under concurrent summarization triggers.
export const transcriptSummaries = pgTable(
  "transcript_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    scopeKind: text("scope_kind").notNull(),
    scopeId: uuid("scope_id"),
    cutoffSeq: bigint("cutoff_seq", { mode: "number" }).notNull(),
    content: text("content").notNull(),
    structuredJson: jsonb("structured_json").$type<Record<string, unknown>>(),
    sourceInputTokens: integer("source_input_tokens"),
    sourceTurnCount: integer("source_turn_count"),
    summarizerModel: text("summarizer_model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("transcript_summaries_lookup_idx").on(
      table.agentId,
      table.scopeKind,
      table.scopeId,
      table.cutoffSeq,
    ),
  }),
);
