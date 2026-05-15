import type { Issue, IssueComment } from "@combyne/shared";

export function isUserFacingQuestion(comment: Pick<IssueComment, "kind" | "answeredAt">) {
  return comment.kind === "question" && !comment.answeredAt;
}

export function isOpenManagerQuestion(comment: Pick<IssueComment, "kind" | "answeredAt">) {
  return comment.kind === "manager_question" && !comment.answeredAt;
}

export function timelineCommentLabel(comment: Pick<IssueComment, "kind" | "answeredAt">): string | null {
  if (comment.kind === "manager_question") {
    return comment.answeredAt ? "Internal blocker resolved" : "Internal blocker";
  }
  if (comment.kind === "manager_answer") return "EM answer";
  if (comment.kind === "question") return comment.answeredAt ? "Question answered" : "User question";
  if (comment.kind === "answer") return "User answer";
  return null;
}

export function blockedIssueTitle(
  issue: Pick<Issue, "blockedSource">,
  openManagerQuestionCount: number,
) {
  if (issue.blockedSource === "human") return "Blocked by board/user";
  if (openManagerQuestionCount > 0) return "Waiting on EM/manager";
  return "Blocked";
}

export function blockedIssueDescription(
  issue: Pick<Issue, "blockedSource" | "blockedReason">,
  openManagerQuestionCount: number,
) {
  const suffix = issue.blockedReason ? ` Reason: ${issue.blockedReason}` : "";
  if (issue.blockedSource === "human") {
    return `Agent timers and normal assignment wakes will skip this issue until a human comment or status change reopens it.${suffix}`;
  }
  if (openManagerQuestionCount > 0) {
    return `A sub-agent asked an internal question. The EM/manager should answer from context or document a reasonable assumption before the assignee resumes.${suffix}`;
  }
  return `This issue is blocked by the agent or system and should be reviewed before resuming.${suffix}`;
}
