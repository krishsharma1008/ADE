// E2E round-2 fix batch (e2e-run-2026-06-10, findings #21 / #23 / #26):
//
// #21 — a human merged a PR while the assignee was mid-revision ("Let agents
//       fix"), stranding the fix commit. reconcile() now adds a merge-gating
//       blocker while the tracked issue is in_progress; it is NOT part of the
//       agent-actionable blockers (no feedback wake at the agent it describes)
//       and clears when the issue returns to review.
// #23 — PINB405-20 was closed by a non-human path while PR #5 was open, with no
//       activity-log attribution. issueService.update is now the single
//       chokepoint: non-human done-transitions are refused while a tracked PR
//       is open (with a system comment + activity entry), and unattributed
//       status changes are stamped into the activity log.
// #26 — the F14 dangling-approval batch-resolver auto-approved a LIVE sibling
//       PR's approval on a multi-PR issue (PR #6's approval died 46s after
//       creation), hiding the inbox card and bricking the dashboard merge. The
//       resolver now skips approvals attached to open tracked PRs, and
//       reconcile self-heals approvals the old resolver wrongly decided.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyIntegrations,
  issueApprovals,
  issueComments,
  issuePullRequests,
  issues,
} from "@combyne/db";
import { issuePullRequestService } from "../issue-pull-requests.js";
import { issueService } from "../issues.js";
import { approvalService } from "../approvals.js";
import { HttpError } from "../../errors.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("post-round-2 fixes: #21 revision merge gate, #23 close chokepoint, #26 live-approval survival", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Round2 Fix Co", issuePrefix: "RFX" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", role: "engineer", adapterType: "process" })
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

  type PrShape = { merged?: boolean; state?: string };

  /** One fetch mock serving multiple PRs: clean checks, no reviews, base=default. */
  function mockGitHubPrs(prs: Record<number, PrShape>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      for (const [num, shape] of Object.entries(prs)) {
        if (href.includes(`/pulls/${num}/reviews`)) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (href.includes(`/pulls/${num}`)) {
          const merged = shape.merged ?? false;
          return new Response(
            JSON.stringify({
              id: Number(num),
              number: Number(num),
              title: `feat: change ${num}`,
              body: null,
              state: shape.state ?? "open",
              draft: false,
              user: { login: "engineer" },
              head: { ref: `feat/RFX-${num}/x`, sha: `sha-${num}` },
              base: { ref: "staging", repo: { default_branch: "staging" } },
              merged,
              mergeable: true,
              merge_commit_sha: merged ? `merge-${num}` : null,
              merged_at: merged ? "2026-06-10T05:00:00Z" : null,
              created_at: "2026-06-10T00:00:00Z",
              updated_at: "2026-06-10T05:00:00Z",
              html_url: `https://github.test/pull/${num}`,
            }),
            { status: 200 },
          );
        }
      }
      if (href.includes("/check-runs")) {
        return new Response(
          JSON.stringify({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
  }

  async function trackPr(pullNumber: number, issueId?: string) {
    let resolvedIssueId = issueId;
    if (!resolvedIssueId) {
      const [issue] = await handle.db
        .insert(issues)
        .values({ companyId, title: `Ticket ${pullNumber}`, status: "in_progress", assigneeAgentId: agentId })
        .returning();
      resolvedIssueId = issue.id;
    }
    const svc = issuePullRequestService(handle.db);
    const tracked = await svc.upsertForIssue({
      companyId,
      issueId: resolvedIssueId,
      requestedByAgentId: agentId,
      repo: "krish-buku/fs-brick-service-test",
      pullNumber,
      pullUrl: `https://github.test/pull/${pullNumber}`,
      title: `feat: change ${pullNumber}`,
      baseBranch: "staging",
      headBranch: `feat/RFX-${pullNumber}/x`,
      headSha: `sha-${pullNumber}`,
      mergeMethod: "squash",
    });
    return { svc, issueId: resolvedIssueId, tracked };
  }

  // ---------------------------------------------------------------- #21 ----

  it("#21: an in_progress tracked issue gates the merge but never the agent feedback", async () => {
    const { svc, issueId, tracked } = await trackPr(31);
    mockGitHubPrs({ 31: {} });

    // Tracked → issue in_review → clean PR reconciles to ready.
    const ready = await svc.reconcile(tracked.id);
    expect(ready.pullRequest.mergeStatus).toBe("ready");
    expect(ready.blockers).toHaveLength(0);

    // Agent takes the issue back (post-feedback revision) → merge gated.
    await handle.db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const gated = await svc.reconcile(tracked.id);
    expect(gated.pullRequest.mergeStatus).toBe("pending");
    expect(gated.blockers.some((b) => b.includes("actively revising"))).toBe(true);
    // The gate is merge-only: agents must not receive it as PR feedback.
    expect(gated.agentBlockers).toHaveLength(0);
    // The persisted metadata (what the PR panel renders) carries the gate.
    const metaBlockers = (gated.pullRequest.metadata?.blockers ?? []) as string[];
    expect(metaBlockers.some((b) => b.includes("actively revising"))).toBe(true);

    // merge() (the dashboard path) refuses while the agent is revising.
    await expect(
      svc.merge(tracked.id, { decidedByUserId: "user-1" }),
    ).rejects.toMatchObject({ status: 422 });

    // Agent returns the issue to review ("updated PR or no-change reply") → unlocked.
    await handle.db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    const unlocked = await svc.reconcile(tracked.id);
    expect(unlocked.pullRequest.mergeStatus).toBe("ready");
    expect(unlocked.blockers).toHaveLength(0);
  });

  // ---------------------------------------------------------------- #23 ----

  it("#23: a system done-transition is refused while a tracked PR is open (comment + activity log)", async () => {
    const { svc, issueId, tracked } = await trackPr(32);
    mockGitHubPrs({ 32: {} });
    await svc.reconcile(tracked.id); // open + ready

    const issuesSvc = issueService(handle.db);
    let thrown: unknown;
    try {
      await issuesSvc.update(issueId, { status: "done" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(422);
    expect(((thrown as HttpError).details as { code?: string }).code).toBe("open_tracked_prs");

    const [after] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(after.status).not.toBe("done");

    const comments = await handle.db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.some((c) => c.body.includes("Close blocked"))).toBe(true);

    const log = await handle.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(desc(activityLog.createdAt));
    expect(log.some((row) => row.action === "issue.close_blocked_open_pr")).toBe(true);

    // Retrying does not spam: identical advisory is not reposted.
    await issuesSvc.update(issueId, { status: "done" }).catch(() => null);
    const commentsAfterRetry = await handle.db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(
      commentsAfterRetry.filter((c) => c.body.includes("Close blocked")),
    ).toHaveLength(1);
  });

  it("#23: a HUMAN can still force-close an issue with an open tracked PR", async () => {
    const { svc, issueId, tracked } = await trackPr(33);
    mockGitHubPrs({ 33: {} });
    await svc.reconcile(tracked.id);

    const updated = await issueService(handle.db).update(
      issueId,
      { status: "done" },
      { parentNotificationActor: { actorType: "user", actorId: "user-1" } },
    );
    expect(updated?.status).toBe("done");
  });

  it("#23: unattributed status changes are stamped into the activity log", async () => {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Attribution probe", status: "todo", assigneeAgentId: agentId })
      .returning();

    await issueService(handle.db).update(issue.id, { status: "in_progress" });

    const log = await handle.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issue.id));
    const stamped = log.find((row) => row.action === "issue.status_changed");
    expect(stamped).toBeTruthy();
    expect(stamped?.actorType).toBe("system");
    expect((stamped?.details as { nextStatus?: string }).nextStatus).toBe("in_progress");
  });

  // ---------------------------------------------------------------- #26 ----

  it("#26: the dangling-approval resolver spares a LIVE sibling PR's approval, resolves true danglings", async () => {
    // One issue, two PRs: A (merged externally) and B (open, ready-to-merge).
    const { svc, issueId, tracked: prA } = await trackPr(34);
    const { tracked: prB } = await trackPr(35, issueId);
    // Plus a truly dangling approval linked to the issue but attached to no row.
    const dangling = await approvalService(handle.db).create(companyId, {
      type: "merge_pr",
      requestedByAgentId: agentId,
      requestedByUserId: null,
      status: "pending",
      payload: { repo: "krish-buku/fs-brick-service-test", pullNumber: 34, stale: true },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    await handle.db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId: dangling.id,
      linkedByAgentId: agentId,
      linkedByUserId: null,
    });

    mockGitHubPrs({ 34: { merged: true, state: "closed" }, 35: {} });
    // The sweep observes A's external merge AND runs the dangling backfill.
    await svc.reconcileOpenTrackedPrs(companyId);

    const [approvalB] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, prB.approvalId!));
    expect(approvalB.status).toBe("pending"); // live sibling survives

    const [approvalA] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, prA.approvalId!));
    expect(approvalA.status).toBe("approved"); // merged PR's own approval resolved

    const [danglingAfter] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, dangling.id));
    expect(danglingAfter.status).toBe("approved"); // true dangling still cleaned
  });

  it("#26: reconcile self-heals an open PR's approval the old resolver wrongly auto-approved", async () => {
    const { svc, tracked } = await trackPr(36);
    // Simulate the pre-fix damage: machine-decided approval on a live PR.
    await handle.db
      .update(approvals)
      .set({
        status: "approved",
        decidedByUserId: "issue-pr-reconcile",
        decisionNote: "Auto-resolved: PR merged",
        decidedAt: new Date(),
      })
      .where(eq(approvals.id, tracked.approvalId!));

    mockGitHubPrs({ 36: {} });
    await svc.reconcile(tracked.id);

    const [healed] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, tracked.approvalId!));
    expect(healed.status).toBe("pending");
    expect(healed.decidedByUserId).toBeNull();
    expect(healed.decisionNote).toBeNull();
  });

  it("#26 guard-rail: a HUMAN-decided approval is never reopened by reconcile", async () => {
    const { svc, tracked } = await trackPr(37);
    await handle.db
      .update(approvals)
      .set({
        status: "approved",
        decidedByUserId: "real-human-user",
        decisionNote: "Looks good",
        decidedAt: new Date(),
      })
      .where(eq(approvals.id, tracked.approvalId!));

    mockGitHubPrs({ 37: {} });
    await svc.reconcile(tracked.id);

    const [untouched] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, tracked.approvalId!));
    expect(untouched.status).toBe("approved");
    expect(untouched.decidedByUserId).toBe("real-human-user");
  });
});
