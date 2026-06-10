// Fix #15 (e2e-run-2026-06-10 round 2): a dev-server reload orphaned in-flight
// runs TWICE during live testing — the reaper marked them interrupted_recoverable
// and nothing requeued the work, so issues sat in_progress with no run until a
// manual wake. The reaper must now RE-DELIVER the interrupted work (a wake
// carrying the original contextSnapshot), and a loop guard must stop retrying
// after 3+ interruptions in 15 minutes (live failure mode: the central context
// DB outage produced a 5-minute reap loop that burned tokens).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issueComments,
  issues,
} from "@combyne/db";
import { heartbeatService } from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("fix #15: orphan reaper re-delivers interrupted runs, loop guard stops systemic retry", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Reaper Co", issuePrefix: "RPR" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  async function makeAgent(name: string) {
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name, role: "engineer", adapterType: "process", status: "idle" })
      .returning();
    return agent;
  }

  async function insertStaleRunningRun(agentId: string, issueId: string) {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "running",
        invocationSource: "on_demand",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "assignment" },
        startedAt: twoMinAgo,
        createdAt: twoMinAgo,
        updatedAt: twoMinAgo,
      })
      .returning();
    return run;
  }

  it("re-delivers an interrupted run as a wake carrying the original context", async () => {
    const agent = await makeAgent("Engineer-redelivery");
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Interrupted work", status: "in_progress", assigneeAgentId: agent.id })
      .returning();
    const run = await insertStaleRunningRun(agent.id, issue.id);

    const heartbeat = heartbeatService(handle.db);
    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 60_000 });
    expect(result.runIds).toContain(run.id);

    const [reaped] = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(reaped.status).toBe("interrupted_recoverable");

    // The work is re-queued: a redelivery wake exists for the agent and carries
    // the interrupted run's contextSnapshot (issue binding survives the restart).
    const wakes = await handle.db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agent.id),
          eq(agentWakeupRequests.reason, "interrupted_run_redelivery"),
        ),
      );
    expect(wakes.length).toBeGreaterThanOrEqual(1);
    const payload = wakes[0].payload as Record<string, unknown> | null;
    expect(payload?.issueId).toBe(issue.id);
  });

  it("loop guard: 3+ interruptions in 15 minutes pause retries and mark the agent error", async () => {
    const agent = await makeAgent("Engineer-loopguard");
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Systemic failure work", status: "in_progress", assigneeAgentId: agent.id })
      .returning();

    // Two recent interruptions already on record; the third (this reap) trips the guard.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    for (let i = 0; i < 2; i++) {
      await handle.db.insert(heartbeatRuns).values({
        companyId,
        agentId: agent.id,
        status: "interrupted_recoverable",
        invocationSource: "on_demand",
        contextSnapshot: { issueId: issue.id },
        startedAt: fiveMinAgo,
        createdAt: fiveMinAgo,
        updatedAt: fiveMinAgo,
        finishedAt: fiveMinAgo,
      });
    }
    const run = await insertStaleRunningRun(agent.id, issue.id);

    const heartbeat = heartbeatService(handle.db);
    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 60_000 });
    expect(result.runIds).toContain(run.id);

    // No redelivery wake — the guard stops the retry loop.
    const wakes = await handle.db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agent.id),
          eq(agentWakeupRequests.reason, "interrupted_run_redelivery"),
        ),
      );
    expect(wakes).toHaveLength(0);

    // The agent is surfaced as error (not silently idle) …
    const [pausedAgent] = await handle.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(pausedAgent.status).toBe("error");

    // … and the issue carries the explanation for the human.
    const comments = await handle.db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comments.some((c) => c.body.includes("interrupted 3+ times"))).toBe(true);
  });
});
