// F5 (e2e-run-2026-06-10 finding #5): a wake targeting a paused agent must never be
// silently lost. enqueueWakeup persists a skipped agent_wakeup_requests row (reason
// "agent.not_invokable.<status>") and surfaces a system comment on the target issue
// before throwing its 409; the resume route then consumes those rows and re-enqueues
// exactly one queue-rescan wake.

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, issueComments, issues } from "@combyne/db";
import { agentRoutes } from "../../routes/agents.js";
import { errorHandler } from "../../middleware/index.js";
import { heartbeatService } from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

function createApp(handle: TestDbHandle) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = {
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", agentRoutes(handle.db));
  app.use(errorHandler);
  return app;
}

async function wakeRows(handle: TestDbHandle, agentId: string, status?: string) {
  return handle.db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      reason: agentWakeupRequests.reason,
    })
    .from(agentWakeupRequests)
    .where(
      status
        ? and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, status))
        : eq(agentWakeupRequests.agentId, agentId),
    );
}

describe("F5: paused-agent wakes are persisted, surfaced, and redelivered on resume", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    app = createApp(handle);
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Wake Loss Co", issuePrefix: "WLC" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  async function seedPausedAgentWithIssue() {
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Paused EM", adapterType: "process", status: "paused" })
      .returning();
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Ticket for paused agent", status: "todo", assigneeAgentId: agent.id })
      .returning();
    return { agent, issue };
  }

  it("records a skipped row + system comment and still throws 409", async () => {
    const { agent, issue } = await seedPausedAgentWithIssue();
    const heartbeat = heartbeatService(handle.db);

    await expect(
      heartbeat.wakeup(agent.id, {
        source: "assignment",
        reason: "issue_assigned",
        payload: { issueId: issue.id },
      }),
    ).rejects.toMatchObject({ status: 409 });

    const skipped = await wakeRows(handle, agent.id, "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("agent.not_invokable.paused");

    const comments = await handle.db
      .select({ body: issueComments.body, kind: issueComments.kind })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0].kind).toBe("system");
    expect(comments[0].body).toContain("Wake for @Paused EM skipped");

    // Second missed wake for the same issue dedupes the comment but records the row.
    await expect(
      heartbeat.wakeup(agent.id, {
        source: "assignment",
        reason: "issue_assigned",
        payload: { issueId: issue.id },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const commentsAfter = await handle.db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(commentsAfter).toHaveLength(1);
    expect(await wakeRows(handle, agent.id, "skipped")).toHaveLength(2);
  });

  it("resume consumes the missed wakes and enqueues exactly one rescan wake", async () => {
    const { agent } = await seedPausedAgentWithIssue();
    const heartbeat = heartbeatService(handle.db);
    await expect(heartbeat.wakeup(agent.id, { source: "assignment" })).rejects.toMatchObject({
      status: 409,
    });

    const res = await request(app).post(`/api/agents/${agent.id}/resume`).send({});
    expect(res.status).toBe(200);

    // The wake may already be claimed by the in-process scheduler — assert on the
    // enqueued attempt (reason), not the transient status.
    const rescans = (await wakeRows(handle, agent.id)).filter(
      (row) => row.reason === "agent_resumed_rescan",
    );
    expect(rescans).toHaveLength(1);

    // The skipped row was consumed: prefixed so a future resume won't re-deliver it.
    const redelivered = await handle.db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agent.id),
          like(agentWakeupRequests.reason, "redelivered.agent.not_invokable%"),
        ),
      );
    expect(redelivered).toHaveLength(1);
  });

  it("resume with no missed wakes and no open assigned issues enqueues nothing", async () => {
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Idle Loner", adapterType: "process", status: "paused" })
      .returning();

    const res = await request(app).post(`/api/agents/${agent.id}/resume`).send({});
    expect(res.status).toBe(200);

    expect(await wakeRows(handle, agent.id)).toHaveLength(0);
  });

  it("resume with an open assigned issue (but no recorded miss) still wakes once", async () => {
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Busy Resumer", adapterType: "process", status: "paused" })
      .returning();
    await handle.db
      .insert(issues)
      .values({ companyId, title: "Waiting work", status: "todo", assigneeAgentId: agent.id });

    const res = await request(app).post(`/api/agents/${agent.id}/resume`).send({});
    expect(res.status).toBe(200);

    const rescans = (await wakeRows(handle, agent.id)).filter(
      (row) => row.reason === "agent_resumed_rescan",
    );
    expect(rescans).toHaveLength(1);
  });
});
