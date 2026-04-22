import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companySkills } from "./company_skills.js";
import { agents } from "./agents.js";

export const skillAgents = pgTable(
  "skill_agents",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => companySkills.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.skillId, table.agentId] }),
    agentIdx: index("skill_agents_agent_idx").on(table.agentId),
  }),
);
