import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

export const issuePullRequests = pgTable(
  "issue_pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    provider: text("provider").notNull().default("github"),
    repo: text("repo").notNull(),
    pullNumber: integer("pull_number").notNull(),
    pullUrl: text("pull_url").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull().default("open"),
    baseBranch: text("base_branch").notNull(),
    headBranch: text("head_branch"),
    headSha: text("head_sha"),
    expectedHeadSha: text("expected_head_sha"),
    mergeCommitSha: text("merge_commit_sha"),
    mergeMethod: text("merge_method").notNull().default("squash"),
    ciStatus: text("ci_status").notNull().default("unknown"),
    reviewStatus: text("review_status").notNull().default("unknown"),
    qualityStatus: text("quality_status").notNull().default("not_configured"),
    mergeStatus: text("merge_status").notNull().default("pending"),
    feedbackStatus: text("feedback_status").notNull().default("idle"),
    lastFeedbackHash: text("last_feedback_hash"),
    lastFeedbackAt: timestamp("last_feedback_at", { withTimezone: true }),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_pull_requests_company_issue_idx").on(table.companyId, table.issueId),
    companyStatusIdx: index("issue_pull_requests_company_merge_status_idx").on(table.companyId, table.mergeStatus),
    uniquePrIdx: uniqueIndex("issue_pull_requests_unique_pr_idx").on(
      table.companyId,
      table.provider,
      table.repo,
      table.pullNumber,
    ),
  }),
);
