// Issue 4 Part 2 — usage-pause / resume engine tests.
//
// Focuses on the correctness-critical behaviors of the engine that are hard to
// get right and dangerous to break:
//   1. LOCK-LIVE: reapOrphanedIssueLocks treats `paused_usage` as a live lock
//      holder (never clears the issue lock).
//   2. LOCK-LIVE: reapOrphanedRuns skips a `paused_usage` run that HAS a window
//      (the poller owns it) and recovers one whose window is MISSING (corrupt).
//   3. bootRecoverUsagePausedRuns deletes stale windows (run gone / not paused)
//      and keeps valid ones.
//   4. resumeUsagePausedRuns defers when the window has NOT reset and re-queues
//      when it HAS reset (agent paused so no real adapter process spawns).
//   5. The feature gate: with the flag off, the poller and boot recovery no-op.
//
// The resume path re-dispatches through startNextQueuedRunForAgent, which is a
// no-op for a paused agent (isAgentStatusInvokable === false). We use that to
// observe the run flipping paused_usage -> queued without spawning a process.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  heartbeatRuns,
  issues,
  usagePauseWindows,
} from "@combyne/db";
import { heartbeatService } from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("usage-pause engine (Issue 4 Part 2)", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let svc: ReturnType<typeof heartbeatService>;
  const prevFlag = process.env.COMBYNE_USAGE_PAUSE_ENABLED;

  beforeAll(async () => {
    handle = await startTestDb();
    process.env.COMBYNE_USAGE_PAUSE_ENABLED = "true";
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Usage Pause Engine Co", status: "active" })
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
    await handle.db.delete(usagePauseWindows);
  });

  async function seedPausedRun(opts?: {
    agentStatus?: string;
    withWindow?: boolean;
    resetsAt?: Date | null;
    nextRetryAt?: Date | null;
    withIssueLock?: boolean;
  }) {
    const [agent] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: `Agent-${Math.random().toString(36).slice(2, 8)}`,
        adapterType: "claude_local",
        status: opts?.agentStatus ?? "idle",
      })
      .returning();
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: agent.id,
        status: "paused_usage",
        invocationSource: "on_demand",
        startedAt: new Date(),
      })
      .returning();

    let issue: typeof issues.$inferSelect | null = null;
    if (opts?.withIssueLock) {
      [issue] = await handle.db
        .insert(issues)
        .values({
          companyId,
          title: "Locked issue",
          executionRunId: run.id,
          executionAgentNameKey: "agent-key",
          executionLockedAt: new Date(),
        })
        .returning();
    }

    if (opts?.withWindow ?? true) {
      await handle.db.insert(usagePauseWindows).values({
        companyId,
        agentId: agent.id,
        runId: run.id,
        sessionIdToResume: "sess_resume_1",
        sessionCwd: null,
        resetsAt: opts?.resetsAt ?? new Date(Date.now() + 5 * 60 * 60 * 1000),
        pauseReason: opts?.resetsAt === null ? "unknown_reset_time" : "subscription_limit",
        nextRetryAt: opts?.nextRetryAt ?? new Date(Date.now() - 1000),
      });
    }

    return { agent, run, issue };
  }

  it("reapOrphanedIssueLocks treats paused_usage as a LIVE lock (never clears)", async () => {
    const { issue } = await seedPausedRun({ withIssueLock: true });
    const result = await svc.reapOrphanedIssueLocks({ issueId: issue!.id });
    expect(result.reaped).toBe(0);
    const [refreshed] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, issue!.id));
    expect(refreshed.executionRunId).not.toBeNull();
  });

  it("reapOrphanedRuns SKIPS a paused_usage run that has a window", async () => {
    const { run } = await seedPausedRun({ withWindow: true });
    await svc.reapOrphanedRuns();
    const [refreshed] = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    // Still parked — the poller owns it.
    expect(refreshed.status).toBe("paused_usage");
  });

  it("reapOrphanedRuns RECOVERS a paused_usage run whose window is missing", async () => {
    const { run } = await seedPausedRun({ withWindow: false });
    await svc.reapOrphanedRuns();
    const [refreshed] = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    // No window => corrupt pause => recovered (no longer paused_usage).
    expect(refreshed.status).not.toBe("paused_usage");
  });

  it("bootRecoverUsagePausedRuns keeps valid windows and deletes stale ones", async () => {
    // Valid: run is paused_usage with a window.
    const valid = await seedPausedRun({ withWindow: true });
    // Stale: run flipped to succeeded but its window leaked.
    const stale = await seedPausedRun({ withWindow: true });
    await handle.db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, stale.run.id));

    const result = await svc.bootRecoverUsagePausedRuns();
    expect(result.kept).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const [validWindow] = await handle.db
      .select()
      .from(usagePauseWindows)
      .where(eq(usagePauseWindows.runId, valid.run.id));
    expect(validWindow).toBeTruthy();
    const staleWindow = await handle.db
      .select()
      .from(usagePauseWindows)
      .where(eq(usagePauseWindows.runId, stale.run.id));
    expect(staleWindow.length).toBe(0);
  });

  it("resumeUsagePausedRuns DEFERS when the window has not reset", async () => {
    const { run } = await seedPausedRun({
      agentStatus: "paused",
      resetsAt: new Date(Date.now() + 60 * 60 * 1000), // future
      nextRetryAt: new Date(Date.now() - 1000), // due
    });
    const result = await svc.resumeUsagePausedRuns(new Date());
    expect(result.deferred).toBeGreaterThanOrEqual(1);
    const [refreshed] = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(refreshed.status).toBe("paused_usage"); // still parked

    const [window] = await handle.db
      .select()
      .from(usagePauseWindows)
      .where(eq(usagePauseWindows.runId, run.id));
    expect(window).toBeTruthy(); // window retained
    expect(window.nextRetryAt!.getTime()).toBeGreaterThan(Date.now()); // backed off
  });

  it("resumeUsagePausedRuns RE-QUEUES when the window has reset", async () => {
    // Agent paused so startNextQueuedRunForAgent no-ops (no real process spawn).
    const { run } = await seedPausedRun({
      agentStatus: "paused",
      resetsAt: new Date(Date.now() - 60 * 1000), // already reset
      nextRetryAt: new Date(Date.now() - 1000), // due
    });
    const result = await svc.resumeUsagePausedRuns(new Date());
    expect(result.resumed).toBeGreaterThanOrEqual(1);
    const [refreshed] = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(refreshed.status).toBe("queued"); // re-dispatched into the queue
  });

  it("resumeUsagePausedRuns FAILS a run whose retry budget is exhausted", async () => {
    const { run, agent } = await seedPausedRun({
      withIssueLock: true,
      resetsAt: new Date(Date.now() - 60 * 1000),
      nextRetryAt: new Date(Date.now() - 1000),
    });
    // Drive attemptCount to maxRetries.
    await handle.db
      .update(usagePauseWindows)
      .set({ attemptCount: 10, maxRetries: 10 })
      .where(eq(usagePauseWindows.runId, run.id));

    const result = await svc.resumeUsagePausedRuns(new Date());
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const [refreshed] = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(refreshed.status).toBe("failed");
    expect(refreshed.errorCode).toBe("usage_pause_max_retries");

    // Window deleted and the issue lock released (finalize path ran).
    const windows = await handle.db
      .select()
      .from(usagePauseWindows)
      .where(eq(usagePauseWindows.runId, run.id));
    expect(windows.length).toBe(0);
    void agent;
  });

  it("resumeUsagePausedRuns DELETES a window whose run is no longer paused", async () => {
    const { run } = await seedPausedRun({ withWindow: true });
    await handle.db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, run.id));
    await svc.resumeUsagePausedRuns(new Date());
    const windows = await handle.db
      .select()
      .from(usagePauseWindows)
      .where(eq(usagePauseWindows.runId, run.id));
    expect(windows.length).toBe(0);
  });

  it("respects the feature flag: poller + boot recovery no-op when off", async () => {
    await seedPausedRun({
      withWindow: true,
      resetsAt: new Date(Date.now() - 60 * 1000),
      nextRetryAt: new Date(Date.now() - 1000),
    });
    process.env.COMBYNE_USAGE_PAUSE_ENABLED = "false";
    try {
      const poll = await svc.resumeUsagePausedRuns(new Date());
      expect(poll).toEqual({ checked: 0, resumed: 0, deferred: 0, failed: 0 });
      const boot = await svc.bootRecoverUsagePausedRuns();
      expect(boot).toEqual({ kept: 0, deleted: 0 });
    } finally {
      process.env.COMBYNE_USAGE_PAUSE_ENABLED = "true";
    }
  });
});
