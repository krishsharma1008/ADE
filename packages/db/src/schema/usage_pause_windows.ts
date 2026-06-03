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
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Issue 4 — usage-pause windows.
 *
 * When the Claude adapter reports a usage / subscription-window limit
 * (`claude_usage_limit_reached`), the run is paused (status `paused_usage`)
 * rather than failed, and the session is preserved. This table is the durable
 * record the usage-pause engine drives off of: one row per paused run, holding
 * the session needed to resume, the (best-effort) reset time, and the retry
 * book-keeping (attempt count, next retry time, exponential backoff).
 *
 * The engine (built by the next agent) scans by `nextRetryAt` / `resetsAt` to
 * pick up windows that are ready to resume.
 */
export const usagePauseWindows = pgTable(
  "usage_pause_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // One pause window per run. UNIQUE so a paused run can't accrue duplicate
    // windows (the engine upserts on runId).
    runId: uuid("run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    // The Claude session id to resume from. Required — without it we can't
    // continue the exact conversation the limit interrupted.
    sessionIdToResume: text("session_id_to_resume").notNull(),
    // The cwd the session ran in, so the resume runs in the same workspace.
    sessionCwd: text("session_cwd"),
    pausedAt: timestamp("paused_at", { withTimezone: true }).notNull().defaultNow(),
    // Best-effort reset time parsed from the limit error, when the provider
    // reported one. Null when unknown.
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    // 'subscription_limit' when the provider reported a window/quota limit;
    // 'unknown_reset_time' when we detected a limit but couldn't parse a reset.
    pauseReason: text("pause_reason").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    retryBackoffMs: integer("retry_backoff_ms").notNull().default(30000),
    maxRetries: integer("max_retries").notNull().default(10),
    lastErrorMessage: text("last_error_message"),
    lastResumeAttemptResult: jsonb("last_resume_attempt_result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("usage_pause_windows_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
    nextRetryIdx: index("usage_pause_windows_next_retry_idx").on(table.nextRetryAt),
    resetsAtIdx: index("usage_pause_windows_resets_at_idx").on(table.resetsAt),
    runUq: uniqueIndex("usage_pause_windows_run_uq").on(table.runId),
  }),
);
