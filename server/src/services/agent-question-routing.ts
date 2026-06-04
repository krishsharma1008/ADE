import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agents, issueComments, issues } from "@combyne/db";
import { logger } from "../middleware/logger.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { notifyParentOnChildStatus } from "./issue-parent-notifications.js";
import { memoryService } from "./memory.js";
import { scanBody } from "../secret-scan.js";

const COORDINATOR_ROLES = new Set(["ceo", "cto", "cmo", "cfo", "pm", "em", "manager"]);
const INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const MAX_REASON_CHARS = 1000;

type AgentRow = typeof agents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

export type AgentQuestionRouteResult =
  | {
      routedToManager: true;
      routedToAgentId: string;
      routedCommentIds: string[];
      issue: IssueRow;
      fallbackToUser: false;
    }
  | {
      routedToManager: false;
      routedToAgentId: null;
      routedCommentIds: [];
      issue: IssueRow;
      fallbackToUser: true;
      reason: "coordinator_can_escalate" | "no_manager_target" | "terminal_issue" | "no_questions";
    };

export interface RouteAgentQuestionInput {
  companyId: string;
  issueId: string;
  askingAgentId: string;
  questions: string[];
  choices?: string[] | null;
  actor?: {
    actorType: "agent" | "user" | "system";
    actorId: string | null;
  };
}

export interface InternalQuestionAnswerInput {
  companyId: string;
  issueId: string;
  questionCommentId: string;
  answer: string;
  assumption?: boolean;
  actor: {
    actorType: "agent" | "user" | "system";
    actorId: string | null;
    agentId?: string | null;
    runId?: string | null;
  };
}

function parsePermissions(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function isCoordinatorAgent(agent: {
  role?: string | null;
  permissions?: Record<string, unknown> | null;
}) {
  const role = typeof agent.role === "string" ? agent.role.trim().toLowerCase() : "";
  const permissions = parsePermissions(agent.permissions);
  return (
    COORDINATOR_ROLES.has(role) ||
    permissions.canCreateAgents === true ||
    (permissions.canAssignTasks === true && permissions.taskAssignmentScope === "company")
  );
}

function compactText(value: string, maxChars = MAX_REASON_CHARS) {
  const compacted = value.trim().replace(/\s+/g, " ");
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, maxChars - 1).trimEnd()}…`;
}

function isInvokableAgent(agent: Pick<AgentRow, "status">) {
  return INVOKABLE_AGENT_STATUSES.has(agent.status);
}

async function getAgent(db: Db, agentId: string) {
  return db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
}

async function getIssue(db: Db, issueId: string) {
  return db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
}

async function resolveManagerTarget(
  db: Db,
  issue: IssueRow,
  askingAgent: AgentRow,
): Promise<{ agent: AgentRow; source: "parent_assignee" | "manager_chain" | "company_coordinator" } | null> {
  if (issue.parentId) {
    const parent = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.id, issue.parentId), eq(issues.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (parent?.assigneeAgentId && parent.assigneeAgentId !== askingAgent.id) {
      const parentAssignee = await getAgent(db, parent.assigneeAgentId);
      if (parentAssignee && parentAssignee.companyId === issue.companyId && isInvokableAgent(parentAssignee)) {
        return { agent: parentAssignee, source: "parent_assignee" };
      }
    }
  }

  const seen = new Set<string>();
  let cursor = askingAgent.reportsTo ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const manager = await getAgent(db, cursor);
    if (!manager || manager.companyId !== issue.companyId) break;
    if (manager.id !== askingAgent.id && isInvokableAgent(manager)) {
      return { agent: manager, source: "manager_chain" };
    }
    cursor = manager.reportsTo ?? null;
  }

  const coordinators = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.companyId, issue.companyId),
        notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
      ),
    )
    .orderBy(asc(agents.createdAt));
  const fallback = coordinators.find((agent) => agent.id !== askingAgent.id && isCoordinatorAgent(agent));
  return fallback ? { agent: fallback, source: "company_coordinator" } : null;
}

async function wakeManagerForInternalQuestion(
  db: Db,
  input: {
    targetAgentId: string;
    issue: IssueRow;
    askingAgentId: string;
    commentIds: string[];
    questions: string[];
    routeSource: string;
    actor: { actorType: "agent" | "user" | "system"; actorId: string | null };
  },
) {
  try {
    const { heartbeatService } = await import("./heartbeat.js");
    const focusIssueId = input.issue.parentId ?? input.issue.id;
    await heartbeatService(db).wakeup(input.targetAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "internal_question_routed_to_manager",
      payload: {
        issueId: focusIssueId,
        childIssueId: input.issue.id,
        parentIssueId: input.issue.parentId ?? null,
        commentId: input.commentIds[0] ?? null,
        managerQuestionCommentIds: input.commentIds,
        askingAgentId: input.askingAgentId,
      },
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
      contextSnapshot: {
        issueId: focusIssueId,
        taskId: focusIssueId,
        taskKey: focusIssueId,
        childIssueId: input.issue.id,
        parentIssueId: input.issue.parentId ?? null,
        childTaskKey: input.issue.identifier ?? input.issue.id,
        commentId: input.commentIds[0] ?? null,
        wakeCommentId: input.commentIds[0] ?? null,
        wakeReason: "internal_question_routed_to_manager",
        source: "issue.internal_question",
        managerQuestionCommentIds: input.commentIds,
        managerQuestionBody: input.questions.join("\n\n"),
        askingAgentId: input.askingAgentId,
        routeSource: input.routeSource,
        recommendedNextAction:
          "Answer this internal blocker from available context or make a reasonable documented assumption. Escalate to the human only for credentials/access, approval gates, destructive actions, budget/legal risk, or a true product decision with no reasonable default.",
      },
    });
  } catch (err) {
    logger.warn(
      { err, issueId: input.issue.id, targetAgentId: input.targetAgentId },
      "failed to wake manager for internal question",
    );
  }
}

export async function routeAgentQuestionsToManager(
  db: Db,
  input: RouteAgentQuestionInput,
): Promise<AgentQuestionRouteResult> {
  const cleanQuestions = input.questions.map((q) => q.trim()).filter(Boolean);
  const issue = await getIssue(db, input.issueId);
  if (!issue || issue.companyId !== input.companyId) throw notFound("Issue not found");
  const askingAgent = await getAgent(db, input.askingAgentId);
  if (!askingAgent || askingAgent.companyId !== input.companyId) throw notFound("Agent not found");

  if (cleanQuestions.length === 0) {
    return {
      routedToManager: false,
      routedToAgentId: null,
      routedCommentIds: [],
      issue,
      fallbackToUser: true,
      reason: "no_questions",
    };
  }
  if ((TERMINAL_ISSUE_STATUSES as readonly string[]).includes(issue.status)) {
    return {
      routedToManager: false,
      routedToAgentId: null,
      routedCommentIds: [],
      issue,
      fallbackToUser: true,
      reason: "terminal_issue",
    };
  }
  if (isCoordinatorAgent(askingAgent)) {
    return {
      routedToManager: false,
      routedToAgentId: null,
      routedCommentIds: [],
      issue,
      fallbackToUser: true,
      reason: "coordinator_can_escalate",
    };
  }

  const target = await resolveManagerTarget(db, issue, askingAgent);
  if (!target) {
    return {
      routedToManager: false,
      routedToAgentId: null,
      routedCommentIds: [],
      issue,
      fallbackToUser: true,
      reason: "no_manager_target",
    };
  }

  const existingRows = await db
    .select({ id: issueComments.id, body: issueComments.body })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, issue.id),
        eq(issueComments.kind, "manager_question"),
        isNull(issueComments.answeredAt),
      ),
    );
  const existingIdByKey = new Map(
    existingRows.map((row) => [row.body.toLowerCase().replace(/\s+/g, " ").trim(), row.id]),
  );
  const existingKeys = new Set(existingIdByKey.keys());
  const newQuestions = cleanQuestions.filter((question) => {
    const key = question.toLowerCase().replace(/\s+/g, " ").trim();
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });

  const insertedCommentIds: string[] = [];
  for (const question of newQuestions) {
    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: issue.id,
        authorAgentId: askingAgent.id,
        authorUserId: null,
        body: question,
        kind: "manager_question",
        choices: input.choices && input.choices.length > 0 ? input.choices : null,
      })
      .returning({ id: issueComments.id });
    if (comment) insertedCommentIds.push(comment.id);
  }

  const wakeCommentIds = insertedCommentIds.length > 0
    ? insertedCommentIds
    : cleanQuestions
        .map((question) => existingIdByKey.get(question.toLowerCase().replace(/\s+/g, " ").trim()))
        .filter((id): id is string => typeof id === "string");
  const questionsForWake = newQuestions.length > 0 ? newQuestions : cleanQuestions;
  const firstQuestion = questionsForWake[0] ?? "Internal question";
  const previousStatus = issue.status;
  const updated = await db
    .update(issues)
    .set({
      status: "blocked",
      blockedSource: "agent",
      blockedReason: `Waiting on EM/manager: ${compactText(firstQuestion, 900)}`,
      blockedAt: new Date(),
      awaitingUserSince: null,
      latestUserFacingAgentMessage: null,
      checkoutRunId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issues.id, issue.id),
        notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES] as string[]),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? issue);

  if (updated.status !== previousStatus) {
    await notifyParentOnChildStatus(db, {
      child: updated,
      previousStatus,
      actor: input.actor ?? { actorType: "agent", actorId: askingAgent.id },
    });
  }

  await wakeManagerForInternalQuestion(db, {
    targetAgentId: target.agent.id,
    issue: updated,
    askingAgentId: askingAgent.id,
    commentIds: wakeCommentIds,
    questions: questionsForWake,
    routeSource: target.source,
    actor: input.actor ?? { actorType: "agent", actorId: askingAgent.id },
  });

  return {
    routedToManager: true,
    routedToAgentId: target.agent.id,
    routedCommentIds: wakeCommentIds,
    issue: updated,
    fallbackToUser: false,
  };
}

async function assertActorCanAnswerInternalQuestion(
  db: Db,
  issue: IssueRow,
  actor: InternalQuestionAnswerInput["actor"],
) {
  if (actor.actorType === "user" || actor.actorType === "system") return;
  if (!actor.agentId) throw forbidden("Agent identity required");
  const answeringAgent = await getAgent(db, actor.agentId);
  if (!answeringAgent || answeringAgent.companyId !== issue.companyId) throw forbidden("Agent cannot answer this issue");
  if (isCoordinatorAgent(answeringAgent)) return;
  if (!issue.assigneeAgentId) throw forbidden("Only a manager or coordinator may answer internal questions");

  const allAgents = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.companyId, issue.companyId));
  const byId = new Map(allAgents.map((agent) => [agent.id, agent]));
  let cursor = byId.get(issue.assigneeAgentId)?.reportsTo ?? null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === answeringAgent.id) return;
    seen.add(cursor);
    cursor = byId.get(cursor)?.reportsTo ?? null;
  }
  throw forbidden("Only a manager or coordinator may answer internal questions");
}

export async function answerInternalManagerQuestion(
  db: Db,
  input: InternalQuestionAnswerInput,
) {
  const answer = input.answer.trim();
  if (!answer) throw unprocessable("answer is required");
  const issue = await getIssue(db, input.issueId);
  if (!issue || issue.companyId !== input.companyId) throw notFound("Issue not found");
  await assertActorCanAnswerInternalQuestion(db, issue, input.actor);

  const question = await db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.id, input.questionCommentId),
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, issue.id),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!question) throw notFound("Internal question not found");
  if (question.kind !== "manager_question") throw unprocessable("Comment is not an internal manager question");
  if (question.answeredAt) throw unprocessable("Internal manager question is already answered");

  const body = input.assumption ? `Assumption: ${answer}` : answer;
  const [answerComment] = await db
    .insert(issueComments)
    .values({
      companyId: input.companyId,
      issueId: issue.id,
      authorAgentId: input.actor.actorType === "agent" ? input.actor.agentId ?? null : null,
      authorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
      body,
      kind: "manager_answer",
    })
    .returning();

  const now = new Date();
  await db
    .update(issueComments)
    .set({ answeredAt: now, answeredCommentId: answerComment.id, updatedAt: now })
    .where(eq(issueComments.id, question.id));

  // ---- HOOK 1 mirror: internal manager-answer capture (CENTRAL_CONTEXT_DB_PLAN §4.1) ----
  // Best-effort: a capture failure must NEVER fail the answer flow. The trust gate keys
  // on the CODE FLAG input.assumption (§3.4 / §4.1), never on the "Assumption:" body
  // prefix at :405. A genuine answer (assumption=false) → human-answer/verified; an
  // assumption-flagged answer (assumption=true) is an agent CLAIM the human merely
  // waved through → forced provenance='agent-claim'/verificationState='unverified' so it
  // can never be retrieved as a vetted fact.
  try {
    const isAssumption = input.assumption === true;
    const questionText = (question.body ?? "").trim() || "(question unavailable)";
    const subject = questionText.slice(0, 480);
    // Redaction gate (§4.4): scan the answer body BEFORE write. A finding always
    // quarantines to needs_review (overrides verified) so a secret never lands verified.
    const scan = scanBody(answer);
    const verificationState: "needs_review" | "unverified" | "verified" =
      scan.findings.length > 0 ? "needs_review" : isAssumption ? "unverified" : "verified";
    await memoryService(db).createEntry({
      companyId: input.companyId,
      layer: "workspace",
      kind: "fact",
      subject,
      body: `Q: ${questionText}\nA: ${scan.clean}`,
      source: `human-answer:${issue.id}:${answerComment.id}`,
      provenance: isAssumption ? "agent-claim" : "human-answer",
      verificationState,
      confidence: isAssumption ? 0.5 : 0.95,
      // authorType is deliberately stamped 'user' to represent the human Q&A channel
      // regardless of the proxying actor (the answering actor may be an EM agent). Trust
      // here is governed solely by the explicit provenance + verificationState above
      // (the input.assumption flag), NOT by authorType — so a future reader should not
      // treat this 'user' as "a human typed this".
      authorType: "user",
      authorId: input.actor.actorId,
      sourceRefType: "comment",
      sourceRefId: answerComment.id,
      createdBy: input.actor.actorId,
    });
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "HOOK 1 internal manager-answer capture failed (best-effort)");
  }

  const remainingOpen = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, issue.id),
        eq(issueComments.kind, "manager_question"),
        isNull(issueComments.answeredAt),
      ),
    )
    .then((rows) => Number(rows[0]?.count ?? 0));

  let updatedIssue = issue;
  if (remainingOpen === 0 && issue.status === "blocked" && issue.blockedSource === "agent") {
    const [updated] = await db
      .update(issues)
      .set({
        status: issue.assigneeAgentId || issue.assigneeUserId ? "in_progress" : "todo",
        startedAt: issue.assigneeAgentId || issue.assigneeUserId ? issue.startedAt ?? new Date() : issue.startedAt,
        completedAt: null,
        cancelledAt: null,
        blockedSource: null,
        blockedReason: null,
        blockedAt: null,
        awaitingUserSince: null,
        latestUserFacingAgentMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id))
      .returning();
    if (updated) updatedIssue = updated;
  }

  let wakeRunId: string | null = null;
  if (updatedIssue.assigneeAgentId) {
    try {
      const { heartbeatService } = await import("./heartbeat.js");
      const run = await heartbeatService(db).wakeup(updatedIssue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "manager_question_answered",
        payload: {
          issueId: updatedIssue.id,
          commentId: answerComment.id,
          managerQuestionCommentId: question.id,
          managerAnswerCommentId: answerComment.id,
        },
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
        contextSnapshot: {
          issueId: updatedIssue.id,
          taskId: updatedIssue.id,
          taskKey: updatedIssue.identifier ?? updatedIssue.id,
          commentId: answerComment.id,
          wakeCommentId: answerComment.id,
          wakeReason: "manager_question_answered",
          source: "issue.internal_question_answer",
          managerQuestionCommentId: question.id,
          managerAnswerCommentId: answerComment.id,
          managerAnswerBody: body,
          managerAssumption: input.assumption === true,
        },
      });
      wakeRunId = run?.id ?? null;
    } catch (err) {
      logger.warn({ err, issueId: updatedIssue.id }, "failed to wake child assignee after internal answer");
    }
  }

  return {
    issue: updatedIssue,
    questionComment: question,
    answerComment,
    remainingOpen,
    wakeRunId,
  };
}
