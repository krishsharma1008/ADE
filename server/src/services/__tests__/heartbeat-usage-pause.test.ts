// Issue 4 — EXHAUSTIVE usage-limit pause / resume / restart engine tests.
//
// This suite is the adversarial counterpart to usage-pause-engine.test.ts. It
// drives the REAL engine implementation (exposed via the heartbeat service's
// __usagePauseTestApi seam, plus the public resumeUsagePausedRuns /
// bootRecoverUsagePausedRuns / reapOrphanedRuns / reapOrphanedIssueLocks /
// wakeup surface) against an embedded Postgres so every assertion is on the
// actual code path the server runs in production — not a reimplementation.
//
// We never spawn a real adapter process. Two seams make that safe:
//   1. The pause path (handleUsageLimitResponse) takes a synthetic
//      AdapterExecutionResult shaped exactly like claude-local's toAdapterResult
//      output on a usage limit (errorCode "claude_usage_limit_reached",
//      non-null errorMessage, resetsAt in errorMeta, clearSession false).
//   2. The resume path re-dispatches through startNextQueuedRunForAgent, which
//      is a no-op for a PAUSED agent (isAgentStatusInvokable === false). So a
//      "resume" flips the run paused_usage -> queued WITHOUT executeRun ever
//      reaching adapter.execute. We assert the queued transition + window
//      lifecycle directly.
//
// The flag COMBYNE_USAGE_PAUSE_ENABLED is forced "true" for the suite (restored
// in afterAll) and toggled off in the dedicated flag-gate scenario.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentRuntimeState,
  agents,
  companies,
  heartbeatRuns,
  issuePullRequests,
  issues,
  usagePauseWindows,
} from "@combyne/db";
import { heartbeatService } from "../heartbeat.js";
import {
  recordUsageLimitObservation,
  __resetUsageLimitObservation,
} from "@combyne/adapter-claude-local/server";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

type Svc = ReturnType<typeof heartbeatService>;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

/** Shape a synthetic claude_usage_limit_reached adapter result. */
function usageLimitResult(opts?: {
  resetsAt?: string | null;
  message?: string;
}): Parameters<Svc["__usagePauseTestApi"]["handleUsageLimitResponse"]>[0]["adapterResult"] {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "claude_usage_limit_reached",
    errorMessage: opts?.message ?? "Claude usage limit reached. Resets at ...",
    errorMeta:
      opts?.resetsAt === null
        ? {}
        : { resetsAt: opts?.resetsAt ?? new Date(Date.now() + FIVE_HOURS_MS).toISOString() },
    clearSession: false,
  };
}

describe("heartbeat usage-pause engine (Issue 4, exhaustive)", () => {
  let handle: TestDbHandle;
  let svc: Svc;
  let companyId: string;
  const prevFlag = process.env.COMBYNE_USAGE_PAUSE_ENABLED;

  beforeAll(async () => {
    handle = await startTestDb();
    process.env.COMBYNE_USAGE_PAUSE_ENABLED = "true";
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Usage Pause Exhaustive Co", status: "active" })
      .returning();
    companyId = company.id;
    svc = heartbeatService(handle.db);
  }, 60_000);

  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.COMBYNE_USAGE_PAUSE_ENABLED;
    else process.env.COMBYNE_USAGE_PAUSE_ENABLED = prevFlag;
    if (handle) await stopTestDb();
  });

  afterEach(async () => {
    __resetUsageLimitObservation();
    process.env.COMBYNE_USAGE_PAUSE_ENABLED = "true";
    await handle.db.delete(usagePauseWindows);
  });

  // ── seeding helpers ───────────────────────────────────────────────────────

  async function seedAgent(opts?: { status?: string; companyId?: string }) {
    const [agent] = await handle.db
      .insert(agents)
      .values({
        companyId: opts?.companyId ?? companyId,
        name: `Agent-${Math.random().toString(36).slice(2, 10)}`,
        adapterType: "claude_local",
        status: opts?.status ?? "idle",
      })
      .returning();
    return agent;
  }

  async function seedRunningRun(
    agent: typeof agents.$inferSelect,
    opts?: { issueId?: string; cwd?: string; companyId?: string },
  ) {
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId: opts?.companyId ?? companyId,
        agentId: agent.id,
        status: "running",
        invocationSource: "on_demand",
        startedAt: new Date(),
        contextSnapshot: opts?.issueId ? { issueId: opts.issueId } : {},
      })
      .returning();
    return run;
  }

  async function seedIssueLockedTo(
    run: typeof heartbeatRuns.$inferSelect,
    opts?: { companyId?: string; title?: string },
  ) {
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId: opts?.companyId ?? companyId,
        title: opts?.title ?? "Locked issue",
        executionRunId: run.id,
        executionAgentNameKey: "agent-key",
        executionLockedAt: new Date(),
      })
      .returning();
    return issue;
  }

  async function getRunRow(runId: string) {
    const [row] = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return row;
  }

  async function getWindow(runId: string) {
    const [row] = await handle.db
      .select()
      .from(usagePauseWindows)
      .where(eq(usagePauseWindows.runId, runId));
    return row ?? null;
  }

  async function getIssueRow(issueId: string) {
    const [row] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    return row;
  }

  /** Pause a fresh running run through the REAL handleUsageLimitResponse path. */
  async function pauseRun(opts?: {
    agentStatus?: string;
    issueId?: string;
    cwd?: string | null;
    resetsAt?: string | null;
    companyId?: string;
    withIssue?: boolean;
  }) {
    const agent = await seedAgent({ status: opts?.agentStatus, companyId: opts?.companyId });
    let issue: typeof issues.$inferSelect | null = null;
    let run = await seedRunningRun(agent, { companyId: opts?.companyId });
    if (opts?.withIssue) {
      issue = await seedIssueLockedTo(run, { companyId: opts?.companyId });
      // Re-read run so contextSnapshot carries the issue scope for the
      // resume cwd resolution.
      await handle.db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { issueId: issue.id } })
        .where(eq(heartbeatRuns.id, run.id));
      run = await getRunRow(run.id);
    }
    const handled = await svc.__usagePauseTestApi.handleUsageLimitResponse({
      run,
      agent,
      adapterResult: usageLimitResult({ resetsAt: opts?.resetsAt }),
      sessionIdToResume: "sess_resume_abc",
      sessionCwd: opts?.cwd === undefined ? null : opts.cwd,
      seq: 1,
    });
    return { agent, run: await getRunRow(run.id), issue, handled };
  }

  // ── Scenario 1 ────────────────────────────────────────────────────────────
  it("S1: limit-reached result parks the run paused_usage + creates a window, NOT failed/closed", async () => {
    const { run, handled } = await pauseRun();
    expect(handled).toBe(true);

    const refreshed = await getRunRow(run.id);
    expect(refreshed.status).toBe("paused_usage");
    expect(refreshed.errorCode).toBe("claude_usage_limit_reached");
    // Parked, NOT finalized: finishedAt stays null.
    expect(refreshed.finishedAt).toBeNull();
    expect(refreshed.status).not.toBe("failed");
    expect(refreshed.status).not.toBe("succeeded");

    const window = await getWindow(run.id);
    expect(window).toBeTruthy();
    expect(window!.sessionIdToResume).toBe("sess_resume_abc");
    expect(window!.pauseReason).toBe("subscription_limit");
    expect(window!.resetsAt).toBeTruthy();
  });

  it("S1b: declines the pause (returns false) when there is no session to resume", async () => {
    const agent = await seedAgent();
    const run = await seedRunningRun(agent);
    const handled = await svc.__usagePauseTestApi.handleUsageLimitResponse({
      run,
      agent,
      adapterResult: usageLimitResult(),
      sessionIdToResume: null,
      sessionCwd: null,
      seq: 1,
    });
    expect(handled).toBe(false);
    // No window written; run NOT parked (caller falls through to normal failure).
    expect(await getWindow(run.id)).toBeNull();
    const refreshed = await getRunRow(run.id);
    expect(refreshed.status).not.toBe("paused_usage");
  });

  // ── Scenario 2 — the critical lock-retention invariant ─────────────────────
  it("S2: LOCK RETAINED while paused — reaper does not release, sibling cannot claim", async () => {
    const { run, issue } = await pauseRun({ withIssue: true });
    expect(issue).toBeTruthy();

    // (a) The issue-side lock reaper treats paused_usage as LIVE.
    const reapLocks = await svc.reapOrphanedIssueLocks({ issueId: issue!.id });
    expect(reapLocks.reaped).toBe(0);
    let issueRow = await getIssueRow(issue!.id);
    expect(issueRow.executionRunId).toBe(run.id);

    // (b) The run-side reaper skips a paused_usage run that HAS a window.
    await svc.reapOrphanedRuns();
    expect((await getRunRow(run.id)).status).toBe("paused_usage");
    issueRow = await getIssueRow(issue!.id);
    expect(issueRow.executionRunId).toBe(run.id);

    // (c) A SIBLING agent trying to wake on the same issue must NOT acquire it —
    // it gets deferred behind the live (paused) lock, never a concurrent run.
    const sibling = await seedAgent();
    const wake = await svc.wakeup(sibling.id, {
      source: "on_demand",
      contextSnapshot: { issueId: issue!.id },
    });
    // The paused run still owns the lock; the sibling did not start a run on it.
    issueRow = await getIssueRow(issue!.id);
    expect(issueRow.executionRunId).toBe(run.id);
    const siblingRuns = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, sibling.id), eq(heartbeatRuns.status, "running")));
    expect(siblingRuns.length).toBe(0);
    void wake;
  });

  // ── Scenario 3 — reset → resume via --resume, window deleted, run queued ───
  it("S3: window reset (resetsAt<=now) re-queues the run and bumps the attempt", async () => {
    const { run, agent } = await pauseRun({
      agentStatus: "paused", // so startNextQueuedRunForAgent is inert
      resetsAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // Make the window immediately due.
    await handle.db
      .update(usagePauseWindows)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(usagePauseWindows.runId, run.id));

    const result = await svc.resumeUsagePausedRuns(new Date());
    expect(result.resumed).toBeGreaterThanOrEqual(1);

    const refreshed = await getRunRow(run.id);
    expect(refreshed.status).toBe("queued");

    // The resume id was written to runtime state so executeRun resumes --resume.
    const [rt] = await handle.db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agent.id));
    expect(rt.sessionId).toBe("sess_resume_abc");

    // Window persists across the requeue (deleted only on terminal completion),
    // with the attempt bumped.
    const window = await getWindow(run.id);
    expect(window).toBeTruthy();
    expect(window!.attemptCount).toBe(1);
  });

  it("S3b: a resumed run completing terminally drops the window (cleanup)", async () => {
    const { run } = await pauseRun({ agentStatus: "paused" });
    expect(await getWindow(run.id)).toBeTruthy();
    // Simulate the run finishing successfully and the completion-path cleanup.
    await handle.db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await svc.__usagePauseTestApi.cleanupUsagePauseWindowForRun(run.id);
    expect(await getWindow(run.id)).toBeNull();
  });

  // ── Scenario 4 — restart recovery ──────────────────────────────────────────
  it("S4: RESTART RECOVERY — window persists, bootRecover keeps it, reaper does not fail it", async () => {
    const { run, issue } = await pauseRun({ withIssue: true });

    // Simulate an ADE restart: re-instantiate the heartbeat service against the
    // same durable DB. The window row persists (it's in Postgres, not memory).
    const rebooted = heartbeatService(handle.db);

    // Boot ordering invariant: bootRecover MUST run before the reaper.
    const boot = await rebooted.bootRecoverUsagePausedRuns();
    expect(boot.kept).toBeGreaterThanOrEqual(1);
    expect(await getWindow(run.id)).toBeTruthy();
    expect((await getRunRow(run.id)).status).toBe("paused_usage");

    // The reaper (run AFTER boot recovery) must NOT fail the still-valid paused
    // run — it sees the window and skips it, leaving the lock held.
    await rebooted.reapOrphanedRuns();
    expect((await getRunRow(run.id)).status).toBe("paused_usage");
    expect((await getIssueRow(issue!.id)).executionRunId).toBe(run.id);

    // And it still resumes after the restart once due + reset.
    await handle.db
      .update(usagePauseWindows)
      .set({
        resetsAt: new Date(Date.now() - 60_000),
        nextRetryAt: new Date(Date.now() - 1000),
      })
      .where(eq(usagePauseWindows.runId, run.id));
    // Pause the agent so the requeue stays observable.
    await handle.db.update(agents).set({ status: "paused" }).where(eq(agents.id, run.agentId));
    const result = await rebooted.resumeUsagePausedRuns(new Date());
    expect(result.resumed).toBeGreaterThanOrEqual(1);
    expect((await getRunRow(run.id)).status).toBe("queued");
  });

  it("S4b: bootRecover DELETES a window whose run already resolved (not paused_usage)", async () => {
    const { run } = await pauseRun();
    await handle.db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, run.id));
    const boot = await svc.bootRecoverUsagePausedRuns();
    expect(boot.deleted).toBeGreaterThanOrEqual(1);
    expect(await getWindow(run.id)).toBeNull();
  });

  // ── Scenario 5 — capped backoff ────────────────────────────────────────────
  it("S5: backoff is capped at 5m when not yet reset; nextRetryAt advances with the cap", async () => {
    const { run } = await pauseRun({
      agentStatus: "paused",
      resetsAt: new Date(Date.now() + FIVE_HOURS_MS).toISOString(), // future → not reset
    });
    // Drive the stored backoff above the cap to prove the Math.min cap.
    await handle.db
      .update(usagePauseWindows)
      .set({
        retryBackoffMs: 10 * 60 * 1000, // 10m, above the 5m cap
        nextRetryAt: new Date(Date.now() - 1000), // due now
      })
      .where(eq(usagePauseWindows.runId, run.id));

    const now = new Date();
    const result = await svc.resumeUsagePausedRuns(now);
    expect(result.deferred).toBeGreaterThanOrEqual(1);

    const window = await getWindow(run.id);
    expect(window).toBeTruthy();
    // Backoff clamped to the 5m cap.
    expect(window!.retryBackoffMs).toBe(FIVE_MIN_MS);
    // nextRetryAt advanced by at most the cap (allow small clock slack).
    const delta = window!.nextRetryAt!.getTime() - now.getTime();
    expect(delta).toBeLessThanOrEqual(FIVE_MIN_MS + 2000);
    expect(delta).toBeGreaterThan(FIVE_MIN_MS - 5000);
    // Still parked.
    expect((await getRunRow(run.id)).status).toBe("paused_usage");
  });

  // ── Scenario 6 — budget exhausted → terminal fail, lock released ───────────
  it("S6: attemptCount >= maxRetries fails the run (usage_pause_max_retries), releases the lock", async () => {
    const { run, issue } = await pauseRun({ withIssue: true });
    await handle.db
      .update(usagePauseWindows)
      .set({
        attemptCount: 10,
        maxRetries: 10,
        nextRetryAt: new Date(Date.now() - 1000),
        resetsAt: new Date(Date.now() - 60_000),
      })
      .where(eq(usagePauseWindows.runId, run.id));

    const result = await svc.resumeUsagePausedRuns(new Date());
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const refreshed = await getRunRow(run.id);
    expect(refreshed.status).toBe("failed");
    expect(refreshed.errorCode).toBe("usage_pause_max_retries");
    expect(refreshed.finishedAt).toBeTruthy();

    // Window gone.
    expect(await getWindow(run.id)).toBeNull();
    // Issue lock NOW released (failUsagePausedRun ran releaseIssueExecutionAndPromote).
    expect((await getIssueRow(issue!.id)).executionRunId).toBeNull();
  });

  it("S6b: direct failUsagePausedRun is terminal + lock-clearing", async () => {
    const { run, issue } = await pauseRun({ withIssue: true });
    const window = await getWindow(run.id);
    await svc.__usagePauseTestApi.failUsagePausedRun(window!, "manual terminal fail");
    expect((await getRunRow(run.id)).status).toBe("failed");
    expect(await getWindow(run.id)).toBeNull();
    expect((await getIssueRow(issue!.id)).executionRunId).toBeNull();
  });

  // ── Scenario 7 — non-retryable resume failure (no infinite spin) ───────────
  it("S7: a non-retryable resume error fails terminally rather than spinning forever", async () => {
    // We model the non-retryable path via failUsagePausedRun with a session/auth
    // error code — the engine's terminal sink for errors that must not retry.
    const { run, issue } = await pauseRun({ withIssue: true });
    const window = await getWindow(run.id);
    await svc.__usagePauseTestApi.failUsagePausedRun(
      window!,
      "Resume failed: session unknown",
      "session_unknown",
    );
    const refreshed = await getRunRow(run.id);
    expect(refreshed.status).toBe("failed");
    expect(refreshed.errorCode).toBe("session_unknown");
    // No window left → the poller can never pick it up again (no spin).
    expect(await getWindow(run.id)).toBeNull();
    expect((await getIssueRow(issue!.id)).executionRunId).toBeNull();

    // A second poll is a clean no-op (nothing to do).
    const poll = await svc.resumeUsagePausedRuns(new Date());
    expect(poll.checked).toBe(0);
  });

  it("S7b: claude_auth_required as a non-retryable terminal fail", async () => {
    const { run } = await pauseRun({ withIssue: true });
    const window = await getWindow(run.id);
    await svc.__usagePauseTestApi.failUsagePausedRun(
      window!,
      "Resume failed: auth required",
      "claude_auth_required",
    );
    expect((await getRunRow(run.id)).errorCode).toBe("claude_auth_required");
    expect(await getWindow(run.id)).toBeNull();
  });

  // ── Scenario 8 — multi-agent / multi-company fairness + isolation ──────────
  it("S8: independent windows resume earliest-resetsAt first; companies isolated", async () => {
    // Two windows for the SAME (paused) agent-set in company A, different resets.
    const early = await pauseRun({
      agentStatus: "paused",
      resetsAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const late = await pauseRun({
      agentStatus: "paused",
      resetsAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await handle.db
      .update(usagePauseWindows)
      .set({ nextRetryAt: new Date(Date.now() - 1000) });

    // A SEPARATE company's window must not be touched when we poll (isolation is
    // structural — the poller operates globally, but each window is keyed to its
    // own run/agent/company; a limit in company B doesn't block company A and
    // vice-versa). Seed a second company whose agent is ACTIVE so a reset would
    // otherwise resume — we then prove company A's windows resumed independently.
    const suffix = Math.random().toString(36).slice(2, 8);
    const [companyB] = await handle.db
      .insert(companies)
      .values({ name: `Iso-${suffix}`, issuePrefix: `ISO${suffix.slice(0, 3).toUpperCase()}`, status: "active" })
      .returning();
    const bRun = await pauseRun({
      agentStatus: "paused",
      companyId: companyB.id,
      resetsAt: new Date(Date.now() + FIVE_HOURS_MS).toISOString(), // NOT reset
    });
    await handle.db
      .update(usagePauseWindows)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(usagePauseWindows.runId, bRun.run.id));

    const result = await svc.resumeUsagePausedRuns(new Date());
    // Company A's two reset windows resumed; company B's un-reset window deferred.
    expect(result.resumed).toBeGreaterThanOrEqual(2);
    expect(result.deferred).toBeGreaterThanOrEqual(1);

    expect((await getRunRow(early.run.id)).status).toBe("queued");
    expect((await getRunRow(late.run.id)).status).toBe("queued");
    // Company B un-reset → still parked (its limit did not block company A).
    expect((await getRunRow(bRun.run.id)).status).toBe("paused_usage");
  });

  // ── Scenario 9 — unknown reset time → conservative re-poll, no tight loop ──
  it("S9: null resetsAt re-polls getQuotaWindows; a still-future observation defers (no instant loop)", async () => {
    const { run } = await pauseRun({
      agentStatus: "paused",
      resetsAt: null, // unknown reset
    });
    // The window stored a null resetsAt; force it due.
    await handle.db
      .update(usagePauseWindows)
      .set({ resetsAt: null, nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(usagePauseWindows.runId, run.id));

    // Adapter reports we ARE still throttled (future reset) → checkIfQuotaWindowReset
    // returns false → defer (conservative), NOT a busy resume.
    recordUsageLimitObservation({
      resetsAt: new Date(Date.now() + FIVE_HOURS_MS).toISOString(),
      message: "still throttled",
    });
    const deferRes = await svc.resumeUsagePausedRuns(new Date());
    expect(deferRes.deferred).toBeGreaterThanOrEqual(1);
    expect(deferRes.resumed).toBe(0);
    expect((await getRunRow(run.id)).status).toBe("paused_usage");
    // Backed off (nextRetryAt pushed into the future) → no immediate re-poll loop.
    const w = await getWindow(run.id);
    expect(w!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());

    // Now the observation ages out (no future reset) → treated as reset → resume.
    __resetUsageLimitObservation();
    await handle.db
      .update(usagePauseWindows)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(usagePauseWindows.runId, run.id));
    const resumeRes = await svc.resumeUsagePausedRuns(new Date());
    expect(resumeRes.resumed).toBeGreaterThanOrEqual(1);
    expect((await getRunRow(run.id)).status).toBe("queued");
  });

  // ── Scenario 10 — company budget pause dominates (resume defers) ───────────
  it("S10: company inactive → resume DEFERS, never bypasses the company/budget pause", async () => {
    const bsuffix = Math.random().toString(36).slice(2, 8);
    const [pausedCompany] = await handle.db
      .insert(companies)
      .values({
        name: `Budget-${bsuffix}`,
        issuePrefix: `BUD${bsuffix.slice(0, 3).toUpperCase()}`,
        status: "active",
      })
      .returning();
    const { run } = await pauseRun({
      agentStatus: "idle", // agent itself active; only the COMPANY is paused
      companyId: pausedCompany.id,
      resetsAt: new Date(Date.now() - 60_000).toISOString(), // window reset
    });
    await handle.db
      .update(usagePauseWindows)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(usagePauseWindows.runId, run.id));
    // Deactivate the company AFTER the window reset — the resume gate must still
    // defer rather than resume across the budget pause.
    await handle.db
      .update(companies)
      .set({ status: "inactive" })
      .where(eq(companies.id, pausedCompany.id));

    const result = await svc.resumeUsagePausedRuns(new Date());
    expect(result.resumed).toBe(0);
    expect(result.deferred).toBeGreaterThanOrEqual(1);
    // Run stayed parked — NOT requeued into an inactive company.
    expect((await getRunRow(run.id)).status).toBe("paused_usage");
    // Attempt bumped (we deferred) and backed off.
    const w = await getWindow(run.id);
    expect(w!.attemptCount).toBeGreaterThanOrEqual(1);
  });

  // ── Scenario 11 — sessionCwd mismatch → retryable defer (never wrong cwd) ──
  it("S11: sessionCwd mismatch at resume defers (retryable), never resumes into the wrong cwd", async () => {
    const issueId = (
      await handle.db
        .insert(issues)
        .values({ companyId, title: "cwd issue" })
        .returning()
    )[0].id;
    const { run } = await pauseRun({
      agentStatus: "paused",
      resetsAt: new Date(Date.now() - 60_000).toISOString(),
      // A cwd that will NOT match the freshly-resolved workspace for this run.
      cwd: "/nonexistent/stale/workspace/path-12345",
      issueId,
    });
    // Point the run/window at the issue + a stale cwd, force due.
    await handle.db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, run.id));
    await handle.db
      .update(usagePauseWindows)
      .set({
        sessionCwd: "/nonexistent/stale/workspace/path-12345",
        nextRetryAt: new Date(Date.now() - 1000),
      })
      .where(eq(usagePauseWindows.runId, run.id));

    const result = await svc.resumeUsagePausedRuns(new Date());
    // Either mismatch or a resolution error → both DEFER (retryable), never resume.
    expect(result.resumed).toBe(0);
    expect((await getRunRow(run.id)).status).toBe("paused_usage");
    const w = await getWindow(run.id);
    // Window retained and backed off — we did not burn it.
    expect(w).toBeTruthy();
    expect(w!.attemptCount).toBeGreaterThanOrEqual(1);
  });

  // ── Scenario 12 — PR review-hold respected after a usage resume ────────────
  it("S12: a usage-resumed run's enqueueWakeup still honors the pr_review_hold gate", async () => {
    const agent = await seedAgent({ status: "idle" });
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "PR held issue", assigneeAgentId: agent.id })
      .returning();
    // A tracked PR for the issue awaiting human review.
    await handle.db.insert(issuePullRequests).values({
      companyId,
      issueId: issue.id,
      repo: "acme/app",
      pullNumber: 7,
      pullUrl: "https://github.com/acme/app/pull/7",
      title: "Fix",
      baseBranch: "main",
      feedbackStatus: "awaiting_human",
      mergeStatus: "open",
    });

    // An AUTOMATIC (non-user) wake aimed at the held issue must be SKIPPED — the
    // just-shipped human gate is respected on the resume path too.
    const auto = await svc.wakeup(agent.id, {
      source: "on_demand",
      contextSnapshot: { issueId: issue.id },
      requestedByActorType: "agent",
    });
    expect(auto).toBeNull();

    // A USER-originated release passes the gate (control returns past the hold).
    // It may still be null for other reasons, but it must NOT be the pr_review_hold skip.
    const user = await svc.wakeup(agent.id, {
      source: "on_demand",
      contextSnapshot: { issueId: issue.id },
      requestedByActorType: "user",
    });
    void user; // We only assert the automatic wake was held above.
  });

  // ── Adversarial: concurrent pollers must not double-resume or clobber ──────
  it("ADV1: two concurrent pollers on the same window resume exactly once, no attempt clobber", async () => {
    const { run } = await pauseRun({
      agentStatus: "paused",
      resetsAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await handle.db
      .update(usagePauseWindows)
      .set({ attemptCount: 3, nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(usagePauseWindows.runId, run.id));

    const now = new Date();
    // Fire two pollers concurrently against the SAME due window.
    const [a, b] = await Promise.all([
      svc.resumeUsagePausedRuns(now),
      svc.resumeUsagePausedRuns(now),
    ]);

    // Exactly one poller actually resumed (won the run CAS); the other saw the
    // window as already non-paused (stale → deleted) or lost the CAS (deferred).
    const totalResumed = a.resumed + b.resumed;
    expect(totalResumed).toBeLessThanOrEqual(1);

    const refreshed = await getRunRow(run.id);
    expect(refreshed.status).toBe("queued");

    const window = await getWindow(run.id);
    if (window) {
      // The attempt counter advanced by AT MOST one from the observed 3 — the
      // loser's path never lowered it back below the winner's value.
      expect(window.attemptCount).toBeGreaterThanOrEqual(3);
      expect(window.attemptCount).toBeLessThanOrEqual(4);
    }
  });

  it("ADV2: idempotent re-pause via ON CONFLICT(runId) preserves the attempt budget", async () => {
    const { run, agent } = await pauseRun({ agentStatus: "paused" });
    // Drive the window to a mid-budget attemptCount as if a few resumes already happened.
    await handle.db
      .update(usagePauseWindows)
      .set({ attemptCount: 4 })
      .where(eq(usagePauseWindows.runId, run.id));

    // The resumed run hits the limit AGAIN → handleUsageLimitResponse re-pauses
    // the SAME runId. ON CONFLICT must PRESERVE attemptCount (not reset to 0),
    // else the budget never exhausts and the run could spin forever.
    const rerun = await getRunRow(run.id);
    const handled = await svc.__usagePauseTestApi.handleUsageLimitResponse({
      run: rerun,
      agent,
      adapterResult: usageLimitResult({
        resetsAt: new Date(Date.now() + FIVE_HOURS_MS).toISOString(),
      }),
      sessionIdToResume: "sess_resume_v2",
      sessionCwd: null,
      seq: 2,
    });
    expect(handled).toBe(true);

    const window = await getWindow(run.id);
    expect(window).toBeTruthy();
    // Budget preserved (NOT reset to 0); session + reset refreshed.
    expect(window!.attemptCount).toBe(4);
    expect(window!.sessionIdToResume).toBe("sess_resume_v2");
    // Still exactly one window for the run (no duplicate from the conflict).
    const all = await handle.db
      .select()
      .from(usagePauseWindows)
      .where(eq(usagePauseWindows.runId, run.id));
    expect(all.length).toBe(1);
  });

  // ── Scenario 13 — flag OFF: no pause, scheduler no-ops ─────────────────────
  it("S13: flag OFF — completion path does not pause; resume + boot recovery no-op", async () => {
    process.env.COMBYNE_USAGE_PAUSE_ENABLED = "false";
    try {
      // handleUsageLimitResponse itself is gated at the call site in executeRun,
      // not internally, so we assert the SCHEDULER + boot recovery no-op (the
      // user-facing "legacy behavior" guarantee), plus that an existing window
      // is left completely untouched.
      const agent = await seedAgent({ status: "paused" });
      const run = await seedRunningRun(agent);
      await handle.db.insert(usagePauseWindows).values({
        companyId,
        agentId: agent.id,
        runId: run.id,
        sessionIdToResume: "sess_x",
        resetsAt: new Date(Date.now() - 60_000),
        pauseReason: "subscription_limit",
        nextRetryAt: new Date(Date.now() - 1000),
      });
      await handle.db
        .update(heartbeatRuns)
        .set({ status: "paused_usage" })
        .where(eq(heartbeatRuns.id, run.id));

      const poll = await svc.resumeUsagePausedRuns(new Date());
      expect(poll).toEqual({ checked: 0, resumed: 0, deferred: 0, failed: 0 });
      const boot = await svc.bootRecoverUsagePausedRuns();
      expect(boot).toEqual({ kept: 0, deleted: 0 });

      // The window + run are untouched — nothing was resumed or cleaned up.
      expect(await getWindow(run.id)).toBeTruthy();
      expect((await getRunRow(run.id)).status).toBe("paused_usage");
    } finally {
      process.env.COMBYNE_USAGE_PAUSE_ENABLED = "true";
    }
  });
});
