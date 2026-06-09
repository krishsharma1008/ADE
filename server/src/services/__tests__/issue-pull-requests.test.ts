import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { acceptedWorkEvents, agents, agentWakeupRequests, approvals, companies, companyIntegrations, heartbeatRuns, issueComments, issuePullRequests, issues, memoryEntries } from "@combyne/db";
import { issuePullRequestService } from "../issue-pull-requests.js";
import { acceptedWorkService } from "../accepted-work.js";
import { memoryService } from "../memory.js";
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

describe("HOOK 2 — EM PR-approval capture (deterministic, no LLM)", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let pullSeq = 5000;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "PR Approval Capture Co", issuePrefix: "PAC" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", adapterType: "process" })
      .returning();
    agentId = agent.id;
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
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  // Stateful mock of a fully-mergeable PR: passing check, an APPROVED review (no
  // CHANGES_REQUESTED blocker), and a merge PUT that flips the PR to merged so the
  // post-merge GET reports the merged state.
  function mockMergeableGitHub(pullNumber: number, headSha: string) {
    let merged = false;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      if (href.includes(`/pulls/${pullNumber}/reviews`)) {
        return new Response(JSON.stringify([
          {
            id: 1,
            user: { login: "lead-reviewer" },
            state: "APPROVED",
            body: "LGTM",
            submitted_at: "2026-05-06T00:00:00Z",
          },
        ]), { status: 200 });
      }
      if (href.includes(`/commits/${headSha}/check-runs`)) {
        return new Response(JSON.stringify({
          check_runs: [
            { id: 1, name: "ci", status: "completed", conclusion: "success" },
          ],
        }), { status: 200 });
      }
      if (href.includes(`/pulls/${pullNumber}/merge`) && method === "PUT") {
        merged = true;
        return new Response(JSON.stringify({ merged: true, message: "Merged", sha: "merge-sha" }), {
          status: 200,
        });
      }
      if (href.includes(`/pulls/${pullNumber}`)) {
        return new Response(JSON.stringify({
          id: pullNumber,
          number: pullNumber,
          title: `feat: durable change ${pullNumber}`,
          body: null,
          state: merged ? "closed" : "open",
          draft: false,
          user: { login: "engineer" },
          head: { ref: "feat/durable", sha: headSha },
          base: { ref: "development" },
          merged,
          mergeable: true,
          merge_commit_sha: merged ? "merge-sha" : null,
          merged_at: merged ? "2026-05-06T01:00:00Z" : null,
          created_at: "2026-05-06T00:00:00Z",
          updated_at: "2026-05-06T00:00:00Z",
          html_url: `https://github.com/combyne/ade/pull/${pullNumber}`,
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    return spy;
  }

  async function trackPr(svc: ReturnType<typeof issuePullRequestService>, pullNumber: number, headSha: string) {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: `Issue for PR ${pullNumber}`, status: "in_progress", assigneeAgentId: agentId })
      .returning();
    const tracked = await svc.upsertForIssue({
      companyId,
      issueId: issue.id,
      requestedByAgentId: agentId,
      repo: "ade",
      pullNumber,
      pullUrl: `https://github.com/combyne/ade/pull/${pullNumber}`,
      title: `feat: durable change ${pullNumber}`,
      baseBranch: "development",
      headBranch: "feat/durable",
      headSha,
      mergeMethod: "squash",
    });
    return { issue, tracked };
  }

  it("captures one verified pr-approval/convention row when merging with a decisionNote", async () => {
    const svc = issuePullRequestService(handle.db);
    const pullNumber = pullSeq++;
    const headSha = `sha${pullNumber}`;
    const { tracked } = await trackPr(svc, pullNumber, headSha);
    const fetchSpy = mockMergeableGitHub(pullNumber, headSha);
    try {
      const result = await svc.merge(tracked.id, {
        approvalId: tracked.approvalId,
        decidedByUserId: "em-user-1",
        decisionNote: "Always validate webhook signatures before processing.",
      });
      expect(result.pullRequest.mergeStatus).toBe("merged");

      const rows = await handle.db
        .select()
        .from(memoryEntries)
        .where(eq(memoryEntries.source, `pr-approval:${tracked.approvalId}`));
      expect(rows).toHaveLength(1);
      const entry = rows[0];
      expect(entry.provenance).toBe("pr-approval");
      expect(entry.verificationState).toBe("verified");
      expect(entry.kind).toBe("convention");
      expect(entry.confidence).toBe(0.8);
      expect(entry.authorType).toBe("user");
      expect(entry.createdBy).toBe("em-user-1");
      expect(entry.sourceRefType).toBe("approval");
      expect(entry.sourceRefId).toBe(tracked.approvalId);
      expect(entry.subject).toBe(`EM approved PR ade#${pullNumber}: feat: durable change ${pullNumber}`);
      // Body is the literal human note (no LLM summarization) plus deterministic context.
      expect(entry.body).toContain("Always validate webhook signatures before processing.");
      expect(entry.body).toContain("approved by lead-reviewer");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("writes kind='note' (still pr-approval/verified) when merging without a decisionNote", async () => {
    const svc = issuePullRequestService(handle.db);
    const pullNumber = pullSeq++;
    const headSha = `sha${pullNumber}`;
    const { tracked } = await trackPr(svc, pullNumber, headSha);
    const fetchSpy = mockMergeableGitHub(pullNumber, headSha);
    try {
      const result = await svc.merge(tracked.id, {
        approvalId: tracked.approvalId,
        decidedByUserId: "em-user-2",
        // no decisionNote
      });
      expect(result.pullRequest.mergeStatus).toBe("merged");

      const rows = await handle.db
        .select()
        .from(memoryEntries)
        .where(eq(memoryEntries.source, `pr-approval:${tracked.approvalId}`));
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("note");
      expect(rows[0].provenance).toBe("pr-approval");
      expect(rows[0].verificationState).toBe("verified");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("is idempotent: re-firing the capture for the same approval yields one row", async () => {
    const svc = issuePullRequestService(handle.db);
    const pullNumber = pullSeq++;
    const headSha = `sha${pullNumber}`;
    const { tracked } = await trackPr(svc, pullNumber, headSha);
    const fetchSpy = mockMergeableGitHub(pullNumber, headSha);
    try {
      await svc.merge(tracked.id, {
        approvalId: tracked.approvalId,
        decidedByUserId: "em-user-3",
        decisionNote: "Prefer squash merges on feature branches.",
      });
      // Re-fire the deterministic capture directly with the same source key (mirrors a
      // reconcile-twice / retried merge replay) — the (companyId, source) upsert dedups.
      const memorySvc = memoryService(handle.db);
      await memorySvc.createEntry({
        companyId,
        layer: "workspace",
        subject: `EM approved PR ade#${pullNumber}: feat: durable change ${pullNumber}`,
        body: "Prefer squash merges on feature branches.",
        kind: "convention",
        source: `pr-approval:${tracked.approvalId}`,
        provenance: "pr-approval",
        authorType: "user",
        verificationState: "verified",
        confidence: 0.8,
        createdBy: "em-user-3",
        sourceRefType: "approval",
        sourceRefId: tracked.approvalId,
      });

      const rows = await handle.db
        .select()
        .from(memoryEntries)
        .where(eq(memoryEntries.source, `pr-approval:${tracked.approvalId}`));
      expect(rows).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps the agent-driven (poller/out-of-band) path at agent-claim/unverified — no laundering, distinct source key", async () => {
    const acceptedWork = acceptedWorkService(handle.db);
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Out-of-band merge issue", status: "in_progress", assigneeAgentId: agentId })
      .returning();
    // Simulate the poller detecting a GitHub-direct merge (no human decisionNote).
    const accepted = await acceptedWork.upsertMergedPull({
      companyId,
      issueId: issue.id,
      repo: "ade",
      pullNumber: 9999,
      pullUrl: "https://github.com/combyne/ade/pull/9999",
      title: "feat: out-of-band",
      body: "merged directly on github",
      headBranch: "feat/oob",
      mergedSha: "oob-sha",
      mergedAt: "2026-05-06T00:00:00Z",
      detectionSource: "github_reconcile",
      metadata: {},
    });
    const written = await acceptedWork.createMemoryFromEvent({
      eventId: accepted.event.id,
      subject: "Out-of-band merged work",
      body: "An agent-authored claim from a github-direct merge.",
      kind: "note",
    });
    expect(written).not.toBeNull();
    const agentEntry = written!.memory;
    expect(agentEntry.provenance).toBe("agent-claim");
    expect(agentEntry.verificationState).toBe("unverified");
    // Distinct source namespace from the pr-approval hook — no collision/double-capture.
    expect(agentEntry.source).toBe(`accepted_work:${accepted.event.id}`);
    expect(agentEntry.source?.startsWith("pr-approval:")).toBe(false);
  });

  it("captures the pr-approval on reconcile when the PR was merged externally (on GitHub)", async () => {
    const svc = issuePullRequestService(handle.db);
    const pullNumber = pullSeq++;
    const headSha = `sha${pullNumber}`;
    const { issue, tracked } = await trackPr(svc, pullNumber, headSha);
    // Tracking moved the issue to in_review; it must NOT yet be done.
    const [beforeReconcile] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(beforeReconcile.status).toBe("in_review");
    // The human merged the PR directly on GitHub: the PR GET already reports merged,
    // and there is NO in-app merge() PUT. reconcile() must still capture HOOK 2 so the
    // approved decision lands regardless of where the merge happened.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes(`/pulls/${pullNumber}/reviews`)) {
        return new Response(
          JSON.stringify([
            { id: 1, user: { login: "lead-reviewer" }, state: "APPROVED", body: "LGTM", submitted_at: "2026-05-06T00:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      if (href.includes("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] }), { status: 200 });
      }
      if (href.includes(`/pulls/${pullNumber}`)) {
        return new Response(
          JSON.stringify({
            id: pullNumber,
            number: pullNumber,
            title: `feat: durable change ${pullNumber}`,
            body: null,
            state: "closed",
            draft: false,
            user: { login: "engineer" },
            head: { ref: "feat/durable", sha: headSha },
            base: { ref: "development" },
            merged: true,
            mergeable: true,
            merge_commit_sha: "ext-merge-sha",
            merged_at: "2026-05-06T02:00:00Z",
            created_at: "2026-05-06T00:00:00Z",
            updated_at: "2026-05-06T00:00:00Z",
            html_url: `https://github.com/combyne/ade/pull/${pullNumber}`,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const result = await svc.reconcile(tracked.id);
      expect(result.pullRequest.mergeStatus).toBe("merged");
      const source = `pr-approval:${tracked.approvalId}`;
      const rows = await handle.db.select().from(memoryEntries).where(eq(memoryEntries.source, source));
      expect(rows).toHaveLength(1);
      expect(rows[0].provenance).toBe("pr-approval");
      expect(rows[0].verificationState).toBe("verified");
      expect(rows[0].createdBy).toBeNull(); // merged outside ADE — no decidedByUserId

      // CLOSE-OUT PARITY: the external merge must also transition the tracked issue to
      // "done" (mirroring in-app merge()) — previously it stayed stuck in in_review.
      const [afterReconcile] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
      expect(afterReconcile.status).toBe("done");
      expect(afterReconcile.completedAt).not.toBeNull();

      // Reconciling again must NOT duplicate (transition guard + (companyId, source) dedup)
      // and the done-transition no-ops.
      await svc.reconcile(tracked.id);
      const again = await handle.db.select().from(memoryEntries).where(eq(memoryEntries.source, source));
      expect(again).toHaveLength(1);
      const [stillDone] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
      expect(stillDone.status).toBe("done");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("completes the merge even if the approval-memory capture throws (best-effort)", async () => {
    const svc = issuePullRequestService(handle.db);
    const pullNumber = pullSeq++;
    const headSha = `sha${pullNumber}`;
    const { issue, tracked } = await trackPr(svc, pullNumber, headSha);
    const fetchSpy = mockMergeableGitHub(pullNumber, headSha);
    // Force the deterministic capture's createEntry to throw. Target the memoryEntries
    // insert specifically (not "the first insert") so an unrelated background insert —
    // e.g. an async EM heartbeat wakeup queued by another test sharing this db — can't
    // accidentally consume a one-shot throw and let the memory write succeed.
    const realInsert = handle.db.insert.bind(handle.db);
    const insertSpy = vi.spyOn(handle.db, "insert").mockImplementation(((table: unknown) => {
      if (table === memoryEntries) {
        throw new Error("simulated memory write failure");
      }
      return realInsert(table as Parameters<typeof realInsert>[0]);
    }) as typeof handle.db.insert);
    try {
      const result = await svc.merge(tracked.id, {
        approvalId: tracked.approvalId,
        decidedByUserId: "em-user-4",
        decisionNote: "This note never persists because the write throws.",
      });
      // Merge still succeeds.
      expect(result.pullRequest.mergeStatus).toBe("merged");
      expect(result.approvalMemoryEntryId).toBeNull();
      // Issue still advanced to done.
      const [after] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
      expect(after.status).toBe("done");
      // No pr-approval row was written.
      const rows = await handle.db
        .select()
        .from(memoryEntries)
        .where(eq(memoryEntries.source, `pr-approval:${tracked.approvalId}`));
      expect(rows).toHaveLength(0);
    } finally {
      insertSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe("external-merge close-out: child -> done, parent/EM woken, backstop sweep", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let emAgentId: string;
  let icAgentId: string;
  let pullSeq = 7000;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "External Merge Closeout Co", issuePrefix: "EMC" })
      .returning();
    companyId = company.id;
    const [em] = await handle.db
      .insert(agents)
      .values({ companyId, name: "EM", role: "em", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .returning();
    emAgentId = em.id;
    const [ic] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Backend-1", role: "engineer", adapterType: "process", reportsTo: em.id })
      .returning();
    icAgentId = ic.id;
    await handle.db
      .insert(companyIntegrations)
      .values({
        companyId,
        provider: "github",
        enabled: "true",
        config: { baseUrl: "https://api.github.test", owner: "combyne", token: "test-token", defaultRepo: "ade" },
      })
      .onConflictDoNothing();
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  // A PR that GitHub already reports as merged (human merged it directly on GitHub).
  function mockExternallyMergedGitHub(pullNumber: number, headSha: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes(`/pulls/${pullNumber}/reviews`)) {
        return new Response(
          JSON.stringify([{ id: 1, user: { login: "lead-reviewer" }, state: "APPROVED", body: "LGTM", submitted_at: "2026-05-06T00:00:00Z" }]),
          { status: 200 },
        );
      }
      if (href.includes("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] }), { status: 200 });
      }
      if (href.includes(`/pulls/${pullNumber}`)) {
        return new Response(
          JSON.stringify({
            id: pullNumber,
            number: pullNumber,
            title: `feat: phase 1 ${pullNumber}`,
            body: null,
            state: "closed",
            draft: false,
            user: { login: "engineer" },
            head: { ref: "feat/phase-1", sha: headSha },
            base: { ref: "development" },
            merged: true,
            mergeable: true,
            merge_commit_sha: "ext-merge-sha",
            merged_at: "2026-05-06T02:00:00Z",
            created_at: "2026-05-06T00:00:00Z",
            updated_at: "2026-05-06T00:00:00Z",
            html_url: `https://github.com/combyne/ade/pull/${pullNumber}`,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
  }

  async function setupParentChildPr(svc: ReturnType<typeof issuePullRequestService>, pullNumber: number, headSha: string) {
    const [parent] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Parent epic (PINB405-3)", status: "in_progress", assigneeAgentId: emAgentId })
      .returning();
    const [child] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Phase 1 implementation", status: "in_progress", assigneeAgentId: icAgentId, parentId: parent.id })
      .returning();
    // Give the EM a running heartbeat so notifyParentOnChildStatus can enqueue a run.
    await handle.db.insert(heartbeatRuns).values({ companyId, agentId: emAgentId, status: "running", invocationSource: "on_demand" });
    const tracked = await svc.upsertForIssue({
      companyId,
      issueId: child.id,
      requestedByAgentId: icAgentId,
      repo: "ade",
      pullNumber,
      pullUrl: `https://github.com/combyne/ade/pull/${pullNumber}`,
      title: `feat: phase 1 ${pullNumber}`,
      baseBranch: "development",
      headBranch: "feat/phase-1",
      headSha,
      mergeMethod: "squash",
    });
    return { parent, child, tracked };
  }

  it("on reconcile of an external merge: closes the child, posts a parent handoff, wakes the EM, and records an accepted-work manager wake", async () => {
    const svc = issuePullRequestService(handle.db);
    const pullNumber = pullSeq++;
    const headSha = `sha${pullNumber}`;
    const { parent, child, tracked } = await setupParentChildPr(svc, pullNumber, headSha);
    expect((await handle.db.select().from(issues).where(eq(issues.id, child.id)))[0].status).toBe("in_review");

    const fetchSpy = mockExternallyMergedGitHub(pullNumber, headSha);
    try {
      await svc.reconcile(tracked.id);

      // 1. Child transitioned to done (close-out parity with in-app merge()).
      const [childAfter] = await handle.db.select().from(issues).where(eq(issues.id, child.id));
      expect(childAfter.status).toBe("done");

      // 2. notifyParentOnChildStatus posted a handoff digest on the PARENT issue.
      const parentComments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, parent.id));
      expect(parentComments.some((c) => c.body.includes("Child issue"))).toBe(true);
      expect(parentComments.some((c) => c.body.includes("### Recommended next action"))).toBe(true);

      // 3. The EM (parent assignee) was woken with the child handoff context.
      const emRuns = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, emAgentId));
      expect(emRuns.some((run) => (run.contextSnapshot as Record<string, unknown> | null)?.childIssueId === child.id)).toBe(true);

      // 4. The accepted-work manager-wake fired too (works with heartbeats OFF), resolving
      //    the EM (parent assignee) as managerAgentId and enqueuing a wake request.
      const [event] = await handle.db
        .select()
        .from(acceptedWorkEvents)
        .where(and(eq(acceptedWorkEvents.companyId, companyId), eq(acceptedWorkEvents.pullNumber, pullNumber)));
      expect(event).toBeTruthy();
      expect(event.managerAgentId).toBe(emAgentId);
      expect(event.wakeupRequestedAt).not.toBeNull();
      const wakeReqs = await handle.db
        .select()
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, emAgentId), eq(agentWakeupRequests.reason, "accepted_work_merged_pr")));
      expect(wakeReqs.length).toBeGreaterThanOrEqual(1);

      // Idempotent: a second reconcile must not create a second accepted-work event nor a
      // second manager wake (transition guard + (company,repo,pull) dedup + wake guard).
      await svc.reconcile(tracked.id);
      const events = await handle.db
        .select()
        .from(acceptedWorkEvents)
        .where(and(eq(acceptedWorkEvents.companyId, companyId), eq(acceptedWorkEvents.pullNumber, pullNumber)));
      expect(events).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("backstop sweep closes a merged-but-open issue and wakes the EM, even with no GitHub poll", async () => {
    const svc = issuePullRequestService(handle.db);
    const pullNumber = pullSeq++;
    // Simulate a PR that was merged on GitHub BEFORE the fix shipped: the tracking row is
    // already mergeStatus 'merged' but its issue was left stuck in in_review (the exact
    // PINB405-5 state). No fetch mock — the sweep must NOT call GitHub.
    const [parent] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Parent epic (sweep)", status: "in_progress", assigneeAgentId: emAgentId })
      .returning();
    const [child] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Merged-but-stuck child", status: "in_review", assigneeAgentId: icAgentId, parentId: parent.id })
      .returning();
    await handle.db.insert(heartbeatRuns).values({ companyId, agentId: emAgentId, status: "running", invocationSource: "on_demand" });
    await handle.db.insert(issuePullRequests).values({
      companyId,
      issueId: child.id,
      provider: "github",
      repo: "ade",
      pullNumber,
      pullUrl: `https://github.com/combyne/ade/pull/${pullNumber}`,
      title: "feat: already merged",
      baseBranch: "development",
      headBranch: "feat/already-merged",
      mergeCommitSha: "pre-existing-merge-sha",
      mergeStatus: "merged",
      mergedAt: new Date("2026-05-01T00:00:00Z"),
    });

    const result = await svc.sweepMergedOpenIssues(companyId);
    expect(result.closed).toBeGreaterThanOrEqual(1);

    const [childAfter] = await handle.db.select().from(issues).where(eq(issues.id, child.id));
    expect(childAfter.status).toBe("done");

    // EM woken via parent-notification AND accepted-work manager wake.
    const parentComments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, parent.id));
    expect(parentComments.some((c) => c.body.includes("Child issue"))).toBe(true);
    const [event] = await handle.db
      .select()
      .from(acceptedWorkEvents)
      .where(and(eq(acceptedWorkEvents.companyId, companyId), eq(acceptedWorkEvents.pullNumber, pullNumber)));
    expect(event?.managerAgentId).toBe(emAgentId);

    // Re-running the sweep is a no-op now that the issue is done.
    const second = await svc.sweepMergedOpenIssues(companyId);
    expect(second.scanned).toBe(0);
  });
});
