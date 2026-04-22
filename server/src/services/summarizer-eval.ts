// Round 3 Phase 6 PR 6.5 — summarizer quality harness.
//
// Goal: catch "summarizer is losing critical context" before pilot users
// hit it. The harness drives a fixture transcript through the same
// summarizer → render pipeline production uses, asks a judge model to
// answer canonical questions given just `summary + recent_tail`, and
// scores the answers against oracle keyFacts.
//
// Two run modes let us compare:
//   - "summary" — uses renderStanding/WorkingSummary + renderRecentTurns.
//   - "control" — uses renderRecentTurns only (no summary).
// The gap between the two is the summarizer's value-add. If control
// scores as well as summary, summarization is pure cost with no benefit.
//
// Baseline anchors freeze a known-good score per fixture. Regression is
// detected when the current score drops more than `tolerance` below the
// anchor. Anchors live in a committed JSON file so quality drift shows
// up in code review.

import { readFile } from "node:fs/promises";
import {
  renderStandingSummary,
  renderWorkingSummary,
  type SummarizerDriver,
  type SummaryScope,
} from "./transcript-summarizer.js";
import {
  renderRecentTurns,
  type UnsummarizedTokensResult,
} from "./summarizer-triggers.js";
import type { LoadedTranscriptEntry } from "./agent-transcripts.js";

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

export interface FixtureTranscriptEntry {
  ordinal: number;
  role: "user" | "assistant" | "tool_result" | "system";
  content: string;
  contentKind?: string | null;
}

export interface FixtureQuestion {
  id: string;
  question: string;
  oracleAnswer: string;
  keyFacts: string[];
  mustAvoid?: string[];
}

export interface Fixture {
  id: string;
  description: string;
  scope: SummaryScope;
  issueId?: string | null;
  transcript: FixtureTranscriptEntry[];
  questions: FixtureQuestion[];
  // Optional hint. When present, it defines the cutoff for the "summary"
  // mode's simulated summarizer output — entries up to this ordinal are
  // summarized, entries after are the recent tail. If absent, we summarize
  // everything except the last 5 turns.
  summaryCutoffOrdinal?: number | null;
}

export interface FixtureFile {
  fixtures: Fixture[];
}

export function validateFixture(raw: unknown): Fixture {
  if (!raw || typeof raw !== "object") throw new Error("fixture must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) throw new Error("fixture.id missing");
  if (typeof r.description !== "string") throw new Error("fixture.description missing");
  if (r.scope !== "standing" && r.scope !== "working") {
    throw new Error(`fixture.scope must be "standing" or "working", got ${String(r.scope)}`);
  }
  if (!Array.isArray(r.transcript) || r.transcript.length === 0) {
    throw new Error("fixture.transcript must be non-empty array");
  }
  if (!Array.isArray(r.questions) || r.questions.length === 0) {
    throw new Error("fixture.questions must be non-empty array");
  }
  for (const q of r.questions as unknown[]) {
    if (!q || typeof q !== "object") throw new Error("question must be an object");
    const qo = q as Record<string, unknown>;
    if (typeof qo.id !== "string") throw new Error("question.id missing");
    if (typeof qo.question !== "string") throw new Error("question.question missing");
    if (typeof qo.oracleAnswer !== "string") throw new Error("question.oracleAnswer missing");
    if (!Array.isArray(qo.keyFacts) || qo.keyFacts.length === 0) {
      throw new Error("question.keyFacts must be non-empty array");
    }
  }
  return raw as Fixture;
}

export async function loadFixtureFile(path: string): Promise<FixtureFile> {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`fixture file ${path} is not an object`);
  }
  const maybe = (parsed as { fixtures?: unknown }).fixtures;
  const list = Array.isArray(maybe) ? maybe : [parsed];
  const fixtures = list.map((f, i) => {
    try {
      return validateFixture(f);
    } catch (err) {
      throw new Error(`fixture[${i}] in ${path}: ${(err as Error).message}`);
    }
  });
  return { fixtures };
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export interface JudgeInput {
  question: string;
  candidateAnswer: string;
  oracleAnswer: string;
  keyFacts: string[];
  mustAvoid?: string[];
}

export interface JudgeResult {
  score: number; // 0..1
  missingFacts: string[];
  violatedAvoids: string[];
  reason?: string;
}

export type Judge = (input: JudgeInput) => Promise<JudgeResult> | JudgeResult;

// Deterministic judge: score = (keyFactsHit / keyFactsTotal), penalized by
// each mustAvoid term that appears in the candidate. No model call, no
// network. Good for unit tests and as a cheap signal in CI.
export function makeKeyFactsJudge(): Judge {
  return ({ question: _q, candidateAnswer, keyFacts, mustAvoid }) => {
    const normalized = candidateAnswer.toLowerCase();
    const missing: string[] = [];
    let hits = 0;
    for (const f of keyFacts) {
      if (normalized.includes(f.toLowerCase())) hits += 1;
      else missing.push(f);
    }
    const baseScore = keyFacts.length === 0 ? 0 : hits / keyFacts.length;
    const violated: string[] = [];
    for (const a of mustAvoid ?? []) {
      if (normalized.includes(a.toLowerCase())) violated.push(a);
    }
    const penalty = violated.length * 0.25;
    return {
      score: Math.max(0, Math.min(1, baseScore - penalty)),
      missingFacts: missing,
      violatedAvoids: violated,
    };
  };
}

// ---------------------------------------------------------------------------
// Context composition
// ---------------------------------------------------------------------------

function fixtureEntryToLoaded(
  e: FixtureTranscriptEntry,
  idx: number,
): LoadedTranscriptEntry {
  return {
    id: `fx-${idx}`,
    ordinal: e.ordinal,
    seq: e.ordinal,
    runId: null,
    issueId: null,
    terminalSessionId: null,
    role: e.role,
    contentKind: e.contentKind ?? null,
    content: { message: e.content },
    createdAt: new Date(0),
  };
}

export function splitAtCutoff(
  fixture: Fixture,
): { head: LoadedTranscriptEntry[]; tail: LoadedTranscriptEntry[] } {
  const loaded = fixture.transcript.map(fixtureEntryToLoaded);
  const cutoff =
    fixture.summaryCutoffOrdinal ??
    (loaded.length > 5 ? loaded[loaded.length - 6].ordinal : null);
  if (cutoff == null) return { head: [], tail: loaded };
  const head = loaded.filter((e) => e.ordinal <= cutoff);
  const tail = loaded.filter((e) => e.ordinal > cutoff);
  return { head, tail };
}

// ---------------------------------------------------------------------------
// Evaluation modes
// ---------------------------------------------------------------------------

export type RunMode = "summary" | "control";

// Answerer is the model that tries to answer the question given the
// composed context. We expose it as a pluggable driver so tests can stub
// a deterministic answerer and prod can wire the anthropic driver.
export interface AnswererInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}

export interface AnswererOutput {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Answerer {
  answer(input: AnswererInput): Promise<AnswererOutput>;
}

function answererSystem(): string {
  return [
    "You are answering a question about an agent's prior work.",
    "Use ONLY the context provided. If the context does not contain the",
    "answer, say so explicitly. Keep answers short and factual.",
  ].join(" ");
}

function composeAnswererUserPrompt(
  contextBlock: string,
  question: string,
): string {
  return `${contextBlock}\n\n---\nQUESTION: ${question}\nANSWER:`;
}

export interface RunEvalOptions {
  fixture: Fixture;
  mode: RunMode;
  summarizerDriver: SummarizerDriver;
  answerer: Answerer;
  judge: Judge;
  model: string;
  recentTurnsMaxTokens?: number;
}

export interface PerQuestionResult {
  questionId: string;
  question: string;
  oracleAnswer: string;
  candidateAnswer: string;
  judge: JudgeResult;
}

export interface RunEvalResult {
  fixtureId: string;
  mode: RunMode;
  accuracy: number;
  perQuestion: PerQuestionResult[];
  summaryTokens: number;
  tailTokens: number;
  summaryContent: string | null;
  tailContent: string;
}

// Compose the context the answerer will see. "summary" mode drives the
// head of the transcript through the summarizer driver, renders the
// resulting JSON via the production renderer, and concatenates with a
// rendered tail. "control" mode skips the summary entirely.
async function composeContext(
  opts: RunEvalOptions,
): Promise<{ block: string; summaryContent: string | null; summaryTokens: number; tailTokens: number; tail: LoadedTranscriptEntry[] }> {
  const { fixture, mode, summarizerDriver, model, recentTurnsMaxTokens } = opts;
  const { head, tail } = splitAtCutoff(fixture);
  const rendered = renderRecentTurns(tail, model, {
    maxTokens: recentTurnsMaxTokens ?? 4_000,
  });
  let summaryContent: string | null = null;
  let summaryTokens = 0;
  if (mode === "summary" && head.length > 0) {
    const userPrompt = head
      .map((e) => `[${e.role} ord=${e.ordinal}]\n${(e.content as { message: string }).message}`)
      .join("\n\n---\n\n");
    const systemPrompt =
      fixture.scope === "standing"
        ? "Return ONLY a JSON object summarizing cross-ticket standing knowledge."
        : "Return ONLY a JSON object summarizing working state for one ticket.";
    const out = await summarizerDriver.invoke({
      systemPrompt,
      userPrompt,
      model,
      scope: fixture.scope,
      maxOutputTokens: 1_500,
    });
    const parsed = JSON.parse(out.raw) as Record<string, unknown>;
    summaryContent =
      fixture.scope === "standing"
        ? renderStandingSummary(parsed)
        : renderWorkingSummary(parsed);
    summaryTokens = out.inputTokens ?? 0;
  }
  const parts = [summaryContent, rendered.body].filter(
    (x): x is string => !!x && x.length > 0,
  );
  return {
    block: parts.join("\n\n---\n\n"),
    summaryContent,
    summaryTokens,
    tailTokens: rendered.tokens,
    tail,
  };
}

export async function runEval(opts: RunEvalOptions): Promise<RunEvalResult> {
  const composed = await composeContext(opts);
  const perQuestion: PerQuestionResult[] = [];
  for (const q of opts.fixture.questions) {
    const { text } = await opts.answerer.answer({
      systemPrompt: answererSystem(),
      userPrompt: composeAnswererUserPrompt(composed.block, q.question),
      model: opts.model,
    });
    const judgeResult = await opts.judge({
      question: q.question,
      candidateAnswer: text,
      oracleAnswer: q.oracleAnswer,
      keyFacts: q.keyFacts,
      mustAvoid: q.mustAvoid,
    });
    perQuestion.push({
      questionId: q.id,
      question: q.question,
      oracleAnswer: q.oracleAnswer,
      candidateAnswer: text,
      judge: judgeResult,
    });
  }
  const accuracy =
    perQuestion.length === 0
      ? 0
      : perQuestion.reduce((s, r) => s + r.judge.score, 0) / perQuestion.length;
  return {
    fixtureId: opts.fixture.id,
    mode: opts.mode,
    accuracy,
    perQuestion,
    summaryTokens: composed.summaryTokens,
    tailTokens: composed.tailTokens,
    summaryContent: composed.summaryContent,
    tailContent: composed.block,
  };
}

// ---------------------------------------------------------------------------
// Baseline anchors
// ---------------------------------------------------------------------------

export interface BaselineAnchor {
  fixtureId: string;
  summaryAccuracy: number;
  controlAccuracy: number;
  pinnedAt: string; // ISO date
  pinnedBy?: string;
  notes?: string;
}

export interface BaselineFile {
  tolerance: number; // default 0.1
  anchors: BaselineAnchor[];
}

export interface BaselineCheck {
  fixtureId: string;
  mode: RunMode;
  anchor: number;
  observed: number;
  delta: number; // observed - anchor; negative = regression
  tolerance: number;
  passed: boolean;
  reason?: string;
}

export function checkAgainstBaseline(
  result: RunEvalResult,
  baseline: BaselineFile,
): BaselineCheck {
  const anchor = baseline.anchors.find((a) => a.fixtureId === result.fixtureId);
  const tolerance = baseline.tolerance ?? 0.1;
  if (!anchor) {
    return {
      fixtureId: result.fixtureId,
      mode: result.mode,
      anchor: NaN,
      observed: result.accuracy,
      delta: NaN,
      tolerance,
      passed: true, // no anchor = no regression claim
      reason: "no_anchor_yet",
    };
  }
  const anchorValue =
    result.mode === "summary" ? anchor.summaryAccuracy : anchor.controlAccuracy;
  const delta = result.accuracy - anchorValue;
  return {
    fixtureId: result.fixtureId,
    mode: result.mode,
    anchor: anchorValue,
    observed: result.accuracy,
    delta,
    tolerance,
    passed: delta >= -tolerance,
    reason: delta < -tolerance ? "regression_beyond_tolerance" : undefined,
  };
}

export async function loadBaselineFile(path: string): Promise<BaselineFile> {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as Partial<BaselineFile>;
  return {
    tolerance: typeof parsed.tolerance === "number" ? parsed.tolerance : 0.1,
    anchors: Array.isArray(parsed.anchors) ? parsed.anchors : [],
  };
}

// Used by the CLI runner to aggregate multiple fixtures into one go/no-go.
export interface AggregateReport {
  totalFixtures: number;
  totalQuestions: number;
  summaryAccuracyMean: number;
  controlAccuracyMean: number;
  liftMean: number; // summary - control
  regressions: BaselineCheck[];
}

export function aggregate(
  results: RunEvalResult[],
  baselineChecks: BaselineCheck[],
): AggregateReport {
  const summary = results.filter((r) => r.mode === "summary");
  const control = results.filter((r) => r.mode === "control");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const summaryMean = mean(summary.map((r) => r.accuracy));
  const controlMean = mean(control.map((r) => r.accuracy));
  return {
    totalFixtures: new Set(results.map((r) => r.fixtureId)).size,
    totalQuestions: results.reduce((s, r) => s + r.perQuestion.length, 0),
    summaryAccuracyMean: summaryMean,
    controlAccuracyMean: controlMean,
    liftMean: summaryMean - controlMean,
    regressions: baselineChecks.filter((c) => !c.passed),
  };
}
