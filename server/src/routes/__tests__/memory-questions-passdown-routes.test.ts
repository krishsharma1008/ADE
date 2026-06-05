// PR-16 memory questions/passdown route contract:
//   1. GET …/memory/questions lists ALL human-answer entries (acknowledged or
//      not) with their split Q/A, source citation, and answeredAt — the
//      ask-don't-hallucinate loop made visible.
//   2. GET …/memory/passdown-packets reads agent_handoffs joined to issues and
//      parses artifactRefs via isPassdownPacket, surfacing the child issue,
//      complexity tier, entry count, token budget, and the cited (pinned) entries.
//
// Mounts memoryRoutes(db) on an express app with an injectable req.actor, backed
// by the shared embedded Postgres test DB (mirrors memory-verify-routes.test.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { agents, companies, issues } from "@combyne/db";
import { memoryRoutes } from "../memory.js";
import { memoryService } from "../../services/memory.js";
import { createHandoff } from "../../services/agent-handoff.js";
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

describe("PR-16 memory questions/passdown routes", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let toAgentId: string;
  let boardActor: Actor;

  beforeAll(async () => {
    handle = await startTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c] = await handle.db
      .insert(companies)
      .values({ name: `QPCo-${suffix}`, issuePrefix: `Q${suffix}` })
      .returning();
    companyId = c.id;
    const [a] = await handle.db
      .insert(agents)
      .values({ companyId, name: "claude", adapterType: "process" })
      .returning();
    toAgentId = a.id;
    boardActor = { type: "board", source: "local_implicit", userId: "board-user" };
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("GET …/questions lists human-answers (acknowledged or not) with split Q/A, citation, answeredAt", async () => {
    const svc = memoryService(handle.db);
    const refId = "44444444-4444-4444-8444-444444444444";
    const answered = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "How should we name Kafka topics?",
      body: "Q: How should we name Kafka topics?\nA: Use <service>.<entity>.<event>, lowercase.",
      provenance: "human-answer",
      authorType: "user",
      authorId: "board-user",
      sourceRefType: "comment",
      sourceRefId: refId,
    });

    const res = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/questions`,
    );
    expect(res.status).toBe(200);
    const item = (res.body as Array<Record<string, unknown>>).find(
      (r) => (r.entry as { id: string }).id === answered.id,
    );
    expect(item).toBeTruthy();
    expect(item!.question).toBe("How should we name Kafka topics?");
    expect(item!.answer).toBe("Use <service>.<entity>.<event>, lowercase.");
    expect(item!.citation).toBe(`comment #${refId}`);
    expect(item!.answeredAt).toBeTruthy();
    // ALL human-answers show here, including not-yet-acknowledged ones (unlike
    // the capture inbox). This one was never verified → acknowledged === false.
    expect(item!.acknowledged).toBe(false);

    // After a board verify (acknowledge), it STILL appears in Questions (the
    // loop audit), now flagged acknowledged — the key difference from capture.
    await request(makeApp(handle, boardActor)).post(`/memory/entries/${answered.id}/verify`);
    const after = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/questions`,
    );
    const ackd = (after.body as Array<Record<string, unknown>>).find(
      (r) => (r.entry as { id: string }).id === answered.id,
    );
    expect(ackd).toBeTruthy();
    expect(ackd!.acknowledged).toBe(true);
  });

  it("GET …/passdown-packets surfaces handoffs with a non-empty packet + the pinned entries", async () => {
    const svc = memoryService(handle.db);
    // A verified, non-personal, same-company entry is eligible to be pinned. The
    // curated-pin path holds it to the verified-only invariant, so we stamp it
    // verified via the board verify action (shared entries can't be created
    // directly — that path is promotion-gated).
    const pinned = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Deploys go out on Thursdays",
      body: "Production deploys are batched to Thursday afternoons.",
      provenance: "human-answer",
      authorType: "user",
      authorId: "board-user",
    });
    await svc.verifyEntry(pinned.id, "board-user");

    const [child] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Ship the billing migration", serviceScope: "billing" })
      .returning();

    // Delegate-time handoff: pin the verified entry → the packet carries it.
    const handoff = await createHandoff(handle.db, {
      companyId,
      issueId: child.id,
      toAgentId,
      complexity: "medium",
      serviceScope: "billing",
      curatedMemoryEntryIds: [pinned.id],
    });
    expect(handoff).toBeTruthy();

    const res = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/passdown-packets`,
    );
    expect(res.status).toBe(200);
    const packet = (res.body as Array<Record<string, unknown>>).find(
      (p) => p.childIssueId === child.id,
    );
    expect(packet).toBeTruthy();
    expect(packet!.handoffId).toBe(handoff!.id);
    expect(packet!.complexity).toBe("medium");
    expect(packet!.serviceScope).toBe("billing");
    expect(packet!.childIssueTitle).toBe("Ship the billing migration");
    expect(Number(packet!.entryCount)).toBeGreaterThanOrEqual(1);
    expect(Number(packet!.estimatedTokens)).toBeGreaterThan(0);
    const items = packet!.items as Array<Record<string, unknown>>;
    const pinnedItem = items.find((i) => i.entryId === pinned.id);
    expect(pinnedItem).toBeTruthy();
    expect(pinnedItem!.curated).toBe(true);
  });

  it("GET …/passdown-packets omits handoffs whose packet is empty (no vetted context)", async () => {
    // A handoff with NO retrievable/pinned context stores artifactRefs=[] and so
    // must NOT appear in the audit list.
    const [child] = await handle.db
      .insert(issues)
      .values({ companyId, title: "" })
      .returning();
    const handoff = await createHandoff(handle.db, {
      companyId,
      issueId: child.id,
      toAgentId,
      complexity: "small",
    });
    expect(handoff).toBeTruthy();

    const res = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/passdown-packets`,
    );
    expect(res.status).toBe(200);
    expect(
      (res.body as Array<Record<string, unknown>>).find((p) => p.handoffId === handoff!.id),
    ).toBeUndefined();
  });
});
