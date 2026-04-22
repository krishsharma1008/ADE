import { index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Round 3 Item #6. Rolling log of (estimated vs actual) token counts per
// model family. The context-budget package reads a 7-day rolling median to
// correct its heuristics.
export const tokenizerCalibration = pgTable(
  "tokenizer_calibration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modelFamily: text("model_family").notNull(),
    ratio: numeric("ratio", { precision: 10, scale: 4 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    runId: uuid("run_id"),
    estimatedTokens: integer("estimated_tokens"),
    actualTokens: integer("actual_tokens"),
  },
  (table) => ({
    familyObservedIdx: index("tokenizer_calibration_family_observed_idx").on(
      table.modelFamily,
      table.observedAt,
    ),
  }),
);
