// Round 3 Phase 3 — telemetry-only tokenizer wiring.
//
// No composition decisions yet. We estimate the prompt's input-token cost
// at adapter.invoke time, stash it on heartbeat_runs.prompt_budget_json,
// and compare against the adapter-reported usage.inputTokens once the run
// completes. Ratios land in tokenizer_calibration for the composer phase
// to consume.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  tokenizerCalibration,
  type Db,
} from "@combyne/db";
import {
  clampRatio,
  countTokens,
  DEFAULT_WINDOW_DAYS,
  MIN_SAMPLES,
  resolveModel,
  type ModelFamily,
} from "@combyne/context-budget";
import { logger } from "../middleware/logger.js";

export interface BudgetSnapshot {
  estimatedInputTokens: number;
  tokenizerFamily: ModelFamily;
  tokenizerLabel: string;
  promptChars: number;
  calibrationRatio: number | null;
}

export function estimatePromptBudget(prompt: string, model: string): BudgetSnapshot {
  const descriptor = resolveModel(model);
  let estimatedInputTokens = 0;
  try {
    estimatedInputTokens = countTokens(prompt, model);
  } catch (err) {
    logger.warn({ err, model }, "tokenizer.panic");
    estimatedInputTokens = Math.max(1, Math.ceil(prompt.length / 3.5));
  }
  return {
    estimatedInputTokens,
    tokenizerFamily: descriptor.family,
    tokenizerLabel: descriptor.label,
    promptChars: prompt.length,
    calibrationRatio: null,
  };
}

export async function persistRunBudget(
  db: Db,
  runId: string,
  snapshot: BudgetSnapshot,
): Promise<void> {
  try {
    await db
      .update(heartbeatRuns)
      .set({
        promptBudgetJson: {
          ...snapshot,
          recordedAt: new Date().toISOString(),
        } as Record<string, unknown>,
      })
      .where(eq(heartbeatRuns.id, runId));
  } catch (err) {
    logger.debug({ err, runId }, "context_budget.persist_failed");
  }
}

export async function recordCalibrationSample(
  db: Db,
  opts: {
    runId: string;
    family: ModelFamily;
    estimatedTokens: number;
    actualTokens: number;
  },
): Promise<void> {
  if (opts.estimatedTokens <= 0 || opts.actualTokens <= 0) return;
  try {
    const ratio = opts.actualTokens / opts.estimatedTokens;
    await db.insert(tokenizerCalibration).values({
      modelFamily: opts.family,
      ratio: String(clampRatio(ratio)),
      runId: opts.runId,
      estimatedTokens: opts.estimatedTokens,
      actualTokens: opts.actualTokens,
    });
  } catch (err) {
    logger.debug({ err, ...opts }, "context_budget.calibration_failed");
  }
}

export async function rollingMedianRatio(
  db: Db,
  family: ModelFamily,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<number | null> {
  try {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({ ratio: tokenizerCalibration.ratio })
      .from(tokenizerCalibration)
      .where(
        and(
          eq(tokenizerCalibration.modelFamily, family),
          gte(tokenizerCalibration.observedAt, cutoff),
        ),
      )
      .orderBy(desc(tokenizerCalibration.observedAt))
      .limit(200);
    if (rows.length < MIN_SAMPLES) return null;
    const ratios = rows
      .map((r) => Number(r.ratio))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ratios.length < MIN_SAMPLES) return null;
    const sorted = [...ratios].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return clampRatio(median);
  } catch (err) {
    logger.debug({ err, family }, "context_budget.median_query_failed");
    return null;
  }
}

// Minor utility used by heartbeat.ts to log divergence alerts — if the
// adapter-reported usage diverges from our estimate by >2x, something is
// wrong with either the tokenizer or the adapter's accounting.
export function shouldAlertDivergence(estimated: number, actual: number): boolean {
  if (estimated <= 0 || actual <= 0) return false;
  const ratio = actual / estimated;
  return ratio > 2 || ratio < 0.5;
}

// Aggregate the last 24h of calibration alerts for a family. Used by an
// optional ops script / dashboard.
export async function countRecentDivergences(
  db: Db,
  family: ModelFamily,
  windowHours: number = 24,
): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const rows = await db
      .select({
        ratio: tokenizerCalibration.ratio,
        estimated: tokenizerCalibration.estimatedTokens,
        actual: tokenizerCalibration.actualTokens,
      })
      .from(tokenizerCalibration)
      .where(
        and(
          eq(tokenizerCalibration.modelFamily, family),
          gte(tokenizerCalibration.observedAt, cutoff),
        ),
      );
    let count = 0;
    for (const r of rows) {
      if (shouldAlertDivergence(r.estimated ?? 0, r.actual ?? 0)) count++;
    }
    return count;
  } catch (err) {
    logger.debug({ err, family }, "context_budget.count_divergences_failed");
    return 0;
  }
}

// Convenience alias matching the import shape used by heartbeat.ts.
export { sql };
