import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { issueComments, issues } from "@combyne/db";
import {
  extractAgentQuestionItems,
  extractAgentQuestionsFromText,
  formatExtractedAgentQuestion,
} from "@combyne/shared";
import { logger } from "../middleware/logger.js";
import { routeAgentQuestionsToManager } from "./agent-question-routing.js";

export interface ExtractedQuestionSource {
  companyId: string;
  agentId: string;
  issueId: string;
  /** Free-form text emitted by the agent: stdoutExcerpt, resultJson, plan doc, etc. */
  sourceText: string;
  /** Cap on how many questions to auto-post at once. */
  maxQuestions?: number;
}

export interface ExtractedQuestionsResult {
  posted: number;
  skippedDuplicates: number;
  skippedExisting: number;
  statusTransitioned: boolean;
  routedToManager?: boolean;
  routedToAgentId?: string | null;
  routedCommentIds?: string[];
}

const DEFAULT_MAX_QUESTIONS = 10;
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;

/**
 * Compatibility wrapper for existing server call sites that expect display
 * strings. Structured extraction lives in @combyne/shared so server and UI
 * fallback parsing remain identical.
 */
export function extractQuestionsFromText(
  raw: string,
  maxQuestions: number = DEFAULT_MAX_QUESTIONS,
): string[] {
  return extractAgentQuestionsFromText(raw, maxQuestions);
}

/**
 * Extract questions from the run output and post each as a structured
 * `kind="question"` comment. Skips any question text that's already been
 * posted as an unanswered question on this issue (dedupe across runs).
 */
export async function extractAndPostQuestions(
  db: Db,
  input: ExtractedQuestionSource,
): Promise<ExtractedQuestionsResult> {
  const max = input.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const extractedItems = extractAgentQuestionItems(input.sourceText, max);
  if (extractedItems.length === 0) {
    return { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false };
  }

  // If the user (or a scheduler) already closed the issue mid-run, do not
  // post questions or rebound to awaiting_user.
  const currentIssue = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .then((rows) => rows[0] ?? null);
  if (
    currentIssue &&
    (TERMINAL_ISSUE_STATUSES as readonly string[]).includes(currentIssue.status)
  ) {
    return { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false };
  }

  const extractedDisplayText = extractedItems.map(formatExtractedAgentQuestion);
  const managerRoute = await routeAgentQuestionsToManager(db, {
    companyId: input.companyId,
    issueId: input.issueId,
    askingAgentId: input.agentId,
    questions: extractedDisplayText,
    actor: { actorType: "agent", actorId: input.agentId },
  }).catch((err) => {
    logger.warn(
      { err, issueId: input.issueId, agentId: input.agentId },
      "question-extractor: failed to route question to manager",
    );
    return null;
  });
  if (managerRoute?.routedToManager) {
    return {
      posted: managerRoute.routedCommentIds.length,
      skippedDuplicates: 0,
      skippedExisting: Math.max(0, extractedItems.length - managerRoute.routedCommentIds.length),
      statusTransitioned: managerRoute.issue.status === "blocked",
      routedToManager: true,
      routedToAgentId: managerRoute.routedToAgentId,
      routedCommentIds: managerRoute.routedCommentIds,
    };
  }

  // Dedupe against already-open question comments on this issue so a re-run
  // of the same plan doesn't multiply the card list. Include choices in the
  // key because option-style prompts store choices outside the comment body.
  const openQuestions = await db
    .select({ body: issueComments.body, choices: issueComments.choices })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.kind, "question"),
        isNull(issueComments.answeredAt),
      ),
    );
  const existingKeys = new Set(
    openQuestions.map((row) =>
      row.choices && row.choices.length > 0
        ? normalizeQuestionKey(`${row.body}\n${row.choices.map((choice) => `- ${choice}`).join("\n")}`)
        : normalizeQuestionKey(row.body),
    ),
  );

  let posted = 0;
  let skippedExisting = 0;
  for (const item of extractedItems) {
    const key = normalizeQuestionKey(formatExtractedAgentQuestion(item));
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
        body: item.body,
        kind: "question",
        choices: item.choices && item.choices.length > 0 ? item.choices : null,
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
      const updated = await db
        .update(issues)
        .set({ status: "awaiting_user", awaitingUserSince: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(issues.id, input.issueId),
            notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES] as string[]),
          ),
        )
        .returning({ id: issues.id });
      statusTransitioned = updated.length > 0;
    } catch (err) {
      logger.warn(
        { err, issueId: input.issueId },
        "question-extractor: failed to mark issue awaiting_user",
      );
    }
  }

  return {
    posted,
    skippedDuplicates: extractedItems.length - posted - skippedExisting,
    skippedExisting,
    statusTransitioned,
  };
}

function normalizeQuestionKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
