// Round 3 Phase 8 — stuck-lock reaper + force-unlock tests.
//
// Covers four scenarios:
//   1. reapOrphanedIssueLocks clears when the referenced run is terminal.
//   2. It leaves issues alone when the run is still queued/running.
//   3. It covers all terminal statuses (succeeded / cancelled / failed).
//   4. forceUnlockIssue clears regardless of run status (operator override).
//
// Note on FK orphan: issues.execution_run_id has ON DELETE SET NULL, so
// the "run was deleted" case auto-heals at the DB level before the reaper
// ever sees it — no test needed (and the state is unreachable).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  heartbeatRuns,
  issues,
} from "@combyne/db";
import { heartbeatService } from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("stuck-locks", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let svc: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Stuck Locks Co" })
      .returning();
    companyId = company.id;
    svc = heartbeatService(handle.db);
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  async function seed(label: string, runStatus: "queued" | "running" | "succeeded" | "failed" | "cancelled") {
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: `Agent-${label}`, adapterType: "process" })
      .returning();
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: agent.id,
        status: runStatus,
        invocationSource: "on_demand",
      })
      .returning();
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: `Issue ${label}`,
        executionRunId: run.id,
        executionAgentNameKey: "agent-key",
        executionLockedAt: new Date(),
      })
      .returning();
    return { agent, run, issue };
  }

  it("clears the lock when the referenced run is terminal", async () => {
    const { issue } = await seed("terminal-failed", "failed");
    const result = await svc.reapOrphanedIssueLocks({ issueId: issue.id });
    expect(result.reaped).toBe(1);
    expect(result.reapedIssues[0]?.runStatus).toBe("failed");
    const [refreshed] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(refreshed.executionRunId).toBeNull();
    expect(refreshed.executionAgentNameKey).toBeNull();
    expect(refreshed.executionLockedAt).toBeNull();
  });

  it("leaves live runs alone (Codex P0 — only clears terminal/absent)", async () => {
    const { issue } = await seed("live-running", "running");
    const result = await svc.reapOrphanedIssueLocks({ issueId: issue.id });
    expect(result.reaped).toBe(0);
    const [refreshed] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(refreshed.executionRunId).not.toBeNull();
  });

  it("leaves queued runs alone as well", async () => {
    const { issue } = await seed("live-queued", "queued");
    const result = await svc.reapOrphanedIssueLocks({ issueId: issue.id });
    expect(result.reaped).toBe(0);
    const [refreshed] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(refreshed.executionRunId).not.toBeNull();
  });

  it("clears for all terminal statuses", async () => {
    const terminalStatuses = ["succeeded", "failed", "cancelled"] as const;
    for (const status of terminalStatuses) {
      const { issue } = await seed(`all-${status}`, status);
      const result = await svc.reapOrphanedIssueLocks({ issueId: issue.id });
      expect(result.reaped).toBe(1);
      expect(result.reapedIssues[0]?.runStatus).toBe(status);
    }
  });

  it("forceUnlockIssue clears even when the run is still running", async () => {
    const { issue } = await seed("force-override", "running");
    const result = await svc.forceUnlockIssue(issue.id, {
      actorType: "user",
      actorId: "operator-1",
    });
    expect(result.cleared).toBe(true);
    expect(result.previousRunStatus).toBe("running");
    const [refreshed] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(refreshed.executionRunId).toBeNull();
  });

  it("forceUnlockIssue is a no-op when no lock is held", async () => {
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-nolock", adapterType: "process" })
      .returning();
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Issue no-lock" })
      .returning();
    const result = await svc.forceUnlockIssue(issue.id, {
      actorType: "user",
      actorId: "operator-1",
    });
    expect(result.cleared).toBe(false);
    expect(result.previousRunId).toBeNull();
    void agent;
  });
});
