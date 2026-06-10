// F13 + F14 (e2e-run-2026-06-10 findings #13/#14, #1): reconcileOpenTrackedPrs is the
// scheduler-tick sweep that detects EXTERNAL (GitHub-direct) merges with no agent
// wakes in flight, and closeMergedTrackedIssue now batch-resolves EVERY actionable
// merge_pr approval linked to the issue (not just row.approvalId) plus backfills
// stale approvals on already-merged tracking rows.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  companyIntegrations,
  issueApprovals,
  issueComments,
  issuePullRequests,
  issues,
  memoryEntries,
} from "@combyne/db";
import { issuePullRequestService } from "../issue-pull-requests.js";
import { approvalService } from "../approvals.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("F13/F14: external-merge sweep + merge_pr approval batch-resolve", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Sweep Co", issuePrefix: "SWP" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", adapterType: "process" })
      .returning();
    agentId = agent.id;
    await handle.db.insert(companyIntegrations).values({
      companyId,
      provider: "github",
      enabled: "true",
      config: {
        baseUrl: "https://api.github.test",
        owner: "krish-buku",
        token: "test-token",
        defaultRepo: "fs-brick-service-test",
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMergedPr(pullNumber: number, headSha: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes(`/pulls/${pullNumber}/reviews`)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (href.includes("/check-runs")) {
        return new Response(
          JSON.stringify({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] }),
          { status: 200 },
        );
      }
      if (href.includes(`/pulls/${pullNumber}`)) {
        return new Response(
          JSON.stringify({
            id: pullNumber,
            number: pullNumber,
            title: `feat: swept change ${pullNumber}`,
            body: null,
            state: "closed",
            draft: false,
            user: { login: "engineer" },
            head: { ref: `feat/SWP-${pullNumber}/x`, sha: headSha },
            base: { ref: "staging", repo: { default_branch: "staging" } },
            merged: true,
            mergeable: true,
            merge_commit_sha: `merge-${pullNumber}`,
            merged_at: "2026-06-10T05:00:00Z",
            created_at: "2026-06-10T00:00:00Z",
            updated_at: "2026-06-10T05:00:00Z",
            html_url: `https://github.test/pull/${pullNumber}`,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
  }

  async function trackOpenPr(pullNumber: number) {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: `Swept ticket ${pullNumber}`, status: "in_progress", assigneeAgentId: agentId })
      .returning();
    const svc = issuePullRequestService(handle.db);
    const tracked = await svc.upsertForIssue({
      companyId,
      issueId: issue.id,
      requestedByAgentId: agentId,
      repo: "krish-buku/fs-brick-service-test",
      pullNumber,
      pullUrl: `https://github.test/pull/${pullNumber}`,
      title: `feat: swept change ${pullNumber}`,
      baseBranch: "staging",
      headBranch: `feat/SWP-${pullNumber}/x`,
      headSha: `sha-${pullNumber}`,
      mergeMethod: "squash",
    });
    return { svc, issue, tracked };
  }

  it("sweep detects an externally merged PR and runs the full close-out, incl. a second dangling approval", async () => {
    const { svc, issue, tracked } = await trackOpenPr(21);

    // A second, DANGLING merge_pr approval linked to the same issue (not the row's
    // approvalId) — the situation behind the stale "PR ready" cards.
    const dangling = await approvalService(handle.db).create(companyId, {
      type: "merge_pr",
      requestedByAgentId: agentId,
      requestedByUserId: null,
      status: "pending",
      payload: { repo: "krish-buku/fs-brick-service-test", pullNumber: 21, stale: true },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    await handle.db.insert(issueApprovals).values({
      companyId,
      issueId: issue.id,
      approvalId: dangling.id,
      linkedByAgentId: agentId,
      linkedByUserId: null,
    });

    mockMergedPr(21, "sha-21");
    const result = await svc.reconcileOpenTrackedPrs(companyId);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const [row] = await handle.db
      .select()
      .from(issuePullRequests)
      .where(eq(issuePullRequests.id, tracked.id));
    expect(row.mergeStatus).toBe("merged");

    const [closedIssue] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(closedIssue.status).toBe("done");

    const [primaryApproval] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, tracked.approvalId!));
    expect(primaryApproval.status).toBe("approved");
    const [danglingAfter] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, dangling.id));
    expect(danglingAfter.status).toBe("approved");

    const memory = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.source, `pr-approval:${tracked.approvalId}`));
    expect(memory).toHaveLength(1);
    expect(memory[0].verificationState).toBe("verified");
  });

  it("backfills stale pending approvals on ALREADY-merged tracking rows (issue already done)", async () => {
    const { svc, issue, tracked } = await trackOpenPr(22);
    mockMergedPr(22, "sha-22");
    await svc.reconcile(tracked.id); // merged + closed

    // Simulate the pre-fix world: a leftover pending merge_pr approval linked to the
    // (now done) issue, e.g. created by an older code path before batch-resolve existed.
    const stale = await approvalService(handle.db).create(companyId, {
      type: "merge_pr",
      requestedByAgentId: agentId,
      requestedByUserId: null,
      status: "pending",
      payload: { repo: "krish-buku/fs-brick-service-test", pullNumber: 22, leftover: true },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    await handle.db.insert(issueApprovals).values({
      companyId,
      issueId: issue.id,
      approvalId: stale.id,
      linkedByAgentId: agentId,
      linkedByUserId: null,
    });

    await svc.reconcileOpenTrackedPrs(companyId);

    const [resolved] = await handle.db.select().from(approvals).where(eq(approvals.id, stale.id));
    expect(resolved.status).toBe("approved");
  });

  it("memory body captured on merge contains no transient blocker text (audit C2)", async () => {
    const { svc, tracked } = await trackOpenPr(24);
    mockMergedPr(24, "sha-24");
    await svc.reconcile(tracked.id);

    const [entry] = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.source, `pr-approval:${tracked.approvalId}`));
    expect(entry).toBeTruthy();
    expect(entry.body).not.toContain("Blocking items");
    expect(entry.body).not.toContain("not merge-allowed");
    expect(entry.body).not.toContain("PR is not open");
    expect(entry.body).toContain("Accepted pattern");
  });

  it("PR closed WITHOUT merge: terminal tracking, approval rejected, comment + assignee wake (audit B1)", async () => {
    const { svc, issue, tracked } = await trackOpenPr(25);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes("/pulls/25/reviews")) return new Response(JSON.stringify([]), { status: 200 });
      if (href.includes("/check-runs"))
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (href.includes("/pulls/25")) {
        return new Response(
          JSON.stringify({
            id: 25, number: 25, title: "feat: abandoned", body: null,
            state: "closed", draft: false, user: { login: "engineer" },
            head: { ref: "feat/SWP-25/x", sha: "sha-25" },
            base: { ref: "staging", repo: { default_branch: "staging" } },
            merged: false, mergeable: null, merge_commit_sha: null, merged_at: null,
            created_at: "2026-06-10T00:00:00Z", updated_at: "2026-06-10T05:00:00Z",
            html_url: "https://github.test/pull/25",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await svc.reconcile(tracked.id);

    const [row] = await handle.db
      .select()
      .from(issuePullRequests)
      .where(eq(issuePullRequests.id, tracked.id));
    expect(row.mergeStatus).toBe("closed");

    const [approval] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, tracked.approvalId!));
    expect(approval.status).toBe("rejected");

    const comments = await handle.db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comments.some((c) => c.body.includes("WITHOUT being merged"))).toBe(true);

    // Terminal "closed" rows leave the sweep (audit B4): a second sweep makes no
    // GitHub call for this row — assert by checking it is not re-reconciled.
    const before = row.lastReconciledAt;
    await svc.reconcileOpenTrackedPrs(companyId);
    const [after] = await handle.db
      .select({ lastReconciledAt: issuePullRequests.lastReconciledAt })
      .from(issuePullRequests)
      .where(eq(issuePullRequests.id, tracked.id));
    expect(after.lastReconciledAt?.toISOString()).toBe(before?.toISOString());
  });

  it("multi-PR issue: first merge resolves its approval but does NOT close the issue (audit B3)", async () => {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Two-PR ticket", status: "in_progress", assigneeAgentId: agentId })
      .returning();
    const svc = issuePullRequestService(handle.db);
    const trackBoth = async (pullNumber: number) =>
      svc.upsertForIssue({
        companyId,
        issueId: issue.id,
        requestedByAgentId: agentId,
        repo: "krish-buku/fs-brick-service-test",
        pullNumber,
        pullUrl: `https://github.test/pull/${pullNumber}`,
        title: `feat: part ${pullNumber}`,
        baseBranch: "staging",
        headBranch: `feat/SWP-${pullNumber}/x`,
        headSha: `sha-${pullNumber}`,
        mergeMethod: "squash",
      });
    const prA = await trackBoth(26);
    await trackBoth(27);

    mockMergedPr(26, "sha-26");
    await svc.reconcile(prA.id);

    const [issueAfter] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(issueAfter.status).not.toBe("done");

    const [approvalA] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, prA.approvalId!));
    expect(approvalA.status).toBe("approved");

    const comments = await handle.db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comments.some((c) => c.body.includes("issue stays open"))).toBe(true);
  });

  it("soft-fails when GitHub is unreachable: no state change, no throw", async () => {
    const { svc, issue, tracked } = await trackOpenPr(23);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });

    await expect(svc.reconcileOpenTrackedPrs(companyId)).resolves.toBeTruthy();

    const [row] = await handle.db
      .select()
      .from(issuePullRequests)
      .where(eq(issuePullRequests.id, tracked.id));
    expect(row.mergeStatus).not.toBe("merged");
    const [stillOpen] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(stillOpen.status).toBe("in_review");
  });
});
