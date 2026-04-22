// Round 3 Phase 6 PR 6.2 — dual-scope summarizer orchestrator.
//
// Two schemas, two renderers, one entry point. Called by the queue; NOT by
// heartbeat directly. The queue owns coalescing, advisory locks, and
// cooldowns — this file owns everything that turns a transcript range into
// a durable `transcript_summaries` row.
//
// Flow:
//   1. Pull entries from `loadTranscriptSince` with issueId filter based on scope.
//   2. Token-count via `@combyne/context-budget`. If below trigger, skip.
//   3. Cost-gate via `cost-table.ts`. If estimate > cap, skip.
//   4. Call driver (adapter-native structured output). Parse. One retry on bad JSON.
//   5. Strip markdown fences, validate shape, drop stale fields.
//   6. Insert row; UNIQUE(agent, scope, scopeId, cutoff) de-dupes races.
//   7. On success: reset failure counter. On failure: bump counter + maybe quarantine.

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { transcriptSummaries } from "@combyne/db";
import { countTokens } from "@combyne/context-budget";
import { logger } from "../middleware/logger.js";
import {
  COUNTABLE_ROLES,
  EXCLUDED_CONTENT_KINDS,
  extractCountableText,
  loadTranscriptSince,
  type LoadedTranscriptEntry,
} from "./agent-transcripts.js";
import { estimateCostUsd, isKnownModel } from "./cost-table.js";
import {
  isQuarantined,
  recordFailure,
  recordSuccess,
  type FailureKey,
} from "./summarizer-failures.js";

export type SummaryScope = "standing" | "working";

export interface SummarizeInput {
  companyId: string;
  agentId: string;
  scope: SummaryScope;
  issueId?: string | null;
  adapterModel: string;
  summarizerModel?: string | null;
  maxCostUsd?: number;
  expectedOutputTokens?: number;
  minTriggerTokens?: number;
  maxInputTokens?: number;
  calibrationRatio?: number | null;
  now?: Date;
}

export type SummarizeStatus =
  | "created"
  | "skipped_below_trigger"
  | "skipped_cost_gate"
  | "skipped_parse_retry_exhausted"
  | "skipped_quarantined"
  | "skipped_invalid_input"
  | "failed";

export interface SummarizeResult {
  status: SummarizeStatus;
  summaryId?: string;
  cutoffSeq?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
  consecutiveFailures?: number;
  quarantinedUntil?: Date | null;
}

// Driver contract — an adapter-native caller that returns structured JSON.
// Tests inject a stub; production wires up claude-local / codex-local.
export interface SummarizerDriverInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  scope: SummaryScope;
  maxOutputTokens: number;
}

export interface SummarizerDriverOutput {
  raw: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface SummarizerDriver {
  invoke(input: SummarizerDriverInput): Promise<SummarizerDriverOutput>;
}

// Defaults live here so the queue and tests see the same numbers.
export const DEFAULT_MAX_COST_USD = 0.5;
export const DEFAULT_EXPECTED_OUTPUT_TOKENS = 1_000;
export const DEFAULT_MIN_TRIGGER_TOKENS_STANDING = 50_000;
export const DEFAULT_MIN_TRIGGER_TOKENS_WORKING = 20_000;
export const DEFAULT_MAX_INPUT_TOKENS = 80_000;

const JSON_FENCE_RE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;

// Keys we validate the parsed JSON against. Unknown fields are kept for
// audit; required fields are enforced strictly so a half-baked response
// becomes a retry instead of a row with missing data.
const STANDING_REQUIRED = ["narrative"] as const;
const WORKING_REQUIRED = ["currentStatus", "narrative"] as const;

function failureKey(input: SummarizeInput): FailureKey & { scopeId: string | null } {
  return {
    agentId: input.agentId,
    scopeKind: input.scope,
    scopeId: input.scope === "working" ? input.issueId ?? null : null,
  };
}

function defaultMinTrigger(scope: SummaryScope): number {
  return scope === "standing"
    ? DEFAULT_MIN_TRIGGER_TOKENS_STANDING
    : DEFAULT_MIN_TRIGGER_TOKENS_WORKING;
}

export function stripMarkdownFence(raw: string): string {
  const m = raw.match(JSON_FENCE_RE);
  return m ? m[1] : raw.trim();
}

export function parseStructured(
  raw: string,
  scope: SummaryScope,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const stripped = stripMarkdownFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return { ok: false, error: `json_parse: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not_an_object" };
  }
  const obj = parsed as Record<string, unknown>;
  const required = scope === "standing" ? STANDING_REQUIRED : WORKING_REQUIRED;
  for (const key of required) {
    if (typeof obj[key] !== "string" || !obj[key]) {
      return { ok: false, error: `missing_required: ${key}` };
    }
  }
  return { ok: true, value: obj };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function asObjectArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is Record<string, unknown> =>
      x !== null && typeof x === "object" && !Array.isArray(x),
  );
}

// Deterministic markdown rendering. Same structured JSON → identical output.
// Keeps composer cache-prefix stable across wakes when the summary doesn't
// change.
export function renderStandingSummary(json: Record<string, unknown>): string {
  const lines: string[] = ["# Standing knowledge"];
  const tickets = asObjectArray(json.activeTickets);
  if (tickets.length) {
    lines.push("", "## Active tickets");
    for (const t of tickets) {
      const id = typeof t.ticketId === "string" ? t.ticketId : "?";
      const title = typeof t.title === "string" ? t.title : "";
      const status = typeof t.status === "string" ? ` [${t.status}]` : "";
      lines.push(`- **${id}**${status} — ${title}`.trim());
    }
  }
  const prefs = asStringArray(json.userPreferences);
  if (prefs.length) {
    lines.push("", "## User preferences");
    for (const p of prefs) lines.push(`- ${p}`);
  }
  const conv = asStringArray(json.repoConventions);
  if (conv.length) {
    lines.push("", "## Repo conventions");
    for (const c of conv) lines.push(`- ${c}`);
  }
  const quirks = asStringArray(json.infraQuirks);
  if (quirks.length) {
    lines.push("", "## Infra quirks");
    for (const q of quirks) lines.push(`- ${q}`);
  }
  const skills = asStringArray(json.skillsExercised);
  if (skills.length) {
    lines.push("", "## Skills exercised");
    for (const s of skills) lines.push(`- ${s}`);
  }
  const facts = asStringArray(json.recentFacts);
  if (facts.length) {
    lines.push("", "## Recent facts");
    for (const f of facts) lines.push(`- ${f}`);
  }
  const narrative = typeof json.narrative === "string" ? json.narrative : "";
  if (narrative) lines.push("", "## Narrative", narrative);
  return lines.join("\n");
}

export function renderWorkingSummary(json: Record<string, unknown>): string {
  const lines: string[] = ["# Working summary"];
  const ticketId = typeof json.ticketId === "string" ? json.ticketId : null;
  const title = typeof json.title === "string" ? json.title : null;
  if (ticketId || title) {
    lines.push(`_${[ticketId, title].filter(Boolean).join(" — ")}_`);
  }
  const status = typeof json.currentStatus === "string" ? json.currentStatus : "";
  lines.push("", `**Current status:** ${status}`);

  const attempts = asObjectArray(json.attemptsMade);
  if (attempts.length) {
    lines.push("", "## Attempts made");
    for (const a of attempts) {
      const approach = typeof a.approach === "string" ? a.approach : "?";
      const outcome = typeof a.outcome === "string" ? a.outcome : "?";
      const reason = typeof a.reason === "string" ? ` (${a.reason})` : "";
      lines.push(`- **${approach}** → ${outcome}${reason}`);
    }
  }

  const push = (heading: string, values: string[]) => {
    if (!values.length) return;
    lines.push("", `## ${heading}`);
    for (const v of values) lines.push(`- ${v}`);
  };
  push("Files examined", asStringArray(json.filesExamined));
  push("Files modified", asStringArray(json.filesModified));
  push("Commands run", asStringArray(json.commandsRun));
  push("Decisions made", asStringArray(json.decisionsMade));
  push("Blockers", asStringArray(json.blockers));
  push("Open questions", asStringArray(json.openQuestions));

  const next = typeof json.nextStepPlan === "string" ? json.nextStepPlan : "";
  if (next) lines.push("", "## Next step plan", next);
  const lastUser = typeof json.lastUserMessage === "string" ? json.lastUserMessage : "";
  if (lastUser) lines.push("", "## Last user message", lastUser);
  const narrative = typeof json.narrative === "string" ? json.narrative : "";
  if (narrative) lines.push("", "## Narrative", narrative);
  return lines.join("\n");
}

function standingSystemPrompt(): string {
  return [
    "You summarize an agent's cross-ticket standing knowledge for a long-running",
    "autonomous workflow. Your output is reused verbatim across future wakes so",
    "accuracy matters more than style. Return ONLY a JSON object with fields:",
    "activeTickets (array of {ticketId,title,status}), userPreferences (array of",
    "strings), repoConventions (strings), infraQuirks (strings), skillsExercised",
    "(strings), recentFacts (strings), narrative (string, 2 short paragraphs).",
    "Do not fabricate facts not present in the transcript.",
  ].join(" ");
}

function workingSystemPrompt(): string {
  return [
    "You summarize an agent's working state for a single ticket. The summary is",
    "reused verbatim on future wakes so the agent doesn't re-discover what it",
    "already knows. Return ONLY a JSON object with fields: ticketId, title,",
    "currentStatus, attemptsMade (array of {approach,outcome,reason}),",
    "filesExamined, filesModified, commandsRun, decisionsMade, blockers,",
    "openQuestions, nextStepPlan, lastUserMessage, narrative. Use empty arrays",
    "or empty strings for missing fields. Do not invent file paths, commands, or",
    "decisions that do not appear in the transcript.",
  ].join(" ");
}

function renderEntryForPrompt(entry: LoadedTranscriptEntry): string {
  const header = entry.contentKind
    ? `[${entry.role}/${entry.contentKind} ord=${entry.ordinal}]`
    : `[${entry.role} ord=${entry.ordinal}]`;
  const body = extractCountableText(entry);
  return `${header}\n${body}`;
}

function buildUserPrompt(
  scope: SummaryScope,
  entries: LoadedTranscriptEntry[],
  retryHint: boolean,
): string {
  const intro = retryHint
    ? "Your previous response was not valid JSON. Return ONLY the JSON object, no prose.\n\n"
    : "";
  const scopeHeader =
    scope === "standing"
      ? "Summarize the agent's cross-ticket standing knowledge from the transcript below."
      : "Summarize the agent's working state for this single ticket from the transcript below.";
  const body = entries.map(renderEntryForPrompt).join("\n\n---\n\n");
  return `${intro}${scopeHeader}\n\n---\n\n${body}`;
}

// Latest row lookup — exposed so the heartbeat preamble composer can reuse
// the same query.
export async function loadLatestSummary(
  db: Db,
  opts: { agentId: string; scopeKind: SummaryScope; scopeId: string | null },
) {
  const filters = [
    eq(transcriptSummaries.agentId, opts.agentId),
    eq(transcriptSummaries.scopeKind, opts.scopeKind),
  ];
  if (opts.scopeId) {
    filters.push(eq(transcriptSummaries.scopeId, opts.scopeId));
  } else {
    filters.push(isNull(transcriptSummaries.scopeId));
  }
  const rows = await db
    .select()
    .from(transcriptSummaries)
    .where(and(...filters))
    .orderBy(desc(transcriptSummaries.cutoffSeq))
    .limit(1);
  return rows[0] ?? null;
}

// Main entry point. Side-effects: writes `transcript_summaries` row OR
// updates `summarizer_failures`. Never throws — returns a typed status.
export async function summarizeAgentTranscript(
  db: Db,
  driver: SummarizerDriver,
  input: SummarizeInput,
): Promise<SummarizeResult> {
  const now = input.now ?? new Date();

  if (input.scope === "working" && !input.issueId) {
    return { status: "skipped_invalid_input", error: "working scope requires issueId" };
  }

  const key = failureKey(input);
  if (await isQuarantined(db, key, now)) {
    return { status: "skipped_quarantined" };
  }

  const latest = await loadLatestSummary(db, {
    agentId: input.agentId,
    scopeKind: input.scope,
    scopeId: key.scopeId,
  });

  const transcript = await loadTranscriptSince(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.scope === "working" ? input.issueId ?? null : null,
    sinceOrdinal: latest?.cutoffSeq ?? null,
    maxRows: 500,
    excludeContentKinds: Array.from(EXCLUDED_CONTENT_KINDS),
  });

  const relevant = transcript.entries.filter(
    (e) =>
      COUNTABLE_ROLES.includes(e.role) &&
      (!e.contentKind || !EXCLUDED_CONTENT_KINDS.includes(e.contentKind)),
  );
  if (relevant.length === 0) {
    return { status: "skipped_below_trigger", cutoffSeq: latest?.cutoffSeq ?? undefined };
  }

  const summarizerModel =
    input.summarizerModel && input.summarizerModel.trim().length
      ? input.summarizerModel
      : input.adapterModel;

  const inputText = relevant.map(extractCountableText).join("\n\n");
  const estimatedInputTokens = countTokens(inputText, summarizerModel, {
    calibrationRatio: input.calibrationRatio ?? null,
  });

  const minTrigger = input.minTriggerTokens ?? defaultMinTrigger(input.scope);
  if (estimatedInputTokens < minTrigger) {
    return {
      status: "skipped_below_trigger",
      inputTokens: estimatedInputTokens,
      cutoffSeq: latest?.cutoffSeq ?? undefined,
    };
  }

  const maxInputTokens = input.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  // If the range is too big, we still summarize but head-truncate to keep
  // cost predictable. Drop oldest turns first.
  let trimmed = relevant;
  if (estimatedInputTokens > maxInputTokens) {
    let total = estimatedInputTokens;
    const keep: typeof relevant = [...relevant];
    while (total > maxInputTokens && keep.length > 1) {
      const dropped = keep.shift()!;
      total -= countTokens(extractCountableText(dropped), summarizerModel, {
        calibrationRatio: input.calibrationRatio ?? null,
      });
    }
    trimmed = keep;
  }

  const expectedOutputTokens = input.expectedOutputTokens ?? DEFAULT_EXPECTED_OUTPUT_TOKENS;
  const maxCostUsd = input.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  const estimatedCost = estimateCostUsd(
    summarizerModel,
    Math.min(estimatedInputTokens, maxInputTokens),
    expectedOutputTokens,
  );
  if (estimatedCost > maxCostUsd) {
    logger.info(
      {
        agentId: input.agentId,
        scope: input.scope,
        scopeId: key.scopeId,
        estimatedCost,
        maxCostUsd,
        summarizerModel,
        knownModel: isKnownModel(summarizerModel),
      },
      "transcript_summary.skipped_cost_gate",
    );
    return { status: "skipped_cost_gate", costUsd: estimatedCost };
  }

  const cutoffOrdinal = trimmed[trimmed.length - 1].ordinal;
  const systemPrompt =
    input.scope === "standing" ? standingSystemPrompt() : workingSystemPrompt();

  const callDriver = async (retry: boolean): Promise<SummarizerDriverOutput> => {
    return driver.invoke({
      systemPrompt,
      userPrompt: buildUserPrompt(input.scope, trimmed, retry),
      model: summarizerModel,
      scope: input.scope,
      maxOutputTokens: expectedOutputTokens * 2,
    });
  };

  let driverOut: SummarizerDriverOutput;
  try {
    driverOut = await callDriver(false);
  } catch (err) {
    const msg = (err as Error).message;
    const failure = await recordFailure(db, key, `driver_error: ${msg}`, now);
    logger.warn(
      {
        agentId: input.agentId,
        scope: input.scope,
        err: msg,
        consecutiveFailures: failure.consecutiveFailures,
        quarantined: failure.quarantined,
      },
      "transcript_summary.driver_failed",
    );
    return {
      status: "failed",
      error: msg,
      consecutiveFailures: failure.consecutiveFailures,
      quarantinedUntil: failure.quarantined
        ? new Date(now.getTime() + 24 * 60 * 60 * 1000)
        : null,
    };
  }

  let parsed = parseStructured(driverOut.raw, input.scope);
  if (!parsed.ok) {
    // Retry-once with a clarifying hint. The driver is expected to be
    // idempotent — calling again costs money but also catches flakes.
    try {
      const retry = await callDriver(true);
      parsed = parseStructured(retry.raw, input.scope);
      driverOut = {
        raw: retry.raw,
        inputTokens: (driverOut.inputTokens ?? 0) + (retry.inputTokens ?? 0),
        outputTokens: (driverOut.outputTokens ?? 0) + (retry.outputTokens ?? 0),
      };
    } catch (err) {
      parsed = { ok: false, error: `retry_driver_error: ${(err as Error).message}` };
    }
  }

  if (!parsed.ok) {
    const failure = await recordFailure(db, key, parsed.error, now);
    logger.warn(
      {
        agentId: input.agentId,
        scope: input.scope,
        error: parsed.error,
        consecutiveFailures: failure.consecutiveFailures,
        quarantined: failure.quarantined,
      },
      "transcript_summary.parse_retry_exhausted",
    );
    return {
      status: "skipped_parse_retry_exhausted",
      error: parsed.error,
      consecutiveFailures: failure.consecutiveFailures,
    };
  }

  const content =
    input.scope === "standing"
      ? renderStandingSummary(parsed.value)
      : renderWorkingSummary(parsed.value);

  try {
    const [row] = await db
      .insert(transcriptSummaries)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        scopeKind: input.scope,
        scopeId: key.scopeId,
        cutoffSeq: cutoffOrdinal,
        content,
        structuredJson: parsed.value,
        sourceInputTokens: estimatedInputTokens,
        sourceTurnCount: trimmed.length,
        summarizerModel,
        inputTokens: driverOut.inputTokens ?? null,
        outputTokens: driverOut.outputTokens ?? null,
      })
      .returning({ id: transcriptSummaries.id });
    await recordSuccess(db, key, now);
    const actualCost =
      driverOut.inputTokens != null && driverOut.outputTokens != null
        ? estimateCostUsd(summarizerModel, driverOut.inputTokens, driverOut.outputTokens)
        : estimatedCost;
    logger.info(
      {
        agentId: input.agentId,
        scope: input.scope,
        scopeId: key.scopeId,
        summaryId: row.id,
        cutoffOrdinal,
        inputTokens: driverOut.inputTokens,
        outputTokens: driverOut.outputTokens,
        costUsd: actualCost,
      },
      "transcript_summary.created",
    );
    return {
      status: "created",
      summaryId: row.id,
      cutoffSeq: cutoffOrdinal,
      inputTokens: driverOut.inputTokens ?? undefined,
      outputTokens: driverOut.outputTokens ?? undefined,
      costUsd: actualCost,
    };
  } catch (err) {
    // UNIQUE collision — a concurrent writer won. Not a failure.
    const msg = (err as Error).message;
    if (/duplicate key|unique constraint/i.test(msg)) {
      logger.info(
        {
          agentId: input.agentId,
          scope: input.scope,
          scopeId: key.scopeId,
          cutoffOrdinal,
        },
        "transcript_summary.race_lost",
      );
      const winner = await loadLatestSummary(db, {
        agentId: input.agentId,
        scopeKind: input.scope,
        scopeId: key.scopeId,
      });
      if (winner) {
        await recordSuccess(db, key, now);
        return {
          status: "created",
          summaryId: winner.id,
          cutoffSeq: Number(winner.cutoffSeq),
        };
      }
    }
    // Transient DB errors (connection reset, deadlock, etc.) are NOT counted
    // toward the 3-strike quarantine. A flaky DB should not mute summarization
    // on a hot key for 24h. The driver/parse failure paths above are the
    // signal of a real problem; DB write trouble reraises on the next wake.
    logger.warn(
      {
        agentId: input.agentId,
        scope: input.scope,
        scopeId: key.scopeId,
        err: msg,
      },
      "transcript_summary.insert_failed",
    );
    return {
      status: "failed",
      error: msg,
    };
  }
}
