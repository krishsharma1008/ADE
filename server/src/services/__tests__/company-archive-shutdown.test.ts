import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues } from "@combyne/db";
import { companyService } from "../companies.js";
import { heartbeatService } from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("company archive shutdown", () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("pauses company agents and cancels active background work", async () => {
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Archive Shutdown Co", issuePrefix: "ASC" })
      .returning();

    const insertedAgents = await handle.db
      .insert(agents)
      .values([
        { companyId: company.id, name: "Active Agent", status: "active", adapterType: "process" },
        { companyId: company.id, name: "Idle Agent", status: "idle", adapterType: "process" },
        { companyId: company.id, name: "Running Agent", status: "running", adapterType: "process" },
        { companyId: company.id, name: "Error Agent", status: "error", adapterType: "process" },
        { companyId: company.id, name: "Already Paused", status: "paused", adapterType: "process" },
        { companyId: company.id, name: "Pending Agent", status: "pending_approval", adapterType: "process" },
        { companyId: company.id, name: "Terminated Agent", status: "terminated", adapterType: "process" },
      ])
      .returning();
    const [activeAgent, idleAgent, runningAgent] = insertedAgents;

    const runWakeups = await handle.db
      .insert(agentWakeupRequests)
      .values([
        { companyId: company.id, agentId: runningAgent.id, source: "manual", status: "claimed" },
        { companyId: company.id, agentId: activeAgent.id, source: "manual", status: "queued" },
      ])
      .returning();

    const [runningRun, queuedRun, succeededRun] = await handle.db
      .insert(heartbeatRuns)
      .values([
        {
          companyId: company.id,
          agentId: runningAgent.id,
          wakeupRequestId: runWakeups[0]!.id,
          invocationSource: "on_demand",
          status: "running",
        },
        {
          companyId: company.id,
          agentId: activeAgent.id,
          wakeupRequestId: runWakeups[1]!.id,
          invocationSource: "on_demand",
          status: "queued",
        },
        {
          companyId: company.id,
          agentId: idleAgent.id,
          invocationSource: "on_demand",
          status: "succeeded",
        },
      ])
      .returning();

    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Locked issue",
        status: "in_progress",
        assigneeAgentId: runningAgent.id,
        executionRunId: runningRun.id,
        executionAgentNameKey: "running-agent",
        executionLockedAt: new Date(),
      })
      .returning();

    const [deferredWake] = await handle.db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: idleAgent.id,
        source: "automation",
        status: "deferred_issue_execution",
        payload: {
          issueId: issue.id,
          _combyneWakeContext: { issueId: issue.id, taskId: issue.id },
        },
      })
      .returning();

    const archived = await companyService(handle.db).archive(company.id);
    expect(archived?.status).toBe("archived");

    const shutdown = await heartbeatService(handle.db).cancelActiveForCompany(
      company.id,
      "Cancelled because company was archived",
    );
    expect(shutdown.cancelledRuns).toBe(2);

    const agentStatuses = await handle.db
      .select({ name: agents.name, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.companyId, company.id));
    expect(Object.fromEntries(agentStatuses.map((agent) => [agent.name, agent.status]))).toEqual({
      "Active Agent": "paused",
      "Idle Agent": "paused",
      "Running Agent": "paused",
      "Error Agent": "paused",
      "Already Paused": "paused",
      "Pending Agent": "pending_approval",
      "Terminated Agent": "terminated",
    });
    expect(agentStatuses.filter((agent) => agent.status === "paused").every((agent) => agent.pauseReason === "system"))
      .toBe(true);

    const activeRuns = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, company.id), inArray(heartbeatRuns.status, ["queued", "running"])));
    expect(activeRuns).toHaveLength(0);

    const runsById = new Map(
      (await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id)))
        .map((run) => [run.id, run]),
    );
    expect(runsById.get(runningRun.id)?.status).toBe("cancelled");
    expect(runsById.get(queuedRun.id)?.status).toBe("cancelled");
    expect(runsById.get(succeededRun.id)?.status).toBe("succeeded");

    const wakeupsById = new Map(
      (await handle.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id)))
        .map((wakeup) => [wakeup.id, wakeup]),
    );
    expect(wakeupsById.get(runWakeups[0]!.id)?.status).toBe("cancelled");
    expect(wakeupsById.get(runWakeups[1]!.id)?.status).toBe("cancelled");
    expect(wakeupsById.get(deferredWake.id)?.status).toBe("cancelled");

    const [reloadedIssue] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(reloadedIssue.executionRunId).toBeNull();
    expect(reloadedIssue.executionLockedAt).toBeNull();
  });

  it("does not enqueue timer or manual wakes for non-active companies", async () => {
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Paused Timer Co", issuePrefix: "PTC", status: "paused" })
      .returning();
    const [agent] = await handle.db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Timer Agent",
        status: "idle",
        adapterType: "process",
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1 } },
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();

    const heartbeat = heartbeatService(handle.db);
    const tick = await heartbeat.tickTimers(new Date());
    expect(tick.enqueued).toBe(0);

    let runs = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id));
    expect(runs).toHaveLength(0);

    await handle.db
      .update(companies)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(companies.id, company.id));

    const manualRun = await heartbeat.wakeup(agent.id, { source: "on_demand", reason: "operator_check" });
    expect(manualRun).toBeNull();

    runs = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id));
    expect(runs).toHaveLength(0);

    const skippedWakeups = await handle.db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, company.id), eq(agentWakeupRequests.status, "skipped")));
    expect(skippedWakeups.some((wakeup) => wakeup.reason === "company.archived")).toBe(true);
  });
});
