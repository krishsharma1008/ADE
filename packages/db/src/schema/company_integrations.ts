import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyIntegrations = pgTable(
  "company_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    provider: text("provider").notNull(), // "jira" | "confluent"
    enabled: text("enabled").notNull().default("true"),
    config: jsonb("config").notNull().default({}),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_integrations_company_idx").on(table.companyId),
    companyProviderUq: uniqueIndex("company_integrations_company_provider_uq").on(
      table.companyId,
      table.provider,
    ),
  }),
);
