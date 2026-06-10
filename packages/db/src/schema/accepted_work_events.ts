import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const acceptedWorkEvents = pgTable(
  "accepted_work_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    repo: text("repo").notNull(),
    pullNumber: integer("pull_number").notNull(),
    pullUrl: text("pull_url"),
    title: text("title").notNull(),
    body: text("body"),
    headBranch: text("head_branch"),
    mergedSha: text("merged_sha"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    detectionSource: text("detection_source").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    contributorAgentId: uuid("contributor_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    managerAgentId: uuid("manager_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    wakeupRequestedAt: timestamp("wakeup_requested_at", { withTimezone: true }),
    memoryStatus: text("memory_status").notNull().default("pending"),
    // Logical reference only (no FK since 0062): the captured entry can live on
    // the separate central context DB, where a cross-database FK is impossible.
    memoryEntryId: uuid("memory_entry_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("accepted_work_events_company_status_idx").on(
      table.companyId,
      table.memoryStatus,
    ),
    managerStatusIdx: index("accepted_work_events_manager_status_idx").on(
      table.companyId,
      table.managerAgentId,
      table.memoryStatus,
    ),
    issueIdx: index("accepted_work_events_issue_idx").on(table.companyId, table.issueId),
    providerPrUq: uniqueIndex("accepted_work_events_provider_pr_uq").on(
      table.companyId,
      table.provider,
      table.repo,
      table.pullNumber,
    ),
  }),
);
