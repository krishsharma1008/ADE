import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

export const issuePlans = pgTable(
  "issue_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    content: text("content").notNull(),
    status: text("status").notNull().default("draft"),
    approvalId: uuid("approval_id").references(() => approvals.id),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_plans_issue_idx").on(table.issueId),
    companyStatusIdx: index("issue_plans_company_status_idx").on(table.companyId, table.status),
  }),
);
