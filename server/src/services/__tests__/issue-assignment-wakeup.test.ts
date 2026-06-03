import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  it("threads taskId into the wakeup contextSnapshot so COMBYNE_TASK_ID can be injected", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-123", assigneeAgentId: "agent-1", status: "todo" },
      reason: "assigned",
      mutation: "assignee_changed",
      contextSource: "issue_assignment",
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    const [agentId, opts] = wakeup.mock.calls[0];
    expect(agentId).toBe("agent-1");
    const snapshot = opts.contextSnapshot as Record<string, unknown>;
    // Without taskId the skill gate can never evaluate originKind="pr_review_requested".
    expect(snapshot.taskId).toBe("issue-123");
    expect(snapshot.issueId).toBe("issue-123");
    expect(snapshot.source).toBe("issue_assignment");
  });

  it("does not wake when the issue has no assignee or is in backlog", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: null, status: "todo" },
      reason: "assigned",
      mutation: "assignee_changed",
      contextSource: "issue_assignment",
    });
    queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-2", assigneeAgentId: "agent-1", status: "backlog" },
      reason: "assigned",
      mutation: "assignee_changed",
      contextSource: "issue_assignment",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
