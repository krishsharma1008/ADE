import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentTerminalSessions = pgTable(
  "agent_terminal_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(), // 'cli' | 'shell'
    command: text("command").notNull(),
    cwd: text("cwd").notNull(),
    status: text("status").notNull().default("running"), // 'running' | 'closed' | 'crashed'
    exitCode: integer("exit_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    logRef: text("log_ref"),
    openedBy: text("opened_by"),
  },
  (table) => ({
    agentIdx: index("agent_terminal_sessions_agent_idx").on(table.agentId, table.startedAt),
  }),
);
