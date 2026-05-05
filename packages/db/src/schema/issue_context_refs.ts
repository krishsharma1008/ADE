import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";
import { agents } from "./agents.js";

export const issueContextRefs = pgTable(
  "issue_context_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sourceCommentId: uuid("source_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    kind: text("kind").notNull(),
    label: text("label"),
    rawRef: text("raw_ref").notNull(),
    resolvedRef: text("resolved_ref"),
    accessibilityStatus: text("accessibility_status").notNull().default("unknown"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_context_refs_company_issue_idx").on(table.companyId, table.issueId),
    companyIssueRawUq: uniqueIndex("issue_context_refs_company_issue_raw_uq").on(
      table.companyId,
      table.issueId,
      table.rawRef,
    ),
  }),
);
