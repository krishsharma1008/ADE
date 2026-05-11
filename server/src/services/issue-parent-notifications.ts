import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agents, issueComments, issues, qaFeedbackEvents } from "@combyne/db";
import { logger } from "../middleware/logger.js";

type Actor = {
  actorType: "user" | "agent" | "system";
  actorId: string | null;
};

type IssueLike = {
  id: string;
  companyId: string;
  parentId: string | null;
  identifier?: string | null;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
};

const PARENT_WAKE_STATUSES = new Set(["done", "blocked", "awaiting_user"]);
const COMMENT_SNIPPET_CHARS = 480;
const FEEDBACK_SNIPPET_CHARS = 700;

type ChildHandoffDigest = {
  childIssueId: string;
  parentIssueId: string;
  childLabel: string;
  childTitle: string;
  childStatus: string;
  assignee: { id: string; name: string } | null;
  latestComments: Array<{
    commentId: string | null;
    kind: string;
    authorAgentId: string | null;
    authorName: string | null;
    excerpt: string;
  }>;
  openQuestions: string[];
  qaFeedback: Array<{
    feedbackId: string;
    status: string;
    severity: string;
    title: string;
    excerpt: string;
  }>;
  recommendedNextAction: string;
};

function issueLabel(issue: IssueLike) {
  return issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
}

function compactText(value: string | null | undefined, maxChars = COMMENT_SNIPPET_CHARS) {
  const compacted = (value ?? "").trim().replace(/\s+/g, " ");
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, maxChars - 1).trimEnd()}…`;
}

function statusPhrase(status: string) {
  if (status === "done") return "completed";
  if (status === "blocked") return "is blocked";
  if (status === "awaiting_user") return "is waiting for user input";
  return `moved to ${status}`;
}

function buildRecommendedNextAction(
  child: IssueLike,
  input: Pick<ChildHandoffDigest, "openQuestions" | "qaFeedback" | "latestComments">,
  wakeReason: string,
) {
  if (input.openQuestions.length > 0 || child.status === "awaiting_user") {
    return "Resolve or route the open question from the child issue. If the answer is available from parent/child context, answer it yourself and wake the child assignee; ask a human only for a genuinely missing product decision.";
  }
  if (child.status === "blocked") {
    return "Review the blocker from the child issue, unblock or reassign the next fix, and keep the parent moving without waiting for a manual reminder.";
  }
  if (input.qaFeedback.length > 0) {
    return "Review the QA/review feedback below, assign or fix the requested changes, and only ask a human if the feedback contains a real product decision.";
  }
  if (child.status === "done") {
    return "Use the child handoff below to continue the parent workflow. For small implementation follow-ups, assign or fix the next step directly without a human nudge.";
  }
  if (wakeReason === "child_issue_commented") {
    return "Treat the child update as actionable context for the parent issue. Decide whether to continue, reassign, or close the loop now.";
  }
  return "Review the child handoff and advance the parent issue to the next concrete step.";
}

async function buildChildHandoffDigest(
  db: Db,
  input: {
    parentIssueId: string;
    child: IssueLike;
    wakeReason: string;
    sourceCommentId?: string | null;
    sourceCommentBody?: string | null;
  },
): Promise<ChildHandoffDigest> {
  const latestRows = await db
    .select({
      id: issueComments.id,
      kind: issueComments.kind,
      authorAgentId: issueComments.authorAgentId,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, input.child.companyId), eq(issueComments.issueId, input.child.id)))
    .orderBy(desc(issueComments.createdAt))
    .limit(6);

  const openQuestionRows = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.child.companyId),
        eq(issueComments.issueId, input.child.id),
        eq(issueComments.kind, "question"),
        isNull(issueComments.answeredAt),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(5);

  const qaFeedbackRows = await db
    .select({
      id: qaFeedbackEvents.id,
      status: qaFeedbackEvents.status,
      severity: qaFeedbackEvents.severity,
      title: qaFeedbackEvents.title,
      body: qaFeedbackEvents.body,
      updatedAt: qaFeedbackEvents.updatedAt,
    })
    .from(qaFeedbackEvents)
    .where(and(eq(qaFeedbackEvents.companyId, input.child.companyId), eq(qaFeedbackEvents.issueId, input.child.id)))
    .orderBy(desc(qaFeedbackEvents.updatedAt))
    .limit(3);

  const agentIds = new Set<string>();
  if (input.child.assigneeAgentId) agentIds.add(input.child.assigneeAgentId);
  for (const row of latestRows) {
    if (row.authorAgentId) agentIds.add(row.authorAgentId);
  }
  const agentRows =
    agentIds.size > 0
      ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, [...agentIds]))
      : [];
  const agentNameById = new Map(agentRows.map((row) => [row.id, row.name]));

  const latestComments = latestRows
    .map((row) => ({
      commentId: row.id,
      kind: row.kind,
      authorAgentId: row.authorAgentId,
      authorName: row.authorAgentId ? agentNameById.get(row.authorAgentId) ?? null : null,
      excerpt: compactText(row.body),
    }))
    .filter((row) => row.excerpt.length > 0);

  if (
    input.sourceCommentId &&
    input.sourceCommentBody?.trim() &&
    !latestComments.some((row) => row.commentId === input.sourceCommentId)
  ) {
    latestComments.unshift({
      commentId: input.sourceCommentId,
      kind: "comment",
      authorAgentId: null,
      authorName: null,
      excerpt: compactText(input.sourceCommentBody),
    });
  }

  const digest: ChildHandoffDigest = {
    childIssueId: input.child.id,
    parentIssueId: input.parentIssueId,
    childLabel: issueLabel(input.child),
    childTitle: input.child.title,
    childStatus: input.child.status,
    assignee: input.child.assigneeAgentId
      ? {
          id: input.child.assigneeAgentId,
          name: agentNameById.get(input.child.assigneeAgentId) ?? "Assigned agent",
        }
      : null,
    latestComments: latestComments.slice(0, 5),
    openQuestions: openQuestionRows.map((row) => compactText(row.body)).filter(Boolean),
    qaFeedback: qaFeedbackRows.map((row) => ({
      feedbackId: row.id,
      status: row.status,
      severity: row.severity,
      title: row.title,
      excerpt: compactText(row.body, FEEDBACK_SNIPPET_CHARS),
    })),
    recommendedNextAction: "",
  };
  digest.recommendedNextAction = buildRecommendedNextAction(input.child, digest, input.wakeReason);
  return digest;
}

function renderParentHandoffComment(digest: ChildHandoffDigest) {
  const lines: string[] = [];
  lines.push(`Child issue **${digest.childLabel}** ${statusPhrase(digest.childStatus)} and needs parent follow-up.`);
  lines.push("");
  lines.push("### Recommended next action");
  lines.push(digest.recommendedNextAction);
  lines.push("");
  lines.push("### Handoff digest");
  lines.push(`- Status: \`${digest.childStatus}\``);
  lines.push(`- Assignee: ${digest.assignee?.name ?? "Unassigned"}`);
  lines.push(`- Open questions: ${digest.openQuestions.length}`);
  lines.push(`- QA/review feedback items: ${digest.qaFeedback.length}`);

  if (digest.qaFeedback.length > 0) {
    lines.push("", "### QA/review feedback");
    for (const item of digest.qaFeedback) {
      lines.push(`- **${item.title}** (${item.severity}, ${item.status}): ${item.excerpt}`);
    }
  }

  if (digest.openQuestions.length > 0) {
    lines.push("", "### Open questions");
    for (const question of digest.openQuestions) lines.push(`- ${question}`);
  }

  if (digest.latestComments.length > 0) {
    lines.push("", "### Latest child context");
    for (const item of digest.latestComments) {
      const author = item.authorName ? `${item.authorName}, ` : "";
      lines.push(`- ${author}${item.kind}: ${item.excerpt}`);
    }
  }

  return lines.join("\n");
}

async function postParentCommentAndWake(
  db: Db,
  input: {
    parentId: string;
    child: IssueLike;
    wakeReason: string;
    actor: Actor;
    sourceCommentId?: string | null;
    sourceCommentBody?: string | null;
  },
) {
  const parent = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.id, input.parentId))
    .then((rows) => rows[0] ?? null);
  if (!parent || parent.companyId !== input.child.companyId) return null;

  const digest = await buildChildHandoffDigest(db, {
    parentIssueId: parent.id,
    child: input.child,
    wakeReason: input.wakeReason,
    sourceCommentId: input.sourceCommentId,
    sourceCommentBody: input.sourceCommentBody,
  });
  const body = renderParentHandoffComment(digest);

  const [comment] = await db
    .insert(issueComments)
    .values({
      companyId: parent.companyId,
      issueId: parent.id,
      authorAgentId: null,
      authorUserId: null,
      body,
      kind: "system",
    })
    .returning({ id: issueComments.id });

  if (parent.assigneeAgentId && parent.status !== "done" && parent.status !== "cancelled") {
    try {
      const { heartbeatService } = await import("./heartbeat.js");
      await heartbeatService(db).wakeup(parent.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: input.wakeReason,
        payload: {
          issueId: parent.id,
          parentIssueId: parent.id,
          childIssueId: input.child.id,
          childIssueStatus: input.child.status,
          commentId: comment?.id ?? null,
          sourceCommentId: input.sourceCommentId ?? null,
          childDigest: digest,
          recommendedNextAction: digest.recommendedNextAction,
        },
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
        contextSnapshot: {
          issueId: parent.id,
          taskId: parent.id,
          parentIssueId: parent.id,
          childIssueId: input.child.id,
          childIssueStatus: input.child.status,
          commentId: comment?.id ?? null,
          wakeCommentId: comment?.id ?? null,
          sourceCommentId: input.sourceCommentId ?? null,
          wakeReason: input.wakeReason,
          source: "issue.child_notification",
          childDigest: digest,
          recommendedNextAction: digest.recommendedNextAction,
        },
      });
    } catch (err) {
      logger.warn(
        { err, parentIssueId: parent.id, childIssueId: input.child.id },
        "failed to wake parent issue assignee",
      );
    }
  }

  return comment ?? null;
}

export async function notifyParentOnChildStatus(
  db: Db,
  input: {
    child: IssueLike;
    previousStatus: string | null;
    actor: Actor;
  },
) {
  if (!input.child.parentId) return null;
  if (!PARENT_WAKE_STATUSES.has(input.child.status)) return null;
  if (input.previousStatus === input.child.status) return null;
  return postParentCommentAndWake(db, {
    parentId: input.child.parentId,
    child: input.child,
    wakeReason: `child_issue_${input.child.status}`,
    actor: input.actor,
  });
}

export async function notifyParentOnChildAgentComment(
  db: Db,
  input: {
    child: IssueLike;
    commentId: string;
    commentBody: string;
    actorAgentId: string | null;
    actor: Actor;
  },
) {
  if (!input.child.parentId || !input.actorAgentId) return null;
  const parent = await db
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(eq(issues.id, input.child.parentId))
    .then((rows) => rows[0] ?? null);
  if (parent?.assigneeAgentId === input.actorAgentId) return null;
  if (!input.commentBody.trim()) return null;
  return postParentCommentAndWake(db, {
    parentId: input.child.parentId,
    child: input.child,
    wakeReason: "child_issue_commented",
    actor: input.actor,
    sourceCommentId: input.commentId,
    sourceCommentBody: input.commentBody,
  });
}
