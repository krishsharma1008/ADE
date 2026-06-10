// FINAL_REVIEW M7: the /issues/:id/delegate handler must AWAIT createHandoff so
// the agent_handoffs row is committed BEFORE the wakeup dispatches — otherwise the
// sub-agent's first wake can race the insert and read NO handoff row.
//
// This drives the REAL issueRoutes delegate handler over supertest with a
// board (instance-admin) actor and asserts that, by the time the delegate
// response returns (after the awaited createHandoff + wakeup), the
// agent_handoffs row for the freshly-created sub-issue already exists. With the
// pre-fix `void createHandoff(...)` the insert was fire-and-forget and could be
// absent at this point.

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentHandoffs, agents, companies, issues } from "@combyne/db";
import { issueRoutes } from "../issues.js";
import { errorHandler } from "../../middleware/index.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "../../services/__tests__/_test-db.js";

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

function createApp(handle: TestDbHandle) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Board / instance-admin actor — clears assertCanAssignTasks immediately and
    // carries no agent-run-id requirement on the delegate path.
    (req as unknown as { actor: Record<string, unknown> }).actor = {
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", issueRoutes(handle.db, createStorageStub() as never));
  app.use(errorHandler);
  return app;
}

describe("M7: delegate awaits createHandoff before wakeup", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  let companyId: string;
  let emId: string;
  let engineerId: string;
  let parentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    app = createApp(handle);
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Delegate Race Co", issuePrefix: "DRC" })
      .returning();
    companyId = company.id;
    const [em] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "EM",
        role: "em",
        adapterType: "process",
        permissions: { canAssignTasks: true, taskAssignmentScope: "company" },
      })
      .returning();
    emId = em.id;
    const [engineer] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", role: "engineer", reportsTo: em.id, adapterType: "process" })
      .returning();
    engineerId = engineer.id;
    const [parent] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Parent coordination issue",
        status: "in_progress",
        complexity: "medium",
        assigneeAgentId: emId,
      })
      .returning();
    parentId = parent.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("commits the agent_handoffs row before the delegate response returns", async () => {
    const res = await request(app)
      .post(`/api/issues/${parentId}/delegate`)
      .send({ toAgentId: engineerId, title: "Implement the child slice", complexity: "small" });
    expect(res.status).toBe(201);
    const subIssueId = res.body?.issue?.id;
    expect(typeof subIssueId).toBe("string");

    // The handoff row for the new sub-issue MUST already exist now that the
    // handler awaits createHandoff before dispatching the wakeup.
    const rows = await handle.db
      .select()
      .from(agentHandoffs)
      .where(eq(agentHandoffs.issueId, subIssueId as string));
    expect(rows).toHaveLength(1);
    expect(rows[0].toAgentId).toBe(engineerId);
  });

  // Fix #18 (e2e-run-2026-06-10 round 2): an ambiguous failure made the EM retry
  // /delegate and create two identical subtasks (PINB405-19 + -20), both waking
  // the engineer. The natural-key guard (parent + assignee + title, non-terminal)
  // must return the existing subtask instead of duplicating.
  it("retrying an identical delegate returns the existing subtask (deduplicated)", async () => {
    const payload = { toAgentId: engineerId, title: "Retry-safe delegation slice", complexity: "small" };

    const first = await request(app).post(`/api/issues/${parentId}/delegate`).send(payload);
    expect(first.status).toBe(201);
    const firstId = first.body?.issue?.id as string;

    const retry = await request(app).post(`/api/issues/${parentId}/delegate`).send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body?.deduplicated).toBe(true);
    expect(retry.body?.issue?.id).toBe(firstId);

    const subtasks = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.title, "Retry-safe delegation slice"));
    expect(subtasks).toHaveLength(1);
  });

  it("a delegate with a different title still creates a fresh subtask", async () => {
    const res = await request(app)
      .post(`/api/issues/${parentId}/delegate`)
      .send({ toAgentId: engineerId, title: "A genuinely different slice", complexity: "small" });
    expect(res.status).toBe(201);
    expect(res.body?.deduplicated).toBeUndefined();
  });
});
