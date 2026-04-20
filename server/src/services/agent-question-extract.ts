import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { issueComments, issues } from "@combyne/db";
import { logger } from "../middleware/logger.js";

export interface ExtractedQuestionSource {
  companyId: string;
  agentId: string;
  issueId: string;
  /** Free-form text emitted by the agent — stdoutExcerpt, resultJson, plan doc, etc. */
  sourceText: string;
  /** Cap on how many questions to auto-post at once. Prevents a runaway plan
   *  with 40 open questions from flooding the issue timeline. */
  maxQuestions?: number;
}

export interface ExtractedQuestionsResult {
  posted: number;
  skippedDuplicates: number;
  skippedExisting: number;
  statusTransitioned: boolean;
}

const DEFAULT_MAX_QUESTIONS = 10;
const MIN_QUESTION_LENGTH = 10;
const MAX_QUESTION_LENGTH = 500;

const QUESTION_SECTION_HEADERS = [
  /^#{1,6}\s+open\s+questions?\b/i,
  /^#{1,6}\s+clarifying\s+questions?\b/i,
  /^#{1,6}\s+questions?\s+for\s+(?:the\s+)?user\b/i,
  /^#{1,6}\s+questions?\s+pending\b/i,
  /^\*\*open\s+questions?\*\*/i,
];

/**
 * Pull numbered / bulleted questions out of agent-produced text. An agent
 * writing "8 open questions listed at the bottom of the plan" in prose was
 * leaving the Reply-and-Wake card with nothing structured to render — this
 * function converts those into proper `kind="question"` comments that the
 * existing QuestionAnswerCard UI already knows how to render.
 *
 * Parsing is deliberately loose: we look for a "## Open questions" section
 * (or equivalent) and take every bulleted/numbered line ending in "?", or
 * we fall back to harvesting any numbered list whose items end in "?".
 */
export function extractQuestionsFromText(
  raw: string,
  maxQuestions: number = DEFAULT_MAX_QUESTIONS,
): string[] {
  if (!raw || typeof raw !== "string") return [];
  const lines = raw.split(/\r?\n/);

  // Pass 1 — find a dedicated "Open questions" section and harvest inside it.
  let insideSection = false;
  const sectionItems: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const isSectionHeader = QUESTION_SECTION_HEADERS.some((re) => re.test(line));
    if (isSectionHeader) {
      insideSection = true;
      continue;
    }
    // Any other markdown heading ends the current section.
    if (insideSection && /^#{1,6}\s+/.test(line)) {
      insideSection = false;
      continue;
    }
    if (!insideSection) continue;
    const item = stripBullet(line);
    if (item && item.endsWith("?")) sectionItems.push(item);
  }

  // Pass 2 — if no dedicated section, harvest any bulleted/numbered question
  // from the full text. This catches agents that bury questions inline.
  const fallbackItems: string[] = [];
  if (sectionItems.length === 0) {
    for (const rawLine of lines) {
      const item = stripBullet(rawLine.trim());
      if (item && item.endsWith("?")) fallbackItems.push(item);
    }
  }

  const candidates = sectionItems.length > 0 ? sectionItems : fallbackItems;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length < MIN_QUESTION_LENGTH) continue;
    if (candidate.length > MAX_QUESTION_LENGTH) continue;
    const key = candidate.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= maxQuestions) break;
  }
  return out;
}

/**
 * Strip common markdown bullet prefixes: `-`, `*`, `1.`, `1)`, `(1)`,
 * `Q1:`, `Q.1`. Returns the question body, or an empty string if the line
 * isn't a list item.
 */
function stripBullet(line: string): string {
  const bulletMatch = line.match(
    /^(?:[-*+]\s+|\(\d+\)\s*|\d+[.)]\s+|Q\d+[:.)]\s*)(.*)$/i,
  );
  if (bulletMatch) return bulletMatch[1]!.trim().replace(/^\*\*|\*\*$/g, "").trim();
  // Accept a trailing-`?` line too — not every agent bullets.
  if (line.endsWith("?")) return line.replace(/^\*\*|\*\*$/g, "").trim();
  return "";
}

/**
 * Extract questions from the run output and post each as a structured
 * `kind="question"` comment. Skips any question text that's already been
 * posted as an *unanswered* question on this issue (dedupe across runs).
 * Transitions the issue to `awaiting_user` when at least one new question
 * is posted.
 *
 * Returns stats for telemetry. Failures bubble up to the caller so the
 * run-finalize path can log — they never break run completion.
 */
export async function extractAndPostQuestions(
  db: Db,
  input: ExtractedQuestionSource,
): Promise<ExtractedQuestionsResult> {
  const max = input.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const extracted = extractQuestionsFromText(input.sourceText, max);
  if (extracted.length === 0) {
    return { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false };
  }

  // Dedupe against already-open question comments on this issue so a
  // re-run of the same plan doesn't multiply the card list.
  const openQuestions = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.kind, "question"),
        isNull(issueComments.answeredAt),
      ),
    );
  const existingKeys = new Set(
    openQuestions.map((row) => row.body.toLowerCase().replace(/\s+/g, " ").trim()),
  );

  let posted = 0;
  let skippedExisting = 0;
  for (const question of extracted) {
    const key = question.toLowerCase().replace(/\s+/g, " ");
    if (existingKeys.has(key)) {
      skippedExisting++;
      continue;
    }
    existingKeys.add(key);
    try {
      await db.insert(issueComments).values({
        companyId: input.companyId,
        issueId: input.issueId,
        authorAgentId: input.agentId,
        authorUserId: null,
        body: question,
        kind: "question",
      });
      posted++;
    } catch (err) {
      logger.warn(
        { err, issueId: input.issueId, agentId: input.agentId },
        "question-extractor: failed to post question comment",
      );
    }
  }

  let statusTransitioned = false;
  if (posted > 0) {
    try {
      await db
        .update(issues)
        .set({ status: "awaiting_user", awaitingUserSince: new Date(), updatedAt: new Date() })
        .where(eq(issues.id, input.issueId));
      statusTransitioned = true;
    } catch (err) {
      logger.warn(
        { err, issueId: input.issueId },
        "question-extractor: failed to mark issue awaiting_user",
      );
    }
  }

  return {
    posted,
    skippedDuplicates: extracted.length - posted - skippedExisting,
    skippedExisting,
    statusTransitioned,
  };
}
