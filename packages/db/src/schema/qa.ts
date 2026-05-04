import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const qaTestCases = pgTable(
  "qa_test_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    steps: jsonb("steps").$type<string[]>().notNull().default([]),
    expectedResult: text("expected_result").notNull(),
    platform: text("platform").notNull().default("api"),
    priority: text("priority").notNull().default("medium"),
    service: text("service"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPlatformIdx: index("qa_test_cases_company_platform_idx").on(table.companyId, table.platform),
    companyServiceIdx: index("qa_test_cases_company_service_idx").on(table.companyId, table.service),
    companyUpdatedIdx: index("qa_test_cases_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);

export const qaTestSuites = pgTable(
  "qa_test_suites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    platform: text("platform").notNull().default("api"),
    runnerType: text("runner_type").notNull().default("custom_command"),
    service: text("service"),
    caseIds: jsonb("case_ids").$type<string[]>().notNull().default([]),
    commandProfile: jsonb("command_profile").$type<Record<string, unknown>>().notNull().default({}),
    parserType: text("parser_type").notNull().default("none"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUq: uniqueIndex("qa_test_suites_company_name_uq").on(table.companyId, table.name),
    companyRunnerIdx: index("qa_test_suites_company_runner_idx").on(table.companyId, table.runnerType),
    companyUpdatedIdx: index("qa_test_suites_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);

export const qaEnvironments = pgTable(
  "qa_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("api"),
    baseUrl: text("base_url"),
    variables: jsonb("variables").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKindIdx: index("qa_environments_company_kind_idx").on(table.companyId, table.kind),
    companyNameUq: uniqueIndex("qa_environments_company_name_uq").on(table.companyId, table.name),
  }),
);

export const qaDevices = pgTable(
  "qa_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    workerId: text("worker_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("android_emulator"),
    platform: text("platform").notNull().default("android"),
    osVersion: text("os_version"),
    apiLevel: text("api_level"),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    healthStatus: text("health_status").notNull().default("unknown"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkerNameUq: uniqueIndex("qa_devices_company_worker_name_uq").on(
      table.companyId,
      table.workerId,
      table.name,
    ),
    companyHealthIdx: index("qa_devices_company_health_idx").on(table.companyId, table.healthStatus),
  }),
);

export const qaTestRuns = pgTable(
  "qa_test_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    suiteId: uuid("suite_id").references(() => qaTestSuites.id, { onDelete: "set null" }),
    environmentId: uuid("environment_id").references(() => qaEnvironments.id, { onDelete: "set null" }),
    deviceId: uuid("device_id").references(() => qaDevices.id, { onDelete: "set null" }),
    qaAgentId: uuid("qa_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    platform: text("platform").notNull().default("api"),
    runnerType: text("runner_type").notNull().default("custom_command"),
    repo: text("repo"),
    service: text("service"),
    pullNumber: integer("pull_number"),
    pullUrl: text("pull_url"),
    headSha: text("head_sha"),
    buildSha: text("build_sha"),
    status: text("status").notNull().default("queued"),
    conclusion: text("conclusion").notNull().default("unknown"),
    commandProfile: jsonb("command_profile").$type<Record<string, unknown>>().notNull().default({}),
    parserType: text("parser_type").notNull().default("none"),
    summary: text("summary"),
    signoffStatus: text("signoff_status").notNull().default("not_requested"),
    signoffByUserId: text("signoff_by_user_id"),
    signoffAt: timestamp("signoff_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("qa_test_runs_company_status_idx").on(table.companyId, table.status),
    companyIssueIdx: index("qa_test_runs_company_issue_idx").on(table.companyId, table.issueId),
    companySuiteIdx: index("qa_test_runs_company_suite_idx").on(table.companyId, table.suiteId),
    companyPrIdx: index("qa_test_runs_company_pr_idx").on(table.companyId, table.repo, table.pullNumber),
    companyUpdatedIdx: index("qa_test_runs_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);

export const qaTestResults = pgTable(
  "qa_test_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => qaTestRuns.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => qaTestCases.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: text("status").notNull(),
    expectedResult: text("expected_result"),
    actualResult: text("actual_result"),
    failureReason: text("failure_reason"),
    durationMs: integer("duration_ms"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunIdx: index("qa_test_results_company_run_idx").on(table.companyId, table.runId),
    companyStatusIdx: index("qa_test_results_company_status_idx").on(table.companyId, table.status),
  }),
);

export const qaArtifacts = pgTable(
  "qa_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => qaTestRuns.id, { onDelete: "cascade" }),
    resultId: uuid("result_id").references(() => qaTestResults.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    storageKey: text("storage_key"),
    contentType: text("content_type"),
    byteSize: integer("byte_size"),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunIdx: index("qa_artifacts_company_run_idx").on(table.companyId, table.runId),
    companyTypeIdx: index("qa_artifacts_company_type_idx").on(table.companyId, table.type),
  }),
);

export const qaFeedbackEvents = pgTable(
  "qa_feedback_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").references(() => qaTestRuns.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    fromQaAgentId: uuid("from_qa_agent_id").references(() => agents.id, { onDelete: "set null" }),
    toAgentId: uuid("to_agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    severity: text("severity").notNull().default("medium"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    dedupeHash: text("dedupe_hash").notNull(),
    artifactRefs: jsonb("artifact_refs").$type<Record<string, unknown>[]>().notNull().default([]),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createsBugIssue: boolean("creates_bug_issue").notNull().default(false),
    bugIssueId: uuid("bug_issue_id").references(() => issues.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("qa_feedback_events_company_status_idx").on(table.companyId, table.status),
    companyIssueIdx: index("qa_feedback_events_company_issue_idx").on(table.companyId, table.issueId),
    companyDedupeUq: uniqueIndex("qa_feedback_events_company_dedupe_uq").on(
      table.companyId,
      table.dedupeHash,
    ),
  }),
);
