import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { issueComments } from "@combyne/db";

/**
 * Sufficiency-gate guardrails (MEMORY_UI_AND_QUALITY_PLAN §2.7) — don't make
 * agents chatty. Two limits, both enforced BEFORE the gate posts a question:
 *
 *  1. Per-issue ask budget (default 2 gate-driven questions / issue).
 *  2. Per-subjectKey cooldown — never re-ask a subjectKey that already has an
 *     answered comment OR an open question. Reuses the EXACT duplicate-question
 *     normalization from agent-question-routing.ts:272-276
 *     (`body.toLowerCase().replace(/\s+/g," ").trim()`) so the gate cannot flood
 *     the timeline with paraphrase-distinct dupes of an already-asked question.
 *
 * These are only EXERCISED when COMBYNE_SUFFICIENCY_GATE_ENABLED is on (Phase 3
 * ask-mode). While dark the gate never posts, so the budget is never consulted.
 */

export const DEFAULT_PER_ISSUE_ASK_BUDGET = 2;

/** The kind under which gate-authored (and agent) questions are recorded. */
const GATE_QUESTION_KIND = "manager_question";

/**
 * The canonical dedupe normalization shared with agent-question-routing.ts:270
 * (`existingIdByKey`) — keep these IN SYNC. Lowercase, collapse whitespace, trim.
 */
export function normalizeQuestionKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function perIssueAskBudget(): number {
  return envInt("COMBYNE_SUFFICIENCY_ASK_BUDGET", DEFAULT_PER_ISSUE_ASK_BUDGET);
}

export interface AskBudgetDecision {
  /** True ⇒ the gate may post this question. */
  allowed: boolean;
  reason:
    | "ok"
    | "issue_budget_exhausted"
    | "subject_key_cooldown"
    | "empty_question";
  /** Gate-driven questions already posted on this issue. */
  askedOnIssue: number;
  budget: number;
}

/**
 * Decide whether the gate may post `question` on `issueId`. PURE-ish: it reads
 * the existing manager_question comments for the issue (the same rows the
 * dedupe guard reads) and applies the budget + cooldown. Never writes.
 *
 * Cooldown semantics (§2.7): a subjectKey is "covered" once it has ANY question
 * comment — answered (the loop closed) or still open (already asked) — so the
 * gate does not re-ask. The normalization matches the routing dedupe so a
 * paraphrase that collapses to the same key is also blocked.
 */
export async function evaluateAskBudget(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    question: string;
    /**
     * Optional explicit subjectKey for the cooldown (the question-comment key
     * of the original gap, §2.5). When omitted the question text itself is the
     * key (matches the routing dedupe behavior).
     */
    subjectKey?: string | null;
  },
): Promise<AskBudgetDecision> {
  const budget = perIssueAskBudget();
  const clean = input.question.trim();
  if (clean.length === 0) {
    return { allowed: false, reason: "empty_question", askedOnIssue: 0, budget };
  }

  // All gate/agent questions on the issue (the §2.7 ask-budget denominator).
  const allRows = await db
    .select({ id: issueComments.id, body: issueComments.body })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.kind, GATE_QUESTION_KIND),
      ),
    );
  const askedOnIssue = allRows.length;

  // Cooldown: the existing duplicate-question guard's normalized key set
  // (answered OR open — any prior ask covers the subjectKey).
  const existingKeys = new Set(allRows.map((r) => normalizeQuestionKey(r.body)));
  const key = normalizeQuestionKey(input.subjectKey ?? clean);
  if (existingKeys.has(key)) {
    return { allowed: false, reason: "subject_key_cooldown", askedOnIssue, budget };
  }

  if (askedOnIssue >= budget) {
    return { allowed: false, reason: "issue_budget_exhausted", askedOnIssue, budget };
  }

  return { allowed: true, reason: "ok", askedOnIssue, budget };
}

/**
 * Lightweight unanswered-only variant used where the routing layer's open
 * dedupe already runs — exported for the §2.7 cooldown that should NOT re-ask a
 * subjectKey with an OPEN (unanswered) question even if budget remains.
 */
export async function hasOpenGateQuestion(
  db: Db,
  input: { companyId: string; issueId: string; subjectKey: string },
): Promise<boolean> {
  const rows = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.kind, GATE_QUESTION_KIND),
        isNull(issueComments.answeredAt),
      ),
    );
  const key = normalizeQuestionKey(input.subjectKey);
  return rows.some((r) => normalizeQuestionKey(r.body) === key);
}
