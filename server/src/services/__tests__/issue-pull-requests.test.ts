import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, approvals, companies, companyIntegrations, heartbeatRuns, issueComments, issuePullRequests, issues } from "@combyne/db";
import { issuePullRequestService } from "../issue-pull-requests.js";
import { heartbeatService } from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("issue pull request service", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Issue PR Test Co", issuePrefix: "IPR" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", adapterType: "process" })
      .returning();
    agentId = agent.id;
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Implement safe PR merge",
        status: "in_progress",
        assigneeAgentId: agentId,
      })
      .returning();
    issueId = issue.id;
    await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running", invocationSource: "on_demand" });
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("tracks a PR idempotently, creates merge_pr approval, and moves issue to review", async () => {
    const svc = issuePullRequestService(handle.db);
    const first = await svc.upsertForIssue({
      companyId,
      issueId,
      requestedByAgentId: agentId,
      repo: "combyne/ade",
      pullNumber: 123,
      pullUrl: "https://github.com/combyne/ade/pull/123",
      title: "feat: safe PR merge",
      baseBranch: "development",
      headBranch: "feat/safe-pr-merge",
      headSha: "abc123",
      mergeMethod: "squash",
    });

    expect(first.approvalId).toBeTruthy();
    expect(first.mergeStatus).toBe("pending");
    const [approval] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, first.approvalId!));
    expect(approval.type).toBe("merge_pr");
    expect(approval.status).toBe("pending");
    expect((approval.payload as Record<string, unknown>).expectedHeadSha).toBe("abc123");

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_review");

    const second = await svc.upsertForIssue({
      companyId,
      issueId,
      requestedByAgentId: agentId,
      repo: "combyne/ade",
      pullNumber: 123,
      pullUrl: "https://github.com/combyne/ade/pull/123",
      title: "feat: safe PR merge updated",
      baseBranch: "development",
      headBranch: "feat/safe-pr-merge",
      headSha: "def456",
      mergeMethod: "squash",
    });

    expect(second.id).toBe(first.id);
    expect(second.approvalId).toBe(first.approvalId);
    const rows = await handle.db
      .select()
      .from(issuePullRequests)
      .where(
        and(
          eq(issuePullRequests.companyId, companyId),
          eq(issuePullRequests.repo, "combyne/ade"),
          eq(issuePullRequests.pullNumber, 123),
        ),
      );
    expect(rows).toHaveLength(1);

    const [updatedApproval] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, first.approvalId!));
    expect((updatedApproval.payload as Record<string, unknown>).expectedHeadSha).toBe("def456");
  });

  function mockGitHub(pullNumber: number, headSha: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes(`/pulls/${pullNumber}/reviews`)) {
        return new Response(JSON.stringify([
          {
            id: 1,
            user: { login: "reviewer" },
            state: "CHANGES_REQUESTED",
            body: "Please fix validation.",
            submitted_at: "2026-05-06T00:00:00Z",
          },
        ]), { status: 200 });
      }
      if (href.includes(`/commits/${headSha}/check-runs`)) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (href.includes(`/pulls/${pullNumber}`)) {
        return new Response(JSON.stringify({
          id: pullNumber,
          number: pullNumber,
          title: "fix: review feedback",
          body: null,
          state: "open",
          draft: false,
          user: { login: "engineer" },
          head: { ref: "fix/review-feedback", sha: headSha },
          base: { ref: "development" },
          merged: false,
          mergeable: true,
          merge_commit_sha: null,
          merged_at: null,
          created_at: "2026-05-06T00:00:00Z",
          updated_at: "2026-05-06T00:00:00Z",
          html_url: `https://github.com/combyne/ade/pull/${pullNumber}`,
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
  }

  function prFeedbackRuns(runs: Array<typeof heartbeatRuns.$inferSelect>, issuePullRequestId: string) {
    return runs.filter((run) => {
      const context = run.contextSnapshot as Record<string, unknown> | null;
      return context?.wakeReason === "pr_feedback" && context?.issuePullRequestId === issuePullRequestId;
    });
  }

  it("holds review feedback for a human by default, then dispatches after a board opt-in", async () => {
    const svc = issuePullRequestService(handle.db);
    await handle.db
      .insert(companyIntegrations)
      .values({
        companyId,
        provider: "github",
        enabled: "true",
        config: {
          baseUrl: "https://api.github.test",
          owner: "combyne",
          token: "test-token",
          defaultRepo: "ade",
        },
      })
      .onConflictDoNothing();

    const pr = await svc.upsertForIssue({
      companyId,
      issueId,
      requestedByAgentId: agentId,
      repo: "ade",
      pullNumber: 456,
      pullUrl: "https://github.com/combyne/ade/pull/456",
      title: "fix: review feedback",
      baseBranch: "development",
      headBranch: "fix/review-feedback",
      headSha: "feed123",
      mergeMethod: "squash",
    });

    const fetchSpy = mockGitHub(456, "feed123");
    try {
      // Default behavior: the feedback comment is posted, but the agent is NOT woken —
      // it is held for the human (the user left the PR unapproved).
      const first = await svc.dispatchFeedbackToAssignee(pr.id, {
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(first.sent).toBe(true);
      expect(first.held).toBe(true);
      expect(first.holdReason).toBe("awaiting_human_optin");
      expect(first.wakeRunId).toBeNull();

      const comments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.filter((c) => c.body.includes("PR feedback for `ade#456`")).length).toBe(1);

      let runs = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(prFeedbackRuns(runs, pr.id).length).toBe(0);

      let [held] = await handle.db.select().from(issuePullRequests).where(eq(issuePullRequests.id, pr.id));
      expect(held.feedbackStatus).toBe("awaiting_human");

      // Repeat poll with identical feedback: no second comment, still no wake.
      const second = await svc.dispatchFeedbackToAssignee(pr.id, {
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(second.sent).toBe(false);
      expect(second.wakeRunId).toBeNull();
      const deduped = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(deduped.filter((c) => c.body.includes("PR feedback for `ade#456`")).length).toBe(1);

      // Board releases this round (one-shot): the assignee is woken to address the pending
      // feedback, with no duplicate comment, a round is recorded, and the wake carries the
      // original feedback comment as its anchor (so it produces an actionable follow-up
      // even if the agent is mid-run).
      const optIn = await svc.setFeedbackOptIn(pr.id, true, {
        requestedByActorType: "user",
        requestedByActorId: "board-user",
      });
      expect(optIn.dispatched?.wakeRunId).toBeTruthy();

      runs = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      const dispatchedRuns = prFeedbackRuns(runs, pr.id);
      expect(dispatchedRuns.length).toBe(1);
      expect((dispatchedRuns[0].contextSnapshot as Record<string, unknown>).wakeCommentId).toBeTruthy();
      const afterOptIn = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(afterOptIn.filter((c) => c.body.includes("PR feedback for `ade#456`")).length).toBe(1);

      [held] = await handle.db.select().from(issuePullRequests).where(eq(issuePullRequests.id, pr.id));
      const meta = held.metadata as Record<string, unknown>;
      // One-shot: no persistent opt-in flag is stored; one round was recorded.
      expect(meta.autoFeedbackOptIn).toBeUndefined();
      expect(meta.feedbackRounds).toBe(1);
      expect(held.feedbackStatus).toBe("sent");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("re-holds in autopilot mode once the round cap is reached", async () => {
    const svc = issuePullRequestService(handle.db);
    const pr = await svc.upsertForIssue({
      companyId,
      issueId,
      requestedByAgentId: agentId,
      repo: "ade",
      pullNumber: 789,
      pullUrl: "https://github.com/combyne/ade/pull/789",
      title: "fix: more review feedback",
      baseBranch: "development",
      headBranch: "fix/more-feedback",
      headSha: "cap123",
      mergeMethod: "squash",
    });

    // Already at the default cap of 3 auto-rounds.
    await handle.db
      .update(issuePullRequests)
      .set({ metadata: { feedbackRounds: 3 } })
      .where(eq(issuePullRequests.id, pr.id));

    const prev = process.env.COMBYNE_PR_FEEDBACK_AUTOPILOT;
    process.env.COMBYNE_PR_FEEDBACK_AUTOPILOT = "true";
    const fetchSpy = mockGitHub(789, "cap123");
    try {
      // Automatic (poll-driven) path, no forceWake: the cap applies and re-holds.
      const result = await svc.dispatchFeedbackToAssignee(pr.id, {
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(result.held).toBe(true);
      expect(result.holdReason).toBe("max_rounds_reached");
      expect(result.wakeRunId).toBeNull();

      const runs = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(prFeedbackRuns(runs, pr.id).length).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      if (prev === undefined) delete process.env.COMBYNE_PR_FEEDBACK_AUTOPILOT;
      else process.env.COMBYNE_PR_FEEDBACK_AUTOPILOT = prev;
    }
  });

  it("freezes automatic wakeups on an issue whose PR is awaiting human review", async () => {
    const hb = heartbeatService(handle.db);

    // Parent + child issues, child carries a PR held for human review.
    const [parentIssue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Parent epic", status: "in_progress", assigneeAgentId: agentId })
      .returning();
    const [childIssue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Child implementation",
        status: "in_review",
        assigneeAgentId: agentId,
        parentId: parentIssue.id,
      })
      .returning();
    await handle.db.insert(issuePullRequests).values({
      companyId,
      issueId: childIssue.id,
      provider: "github",
      repo: "ade",
      pullNumber: 901,
      pullUrl: "https://github.com/combyne/ade/pull/901",
      title: "fix: child work",
      baseBranch: "development",
      feedbackStatus: "awaiting_human",
      mergeStatus: "blocked",
    });

    async function skipCount(reason: string) {
      const rows = await handle.db
        .select()
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, reason)));
      return rows.length;
    }

    // 1. Automatic delegation re-wake targeting the held child issue is suppressed.
    const automatic = await hb.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "delegation_required",
      requestedByActorType: "system",
      requestedByActorId: "test",
      contextSnapshot: { issueId: childIssue.id },
    });
    expect(automatic).toBeNull();
    expect(await skipCount("issue.pr_review_hold")).toBe(1);

    // 2. Parent-coordinator re-wake (issue scope = parent, childIssueId = held child) is
    //    also suppressed — this is the CEO auto-delegation churn from the scenario.
    const parentWake = await hb.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "child_completed",
      requestedByActorType: "system",
      requestedByActorId: "test",
      payload: { issueId: parentIssue.id, childIssueId: childIssue.id },
      contextSnapshot: { issueId: parentIssue.id, childIssueId: childIssue.id },
    });
    expect(parentWake).toBeNull();
    expect(await skipCount("issue.pr_review_hold")).toBe(2);

    // 3. A human (board) action on the held issue is NOT suppressed — it passes the gate.
    const humanWake = await hb.wakeup(agentId, {
      source: "automation",
      triggerDetail: "manual",
      reason: "pr_feedback",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: { issueId: childIssue.id },
    });
    expect(humanWake).not.toBeNull();
    // No additional review-hold skip was written for the human action.
    expect(await skipCount("issue.pr_review_hold")).toBe(2);

    // 4. A second, NON-held PR on the same issue: a wake aimed specifically at it must NOT
    //    be frozen by the sibling held PR (an issue can carry multiple PRs).
    const [siblingPr] = await handle.db
      .insert(issuePullRequests)
      .values({
        companyId,
        issueId: childIssue.id,
        provider: "github",
        repo: "ade",
        pullNumber: 902,
        pullUrl: "https://github.com/combyne/ade/pull/902",
        title: "fix: sibling work",
        baseBranch: "development",
        feedbackStatus: "idle",
        mergeStatus: "pending",
      })
      .returning();
    const siblingWake = await hb.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "pr_feedback",
      requestedByActorType: "system",
      requestedByActorId: "test",
      payload: { issueId: childIssue.id, issuePullRequestId: siblingPr.id },
      contextSnapshot: { issueId: childIssue.id, issuePullRequestId: siblingPr.id },
    });
    expect(siblingWake).not.toBeNull();
    expect(await skipCount("issue.pr_review_hold")).toBe(2);

    // 5. A generic timer heartbeat (no issue scope) for an assignee who holds a PR awaiting
    //    review is frozen too, closing the timer-tick residual.
    const timerWake = await hb.wakeup(agentId, {
      source: "timer",
      triggerDetail: "ping",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(timerWake).toBeNull();
    expect(await skipCount("issue.pr_review_hold")).toBe(3);
  });
});
