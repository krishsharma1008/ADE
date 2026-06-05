// FINAL_REVIEW M5: agent-reachable retrieval routes must apply the §3.2
// verified-only trust filter for an AGENT actor (so an unverified agent-claim can
// never be read back as fact), while a human/board actor browses unfiltered.
//
//   - POST /companies/:id/memory/query
//   - GET  /companies/:id/memory/manifest
//
// Mounts memoryRoutes(db) on an express app with an injectable req.actor, backed
// by the shared embedded Postgres test DB (mirrors memory-verify-routes.test.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { companies, agents, issues } from "@combyne/db";
import { memoryRoutes } from "../memory.js";
import { memoryService } from "../../services/memory.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "../../services/__tests__/_test-db.js";

type Actor = Record<string, unknown>;

function makeApp(handle: TestDbHandle, actor: Actor): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Actor }).actor = actor;
    next();
  });
  app.use(memoryRoutes(handle.db));
  app.use(errorHandler);
  return app;
}

describe("M5: agent-reachable memory routes apply verified-only retrieval", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let boardActor: Actor;
  let agentActor: Actor;
  let verifiedId: string;
  let unverifiedId: string;
  let taskId: string;

  // A unique nonce so the query matches ONLY our two seed rows.
  const nonce = "xyzzyflarn";

  beforeAll(async () => {
    handle = await startTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c] = await handle.db
      .insert(companies)
      .values({ name: `M5Co-${suffix}`, issuePrefix: `M5${suffix}` })
      .returning();
    companyId = c.id;
    const [a] = await handle.db
      .insert(agents)
      .values({ companyId, name: "claude", adapterType: "process" })
      .returning();
    agentId = a.id;
    boardActor = { type: "board", source: "local_implicit", userId: "board-user" };
    agentActor = { type: "agent", source: "agent_key", agentId, companyId };

    const svc = memoryService(handle.db);
    // A VERIFIED human-answer workspace row.
    const verified = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: `${nonce} verified deploy convention`,
      body: `The ${nonce} service deploys via blue-green rollouts.`,
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
    });
    verifiedId = verified.id;
    // An UNVERIFIED agent-claim workspace row matching the SAME query.
    const unverified = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: `${nonce} unverified deploy claim`,
      body: `The ${nonce} service deploys via a hand-rolled script (unconfirmed).`,
      provenance: "agent-claim",
      authorType: "agent",
      authorId: agentId,
    });
    unverifiedId = unverified.id;
    expect(unverified.verificationState).toBe("unverified");

    // A task whose title seeds the manifest query text with the same nonce.
    const [t] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: `${nonce} deploy rollout`,
        description: `How does the ${nonce} service deploy?`,
        assigneeAgentId: agentId,
      })
      .returning();
    taskId = t.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("POST /memory/query: an AGENT actor's response EXCLUDES the unverified agent-claim", async () => {
    const app = makeApp(handle, agentActor);
    const res = await request(app)
      .post(`/companies/${companyId}/memory/query`)
      .send({ query: `${nonce} deploy`, limit: 20 });
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(verifiedId);
    expect(ids).not.toContain(unverifiedId);
  });

  it("POST /memory/query: a BOARD actor's response INCLUDES the unverified agent-claim", async () => {
    const app = makeApp(handle, boardActor);
    const res = await request(app)
      .post(`/companies/${companyId}/memory/query`)
      .send({ query: `${nonce} deploy`, limit: 20 });
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(verifiedId);
    expect(ids).toContain(unverifiedId);
  });

  it("GET /memory/manifest: an AGENT actor's manifest EXCLUDES the unverified agent-claim", async () => {
    const app = makeApp(handle, agentActor);
    const res = await request(app)
      .get(`/companies/${companyId}/memory/manifest`)
      .query({ taskId, limit: 20 });
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(verifiedId);
    expect(ids).not.toContain(unverifiedId);
  });

  it("GET /memory/manifest: a BOARD actor's manifest INCLUDES the unverified agent-claim", async () => {
    const app = makeApp(handle, boardActor);
    const res = await request(app)
      .get(`/companies/${companyId}/memory/manifest`)
      .query({ taskId, limit: 20 });
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(unverifiedId);
  });
});
