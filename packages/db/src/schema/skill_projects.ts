import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companySkills } from "./company_skills.js";
import { projects } from "./projects.js";

export const skillProjects = pgTable(
  "skill_projects",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => companySkills.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.skillId, table.projectId] }),
    projectIdx: index("skill_projects_project_idx").on(table.projectId),
  }),
);
