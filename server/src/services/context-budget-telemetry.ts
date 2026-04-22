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
  composeBudgetedPreamble,
  countTokens,
  DEFAULT_WINDOW_DAYS,
  MIN_SAMPLES,
  resolveModel,
  type ComposedPreamble,
  type ComposedSection,
  type ModelFamily,
  type PreambleSection,
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

// ---------------------------------------------------------------------------
// Round 3 Phase 4 — shadow-mode composer.
//
// Gathers the combyne* context fields populated by heartbeat.ts into
// typed PreambleSections and runs the composer. Output is logged but
// NOT fed back to the adapter — the byte caps still decide what the
// adapter sees. Phase 5 flips the switch.
// ---------------------------------------------------------------------------

function readString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

// Rough per-adapter input-token budgets. These match the table in the
// Round 3 plan; the precise numbers are tunable via env in Phase 5. For
// shadow mode they just need to be in the right ballpark.
const ADAPTER_BUDGETS: Record<string, number> = {
  "claude-local": 160_000,
  "codex-local": 320_000,
  "cursor-local": 160_000,
  "gemini-local": 800_000,
  "opencode-local": 100_000,
  "pi-local": 24_000,
  "browser-use": 100_000,
  "openclaw-gateway": 160_000,
};

export function resolveContextBudgetTokens(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): number {
  const fromConfig = adapterConfig?.contextBudgetTokens;
  if (typeof fromConfig === "number" && Number.isFinite(fromConfig) && fromConfig > 0) {
    return Math.floor(fromConfig);
  }
  const envKey = `COMBYNE_${adapterType.toUpperCase().replace(/-/g, "_")}_CONTEXT_BUDGET_TOKENS`;
  const fromEnv = process.env[envKey];
  if (fromEnv) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return ADAPTER_BUDGETS[adapterType] ?? 160_000;
}

// Pull textual sections out of the heartbeat `context` object. Each
// section corresponds 1:1 to a combyne* field populated earlier in
// runHeartbeatForAgent. Missing fields are skipped silently.
export function buildPreambleSectionsFromContext(
  context: Record<string, unknown>,
): PreambleSection[] {
  const out: PreambleSection[] = [];

  const bootstrap = readObject(context.combyneBootstrapAnalysis);
  const bootstrapBody = readString(bootstrap?.preamble);
  if (bootstrapBody) {
    out.push({
      name: "bootstrap",
      content: bootstrapBody,
      priority: 0,
      cacheStable: true,
      truncationStrategy: "tail",
      maxTokens: 4_000,
    });
  }

  const handoff = readObject(context.combyneHandoffBrief);
  const handoffBrief = readString(handoff?.brief);
  if (handoffBrief) {
    out.push({
      name: "handoff",
      content: handoffBrief,
      priority: 1,
      cacheStable: true,
      truncationStrategy: "tail",
      maxTokens: 2_000,
    });
  }

  const memory = readObject(context.combyneMemoryPreamble);
  const memoryBody = readString(memory?.body);
  if (memoryBody) {
    out.push({
      name: "memory",
      content: memoryBody,
      priority: 3,
      cacheStable: true,
      truncationStrategy: "tail",
      maxTokens: 4_000,
    });
  }

  const hire = readObject(context.combyneHirePlaybook);
  const hireBody = readString(hire?.body);
  if (hireBody) {
    // Shares the "system"-esque slot — not cache-stable because it's
    // gated on per-issue intent detection, which varies wake-to-wake.
    out.push({
      name: "bootstrap",
      content: hireBody,
      priority: 1,
      cacheStable: false,
      truncationStrategy: "tail",
      maxTokens: 4_000,
    });
  }

  const focus = readObject(context.combyneFocusDirective);
  const focusBody = readString(focus?.body);
  if (focusBody) {
    out.push({
      name: "focus",
      content: focusBody,
      priority: 0,
      cacheStable: false,
      truncationStrategy: "preserve",
    });
  }

  const assigned = readObject(context.combyneAssignedIssues);
  const digestBody = readString(assigned?.digestBody) ?? readString(assigned?.body);
  if (digestBody) {
    out.push({
      name: "queue",
      content: digestBody,
      priority: 3,
      cacheStable: false,
      truncationStrategy: "tail",
      maxTokens: 2_000,
    });
  }

  const projects = readObject(context.combyneCompanyProjects);
  if (projects) {
    // Stringify once — cheap for the telemetry path.
    const projectsBody = safeStringify(projects);
    if (projectsBody) {
      out.push({
        name: "projects",
        content: projectsBody,
        priority: 2,
        cacheStable: true,
        truncationStrategy: "tail",
        maxTokens: 4_000,
      });
    }
  }

  return out;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

export interface ShadowCompareResult {
  composed: ComposedPreamble;
  actualPromptTokens: number;
  bytesSaved: number;
  deltaPct: number;
}

// Round 3 Phase 5 — feature flags. Default to shadow-only; ops flips
// COMBYNE_CONTEXT_BUDGET_ENABLED=1 to let the composer replace byte caps.
export function contextBudgetComposerEnabled(): boolean {
  const v = process.env.COMBYNE_CONTEXT_BUDGET_ENABLED;
  return v === "1" || v === "true";
}

// ---------------------------------------------------------------------------
// Round 3 Phase 5 — write budgeted section content back into context.combyne*.
// Adapters keep their existing concatenation logic but read truncated inputs,
// so the single-source-of-truth for budget lives here and the cache prefix
// observed by prompt caching is stable modulo upstream content changes.
// ---------------------------------------------------------------------------

export function composeAndApplyBudget(
  context: Record<string, unknown>,
  opts: { adapterType: string; adapterConfig: Record<string, unknown> | null; model: string; calibrationRatio?: number | null },
): { composed: ComposedPreamble; applied: boolean; skippedReason?: string } | null {
  try {
    const sections = buildPreambleSectionsFromContext(context);
    if (sections.length === 0) {
      return { composed: emptyComposed(), applied: false, skippedReason: "no_sections" };
    }
    const budget = resolveContextBudgetTokens(opts.adapterType, opts.adapterConfig);
    const composed = composeBudgetedPreamble(sections, {
      budget,
      model: opts.model,
      calibrationRatio: opts.calibrationRatio ?? undefined,
    });

    // Only rewrite fields that actually changed (truncated or dropped).
    // Leaves the cache-stable prefix bit-identical when no work was needed.
    let applied = false;
    for (const s of composed.sections) {
      if (!s.truncated && !s.dropped) continue;
      writeSectionBackToContext(context, s);
      applied = true;
    }
    return { composed, applied };
  } catch (err) {
    logger.debug({ err }, "context_budget.apply_failed");
    return null;
  }
}

function writeSectionBackToContext(
  context: Record<string, unknown>,
  section: ComposedSection,
): void {
  const patch = (key: string, path: string[], value: unknown) => {
    const root = (context[key] ?? null) as Record<string, unknown> | null;
    if (!root) return;
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < path.length - 1; i++) {
      const next = cursor[path[i]];
      if (!next || typeof next !== "object") return;
      cursor = next as Record<string, unknown>;
    }
    cursor[path[path.length - 1]] = value;
  };

  switch (section.name) {
    case "bootstrap":
      // Bootstrap lives in two places (analysis + hire playbook). Rewrite
      // whichever is shorter to stay conservative.
      if (section.dropped) {
        delete context.combyneBootstrapAnalysis;
        delete context.combyneHirePlaybook;
      } else {
        patch("combyneBootstrapAnalysis", ["preamble"], section.content);
        patch("combyneHirePlaybook", ["body"], section.content);
      }
      break;
    case "handoff":
      if (section.dropped) delete context.combyneHandoffBrief;
      else patch("combyneHandoffBrief", ["brief"], section.content);
      break;
    case "memory":
      if (section.dropped) delete context.combyneMemoryPreamble;
      else patch("combyneMemoryPreamble", ["body"], section.content);
      break;
    case "focus":
      if (section.dropped) delete context.combyneFocusDirective;
      else patch("combyneFocusDirective", ["body"], section.content);
      break;
    case "queue":
      if (section.dropped) {
        const assigned = context.combyneAssignedIssues as Record<string, unknown> | undefined;
        if (assigned) {
          assigned.digestBody = "";
          assigned.body = "";
        }
      } else {
        patch("combyneAssignedIssues", ["digestBody"], section.content);
        patch("combyneAssignedIssues", ["body"], section.content);
      }
      break;
    // projects is JSON-stringified into the section; we don't parse it
    // back — dropping it just means we leave combyneCompanyProjects in
    // place (the downstream JSON.stringify in the adapter is cheap) but
    // flag it so the adapter could choose to skip. Safer than mutating
    // the structured object shape.
    case "projects":
      if (section.dropped) delete context.combyneCompanyProjects;
      break;
    default:
      // Unknown section — composer shouldn't have produced it. Skip.
      break;
  }
}

function emptyComposed(): ComposedPreamble {
  return {
    body: "",
    cachePrefix: "",
    cachePrefixHash: "",
    totalTokens: 0,
    stableTokens: 0,
    varyTokens: 0,
    usage: {},
    dropped: [],
    truncated: [],
    warnings: [],
    sections: [],
  };
}

export function runShadowComposer(opts: {
  context: Record<string, unknown>;
  adapterType: string;
  adapterConfig: Record<string, unknown> | null;
  actualPrompt: string;
  model: string;
  calibrationRatio?: number | null;
}): ShadowCompareResult | null {
  try {
    const sections = buildPreambleSectionsFromContext(opts.context);
    if (sections.length === 0) return null;
    const budget = resolveContextBudgetTokens(opts.adapterType, opts.adapterConfig);
    const composed = composeBudgetedPreamble(sections, {
      budget,
      model: opts.model,
      calibrationRatio: opts.calibrationRatio ?? undefined,
    });
    const actualPromptTokens = countTokens(opts.actualPrompt, opts.model);
    const bytesSaved = opts.actualPrompt.length - composed.body.length;
    const deltaPct =
      actualPromptTokens > 0
        ? (composed.totalTokens - actualPromptTokens) / actualPromptTokens
        : 0;
    return { composed, actualPromptTokens, bytesSaved, deltaPct };
  } catch (err) {
    logger.debug({ err }, "context_budget.shadow_compose_failed");
    return null;
  }
}
