// Capstone integration test replaying the 2026-06-10 live E2E orchestration round at
// the service level, asserting every fixed failure mode in one continuous lifecycle:
//   F5  — issue assigned to a PAUSED EM is never silently lost (skipped row + system
//         comment), and resume re-delivers exactly one rescan wake;
//   F6  — EM delegation via the GENERIC create endpoint still builds the handoff +
//         passdown packet before the engineer's wake;
//   F9  — a run that opened a PR but never tracked it is auto-tracked by the artifact
//         gate instead of being flagged artifact-less (no awaiting_user re-run loop);
//   F13 — an external (GitHub-direct) merge is detected by the sweep, closing the
//         loop: tracking merged, issue done, approvals resolved, verified pr-approval
//         memory captured;
//   F14/F7/F10 — no stale action items remain (approvals badge 0, awaitingUser 0).

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  agentHandoffs,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  companyIntegrations,
  heartbeatRuns,
  issueComments,
  issuePullRequests,
  issues,
  memoryEntries,
} from "@combyne/db";
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";
import { autoCloseIssueAfterSuccessfulRun } from "../heartbeat.js";
import { issuePullRequestService } from "../issue-pull-requests.js";
import { sidebarBadgeService } from "../sidebar-badges.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

type ActorShape = Record<string, unknown>;

function createStorageStub() {
  return {
    putObject: async () => {
      throw new Error("unused");
    },
    getObject: async () => {
      throw new Error("unused");
    },
    deleteObject: async () => undefined,
  };
}

describe("orchestration lifecycle: paused-EM ticket -> delegation -> PR -> external merge", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  const actorRef: { current: ActorShape } = { current: {} };
  let companyId: string;
  let emId: string;
  let engineerId: string;
  let parentIssueId: string;
  let subtaskId: string;
  let subtaskIdentifier: string;

  // Stateful GitHub fixture: starts with an OPEN untracked PR for the subtask's
  // branch; flipped to merged for the sweep stage.
  const fixture = { merged: false, headBranch: "", pullNumber: 77 };

  beforeAll(async () => {
    handle = await startTestDb();
    const appLocal = express();
    appLocal.use(express.json());
    appLocal.use((req, _res, next) => {
      (req as unknown as { actor: ActorShape }).actor = actorRef.current;
      next();
    });
    appLocal.use("/api", issueRoutes(handle.db, createStorageStub() as never));
    appLocal.use("/api", agentRoutes(handle.db));
    appLocal.use(errorHandler);
    app = appLocal;

    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Capstone Co", issuePrefix: "CAP" })
      .returning();
    companyId = company.id;
    const [em] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "EM",
        adapterType: "process",
        status: "paused",
        permissions: { canAssignTasks: true, taskAssignmentScope: "company" },
      })
      .returning();
    emId = em.id;
    const [engineer] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Backend-1", adapterType: "process" })
      .returning();
    engineerId = engineer.id;
    await handle.db.insert(companyIntegrations).values({
      companyId,
      provider: "github",
      enabled: "true",
      config: {
        baseUrl: "https://api.github.test",
        owner: "krish-buku",
        token: "test-token",
        defaultRepo: "cap-repo",
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      const prJson = {
        id: fixture.pullNumber,
        number: fixture.pullNumber,
        title: "refactor: capstone change",
        body: null,
        state: fixture.merged ? "closed" : "open",
        draft: false,
        user: { login: "engineer" },
        head: { ref: fixture.headBranch, sha: "capsha1" },
        base: { ref: "staging", repo: { default_branch: "staging" } },
        merged: fixture.merged,
        mergeable: true,
        merge_commit_sha: fixture.merged ? "cap-merge-sha" : null,
        merged_at: fixture.merged ? "2026-06-10T07:00:00Z" : null,
        created_at: "2026-06-10T06:00:00Z",
        updated_at: "2026-06-10T06:30:00Z",
        html_url: `https://github.test/pull/${fixture.pullNumber}`,
      };
      if (href.includes("/pulls?state=open")) {
        return new Response(JSON.stringify(fixture.merged ? [] : [prJson]), { status: 200 });
      }
      if (href.includes(`/pulls/${fixture.pullNumber}/reviews`)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (href.includes("/check-runs")) {
        return new Response(
          JSON.stringify({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] }),
          { status: 200 },
        );
      }
      if (href.includes(`/pulls/${fixture.pullNumber}`)) {
        return new Response(JSON.stringify(prJson), { status: 200 });
      }
      if (href.includes("/branches")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (handle) await stopTestDb();
  });

  function asBoard() {
    actorRef.current = {
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    };
  }

  function asAgent(agentId: string) {
    actorRef.current = { type: "agent", agentId, companyId, source: "agent_jwt" };
  }

  it("step 1-2: ticket assigned to the paused EM records the miss instead of losing it (F5)", async () => {
    asBoard();
    const res = await request(app).post(`/api/companies/${companyId}/issues`).send({
      title: "[Brick] Capstone refactor ticket",
      description: "Refactor the provider per AI review.",
      status: "todo",
      priority: "high",
      assigneeAgentId: emId,
    });
    expect(res.status).toBe(201);
    parentIssueId = res.body.id;

    // The create route's wake is fire-and-forget — poll for its async side effects
    // (skipped row + system comment) instead of racing them.
    let sawSkipped = false;
    let sawComment = false;
    for (let attempt = 0; attempt < 30 && !(sawSkipped && sawComment); attempt += 1) {
      const skipped = await handle.db
        .select({ reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(
          and(eq(agentWakeupRequests.agentId, emId), eq(agentWakeupRequests.status, "skipped")),
        );
      sawSkipped = skipped.some((row) => row.reason === "agent.not_invokable.paused");
      const comments = await handle.db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, parentIssueId));
      sawComment = comments.some((c) => c.body.includes("Wake for @EM skipped"));
      if (!(sawSkipped && sawComment)) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(sawSkipped).toBe(true);
    expect(sawComment).toBe(true);
  });

  it("step 3: resuming the EM re-delivers exactly one rescan wake (F5)", async () => {
    asBoard();
    const res = await request(app).post(`/api/agents/${emId}/resume`).send({});
    expect(res.status).toBe(200);

    const rescans = await handle.db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(eq(agentWakeupRequests.agentId, emId), eq(agentWakeupRequests.reason, "agent_resumed_rescan")),
      );
    expect(rescans).toHaveLength(1);

    const consumed = await handle.db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, emId),
          like(agentWakeupRequests.reason, "redelivered.agent.not_invokable%"),
        ),
      );
    expect(consumed.length).toBeGreaterThanOrEqual(1);
  });

  it("step 4: EM delegation via generic create builds the handoff/passdown before the wake (F6)", async () => {
    asAgent(emId);
    const res = await request(app).post(`/api/companies/${companyId}/issues`).send({
      title: "Refactor provider — constants, generics, URL safety",
      description: "All changes in the provider class.",
      status: "todo",
      priority: "high",
      parentId: parentIssueId,
      assigneeAgentId: engineerId,
    });
    expect(res.status).toBe(201);
    subtaskId = res.body.id;
    subtaskIdentifier = res.body.identifier;
    expect(subtaskIdentifier).toBeTruthy();
    fixture.headBranch = `feat/${subtaskIdentifier}/refactor-provider`;

    const handoffs = await handle.db
      .select({ toAgentId: agentHandoffs.toAgentId, brief: agentHandoffs.brief })
      .from(agentHandoffs)
      .where(eq(agentHandoffs.issueId, subtaskId));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].toAgentId).toBe(engineerId);

    // The route's wake is intentionally fire-and-forget (handoff IS awaited; the
    // wake is not) — poll briefly instead of racing it.
    let engineerWakes: Array<{ id: string }> = [];
    for (let attempt = 0; attempt < 20 && engineerWakes.length === 0; attempt += 1) {
      engineerWakes = await handle.db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, engineerId));
      if (engineerWakes.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(engineerWakes.length).toBeGreaterThanOrEqual(1);
  });

  it("step 5: artifact gate auto-tracks the untracked open PR instead of awaiting_user (F9)", async () => {
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: engineerId, status: "succeeded", invocationSource: "assignment" })
      .returning();
    await handle.db
      .update(issues)
      .set({ status: "in_progress", complexity: "small" })
      .where(eq(issues.id, subtaskId));

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId: engineerId,
      runId: run.id,
      issueId: subtaskId,
      requiresArtifact: true,
      changedFiles: [],
      repoUrl: "https://github.com/krish-buku/cap-repo.git",
    });
    expect(result.reason).not.toBe("no_artifact");

    const [tracked] = await handle.db
      .select()
      .from(issuePullRequests)
      .where(eq(issuePullRequests.issueId, subtaskId));
    expect(tracked).toBeTruthy();
    expect(tracked.pullNumber).toBe(fixture.pullNumber);

    const [sub] = await handle.db.select().from(issues).where(eq(issues.id, subtaskId));
    expect(sub.status).not.toBe("awaiting_user");
  });

  it("step 6: the sweep detects the external merge and closes the loop clean (F13/F14/F7/F10)", async () => {
    fixture.merged = true;
    const svc = issuePullRequestService(handle.db);
    const sweep = await svc.reconcileOpenTrackedPrs(companyId);
    expect(sweep.merged).toBeGreaterThanOrEqual(1);

    const [tracked] = await handle.db
      .select()
      .from(issuePullRequests)
      .where(eq(issuePullRequests.issueId, subtaskId));
    expect(tracked.mergeStatus).toBe("merged");

    const [sub] = await handle.db.select().from(issues).where(eq(issues.id, subtaskId));
    expect(sub.status).toBe("done");

    const memory = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.source, `pr-approval:${tracked.approvalId}`));
    expect(memory).toHaveLength(1);
    expect(memory[0].verificationState).toBe("verified");
    expect(memory[0].provenance).toBe("pr-approval");

    const pendingApprovals = await handle.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")));
    expect(pendingApprovals).toHaveLength(0);

    const badges = await sidebarBadgeService(handle.db).get(companyId);
    expect(badges.approvals).toBe(0);
    expect(badges.awaitingUser).toBe(0);
  });
});
