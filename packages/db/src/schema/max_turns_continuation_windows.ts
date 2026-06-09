import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Max-turns continuation windows.
 *
 * When the Claude adapter reports a per-run turn-cap exit (`claude_max_turns`)
 * and the task is still MAKING PROGRESS (git-measured) under a per-task budget,
 * the run is NOT blocked — a warm continuation run is re-enqueued on the same
 * issue and the same warm Claude session. This table is the durable per-TASK
 * budget the continuation engine drives off of: one row per issue, holding the
 * round/turn book-keeping and the session needed to resume.
 *
 * This is intentionally SEPARATE from `usage_pause_windows` even though it
 * mirrors its shape: the two lifecycles are distinct (a paused run keeps its
 * status `paused_usage` and is itself resumed; a max-turns run FINALIZES and
 * spawns a fresh continuation run), and sharing the table would corrupt the
 * usage-pause poller's selection.
 *
 * Keyed UNIQUE on `issueId` (the taskKey) so there is exactly one budget window
 * per task; rounds upsert ON CONFLICT to bump `roundCount` / `cumulativeTurns`.
 * The per-run `--max-turns` cap (withSmallCodingTaskControls) stays as the
 * per-ROUND cost control; this window is the TASK-level lever.
 */
export const maxTurnsContinuationWindows = pgTable(
  "max_turns_continuation_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // One continuation window per issue/task. UNIQUE so a task can't accrue
    // duplicate windows (the engine upserts on issueId).
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    // The most recent run that drove this window (for observability / cleanup).
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    // The Claude session id to resume from. Required — without it the
    // continuation can't continue the exact conversation the cap interrupted.
    sessionIdToResume: text("session_id_to_resume"),
    // The cwd the session ran in, so the continuation runs in the same workspace.
    sessionCwd: text("session_cwd"),
    // Per-TASK round budget. roundCount is 0-indexed and capped by maxRounds.
    roundCount: integer("round_count").notNull().default(0),
    maxRounds: integer("max_rounds").notNull().default(3),
    // Hard cumulative-turns backstop summed across rounds (num_turns per round),
    // capped by maxTotalTurns so tiny-progress loops can never run unbounded.
    cumulativeTurns: integer("cumulative_turns").notNull().default(0),
    maxTotalTurns: integer("max_total_turns").notNull().default(200),
    // The HEAD sha at the end of the last round, so the next round's progress
    // signal compares against the prior round (a true cross-round signal).
    headShaAtLastRound: text("head_sha_at_last_round"),
    lastErrorMessage: text("last_error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("max_turns_continuation_windows_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
    issueUq: uniqueIndex("max_turns_continuation_windows_issue_uq").on(table.issueId),
  }),
);
