import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, approvals, companies, issuePullRequests, issues } from "@combyne/db";
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
});
