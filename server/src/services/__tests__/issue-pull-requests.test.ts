import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, approvals, companies, companyIntegrations, heartbeatRuns, issueComments, issuePullRequests, issues } from "@combyne/db";
import { issuePullRequestService } from "../issue-pull-requests.js";
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

  it("dispatches changed PR feedback to the assignee idempotently", async () => {
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

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes("/pulls/456/reviews")) {
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
      if (href.includes("/commits/feed123/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (href.includes("/pulls/456")) {
        return new Response(JSON.stringify({
          id: 456,
          number: 456,
          title: "fix: review feedback",
          body: null,
          state: "open",
          draft: false,
          user: { login: "engineer" },
          head: { ref: "fix/review-feedback", sha: "feed123" },
          base: { ref: "development" },
          merged: false,
          mergeable: true,
          merge_commit_sha: null,
          merged_at: null,
          created_at: "2026-05-06T00:00:00Z",
          updated_at: "2026-05-06T00:00:00Z",
          html_url: "https://github.com/combyne/ade/pull/456",
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const first = await svc.dispatchFeedbackToAssignee(pr.id, {
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(first.sent).toBe(true);
      expect(first.wakeRunId).toBeTruthy();

      const comments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.filter((comment) => comment.body.includes("PR feedback for `ade#456`")).length).toBe(1);

      const runs = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.some((run) => {
        const context = run.contextSnapshot as Record<string, unknown> | null;
        return context?.wakeReason === "pr_feedback" && context?.wakeCommentId;
      })).toBe(true);

      const second = await svc.dispatchFeedbackToAssignee(pr.id, {
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(second.sent).toBe(false);
      const deduped = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(deduped.filter((comment) => comment.body.includes("PR feedback for `ade#456`")).length).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
