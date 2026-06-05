// PR-15 memory redaction-queue route contract (§3.6 — the blocking
// redact-before-embed gate):
//   1. GET …/redaction-queue is board-only (non-board → 403) and lists active,
//      non-superseded `needs_review` entries (held OUT of retrieval).
//   2. POST /memory/entries/:id/redaction/resolve is board-only (non-board →
//      403).
//   3. approve-as-clean clears the quarantine → verified (re-enters retrieval)
//      and drains from the queue.
//   4. reject/keep-redacted archives the entry (status='archived') so it never
//      re-surfaces and drains from the queue.
//
// Mounts memoryRoutes(db) on an express app with an injectable req.actor, backed
// by the shared embedded Postgres test DB. A `needs_review` entry is seeded
// directly so the test does not depend on the embedder/secret-scan path.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { agents, companies, memoryEntries } from "@combyne/db";
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

/** Insert an active entry quarantined to needs_review (held out of retrieval). */
async function seedNeedsReview(
  handle: TestDbHandle,
  companyId: string,
  body: string,
): Promise<string> {
  const [row] = await handle.db
    .insert(memoryEntries)
    .values({
      companyId,
      layer: "workspace",
      subject: "Quarantined secret-bearing answer",
      body,
      kind: "note",
      provenance: "human-answer",
      verificationState: "needs_review",
      authorType: "user",
      authorId: "board-user",
      status: "active",
    })
    .returning();
  return row.id;
}

describe("PR-15 memory redaction-queue routes", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let boardActor: Actor;
  let agentActor: Actor;

  beforeAll(async () => {
    handle = await startTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c] = await handle.db
      .insert(companies)
      .values({ name: `RedactCo-${suffix}`, issuePrefix: `R${suffix}` })
      .returning();
    companyId = c.id;
    const [a] = await handle.db
      .insert(agents)
      .values({ companyId, name: "claude", adapterType: "process" })
      .returning();
    agentId = a.id;
    boardActor = { type: "board", source: "local_implicit", userId: "board-user" };
    agentActor = { type: "agent", source: "agent_key", agentId, companyId };
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("GET …/redaction-queue rejects a non-board actor and lists needs_review entries for a board actor", async () => {
    const id = await seedNeedsReview(handle, companyId, "the prod password is hunter2");

    // Non-board (agent) actor is rejected.
    const denied = await request(makeApp(handle, agentActor)).get(
      `/companies/${companyId}/memory/redaction-queue`,
    );
    expect(denied.status).toBe(403);

    // Board actor sees the quarantined entry.
    const res = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/redaction-queue`,
    );
    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find((e) => e.id === id);
    expect(found).toBeTruthy();
    expect(found!.verificationState).toBe("needs_review");
  });

  it("approve-as-clean clears the quarantine → verified and drains the queue", async () => {
    const id = await seedNeedsReview(handle, companyId, "looks clean on second read");

    // Non-board cannot resolve.
    const denied = await request(makeApp(handle, agentActor))
      .post(`/memory/entries/${id}/redaction/resolve`)
      .send({ action: "approve" });
    expect(denied.status).toBe(403);

    const ok = await request(makeApp(handle, boardActor))
      .post(`/memory/entries/${id}/redaction/resolve`)
      .send({ action: "approve" });
    expect(ok.status).toBe(200);
    expect(ok.body.verificationState).toBe("verified");
    expect(ok.body.verifiedBy).toBe("board-user");
    expect(ok.body.verifiedAt).toBeTruthy();

    // Drains from the queue.
    const after = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/redaction-queue`,
    );
    expect((after.body as Array<Record<string, unknown>>).find((e) => e.id === id)).toBeFalsy();
  });

  it("reject/keep-redacted archives the entry so it never re-surfaces", async () => {
    const id = await seedNeedsReview(handle, companyId, "AKIAIOSFODNN7EXAMPLE leaked key");

    const ok = await request(makeApp(handle, boardActor))
      .post(`/memory/entries/${id}/redaction/resolve`)
      .send({ action: "reject" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("archived");

    // No longer in the active needs_review queue.
    const after = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/redaction-queue`,
    );
    expect((after.body as Array<Record<string, unknown>>).find((e) => e.id === id)).toBeFalsy();

    // The row is archived in the DB (preserved for audit, never re-surfaced).
    const [row] = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.id, id));
    expect(row.status).toBe("archived");
  });

  it("resolving a non-needs_review entry returns 404", async () => {
    const svc = memoryService(handle.db);
    const verified = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "An ordinary verified fact",
      body: "Nothing sensitive here.",
      provenance: "human-answer",
      verificationState: "verified",
      authorType: "user",
      authorId: "board-user",
    });
    const res = await request(makeApp(handle, boardActor))
      .post(`/memory/entries/${verified.id}/redaction/resolve`)
      .send({ action: "approve" });
    expect(res.status).toBe(404);
  });
});
