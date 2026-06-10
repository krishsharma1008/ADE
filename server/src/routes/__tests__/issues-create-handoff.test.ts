// F6 (e2e-run-2026-06-10 finding #6): an agent creating an ASSIGNED subtask through
// the generic POST /companies/:companyId/issues endpoint is a delegation, but the
// route never called createHandoff — so the EM→engineer passdown rail (vetted
// central-DB memory packet in agent_handoffs.artifactRefs) was silently skipped.
// The route must now build the handoff (awaited BEFORE the wake, M7 race rule)
// exactly like POST /issues/:id/delegate.

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

type ActorShape = Record<string, unknown>;

function createApp(handle: TestDbHandle, actorRef: { current: ActorShape }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: ActorShape }).actor = actorRef.current;
    next();
  });
  app.use("/api", issueRoutes(handle.db, createStorageStub() as never));
  app.use(errorHandler);
  return app;
}

describe("F6: generic subtask create builds the delegation handoff/passdown", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  const actorRef: { current: ActorShape } = { current: {} };
  let companyId: string;
  let emId: string;
  let engineerId: string;
  let parentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    app = createApp(handle, actorRef);
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Handoff Co", issuePrefix: "HOC" })
      .returning();
    companyId = company.id;
    const [em] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "EM",
        adapterType: "process",
        permissions: { canAssignTasks: true, taskAssignmentScope: "company" },
      })
      .returning();
    emId = em.id;
    const [engineer] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", adapterType: "process" })
      .returning();
    engineerId = engineer.id;
    const [parent] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Parent ticket",
        status: "in_progress",
        assigneeAgentId: emId,
        serviceScope: "krish-buku/fs-brick-service-test",
      })
      .returning();
    parentId = parent.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  function asAgent(agentId: string) {
    actorRef.current = { type: "agent", agentId, companyId, source: "agent_jwt" };
  }

  function asBoard() {
    actorRef.current = {
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    };
  }

  async function handoffsFor(issueId: string) {
    return handle.db
      .select({
        id: agentHandoffs.id,
        fromAgentId: agentHandoffs.fromAgentId,
        toAgentId: agentHandoffs.toAgentId,
        brief: agentHandoffs.brief,
        artifactRefs: agentHandoffs.artifactRefs,
      })
      .from(agentHandoffs)
      .where(eq(agentHandoffs.issueId, issueId));
  }

  it("agent-created assigned subtask -> handoff row exists by response time", async () => {
    asAgent(emId);
    const res = await request(app).post(`/api/companies/${companyId}/issues`).send({
      title: "Refactor VeefinLosProvider",
      description: "Extract constants, fix raw generics.",
      status: "todo",
      parentId,
      assigneeAgentId: engineerId,
    });
    expect(res.status).toBe(201);

    const rows = await handoffsFor(res.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].fromAgentId).toBe(emId);
    expect(rows[0].toAgentId).toBe(engineerId);
    expect(rows[0].brief).toContain("Refactor VeefinLosProvider");
  });

  it("user-created issue with agent assignee -> no handoff", async () => {
    asBoard();
    const res = await request(app).post(`/api/companies/${companyId}/issues`).send({
      title: "Board-created task",
      status: "todo",
      parentId,
      assigneeAgentId: engineerId,
    });
    expect(res.status).toBe(201);
    expect(await handoffsFor(res.body.id)).toHaveLength(0);
  });

  it("agent self-assigned subtask -> no handoff", async () => {
    asAgent(emId);
    const res = await request(app).post(`/api/companies/${companyId}/issues`).send({
      title: "EM keeps this one",
      status: "todo",
      parentId,
      assigneeAgentId: emId,
    });
    expect(res.status).toBe(201);
    expect(await handoffsFor(res.body.id)).toHaveLength(0);
  });

  it("agent-created top-level issue (no parent) -> no handoff", async () => {
    asAgent(emId);
    const res = await request(app).post(`/api/companies/${companyId}/issues`).send({
      title: "Standalone task",
      status: "todo",
      assigneeAgentId: engineerId,
    });
    expect(res.status).toBe(201);
    expect(await handoffsFor(res.body.id)).toHaveLength(0);
  });
});
