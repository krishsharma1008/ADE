// PR-14 memory verify/conflict route contract:
//   1. POST /memory/entries/:id/verify rejects a non-board actor (403) and, for
//      a board actor, stamps verificationState='verified' + verifiedBy/verifiedAt.
//   2. GET …/verify-queue surfaces agent-claims with a distinct-issue reuse count
//      and pending promotions.
//   3. GET …/capture-inbox lists human-tier entries with a source citation.
//   4. GET …/conflicts groups subjectKey rows with >1 distinct human-answer body
//      and pre-highlights the newest entry.
//   5. POST …/conflicts/:subjectKey/resolve is board-only (non-board → 403); a
//      MERGE writes a NEW canonical entry and supersedes BOTH originals (audit).
//
// Mounts memoryRoutes(db) on an express app with an injectable req.actor, backed
// by the shared embedded Postgres test DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { agents, companies, issues, memoryEntries } from "@combyne/db";
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

describe("PR-14 memory verify/conflict routes", () => {
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
      .values({ name: `VerifyCo-${suffix}`, issuePrefix: `V${suffix}` })
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

  it("POST /memory/entries/:id/verify rejects a non-board actor and stamps verified for a board actor", async () => {
    const svc = memoryService(handle.db);
    const entry = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Retry policy uses exponential backoff",
      body: "Retries back off exponentially from 1s to 30s.",
      provenance: "agent-claim",
      authorType: "agent",
      authorId: agentId,
    });
    expect(entry.verificationState).toBe("unverified");

    // Non-board (agent) actor is rejected.
    const rejected = await request(makeApp(handle, agentActor))
      .post(`/memory/entries/${entry.id}/verify`)
      .send({});
    expect(rejected.status).toBe(403);

    // Board actor verifies and the stamp lands.
    const ok = await request(makeApp(handle, boardActor))
      .post(`/memory/entries/${entry.id}/verify`)
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.verificationState).toBe("verified");
    expect(ok.body.verifiedBy).toBe("board-user");
    expect(ok.body.verifiedAt).toBeTruthy();

    // WS-C idempotency: confirming twice must not error or double-stamp, and a
    // dismiss-after-confirm archives without losing the verification audit.
    const again = await request(makeApp(handle, boardActor))
      .post(`/memory/entries/${entry.id}/verify`)
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.verificationState).toBe("verified");
    expect(again.body.verifiedBy).toBe("board-user");

    const dismissed = await request(makeApp(handle, boardActor))
      .patch(`/memory/entries/${entry.id}`)
      .send({ status: "archived" });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe("archived");
    expect(dismissed.body.verificationState).toBe("verified");
  });

  it("GET …/verify-queue surfaces agent-claims with distinct-issue reuse + pending promotions", async () => {
    const svc = memoryService(handle.db);
    const claim = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Auth tokens live 15 minutes",
      body: "Access tokens expire after 15 minutes; refresh rotates.",
      provenance: "agent-claim",
      authorType: "agent",
      authorId: agentId,
    });
    // Two usages across two distinct issues → distinctIssueReuse === 2.
    const [i1] = await handle.db
      .insert(issues)
      .values({ companyId, title: "issue one" })
      .returning();
    const [i2] = await handle.db
      .insert(issues)
      .values({ companyId, title: "issue two" })
      .returning();
    await svc.recordUsage({ entryId: claim.id, companyId, issueId: i1.id, actorType: "agent" });
    await svc.recordUsage({ entryId: claim.id, companyId, issueId: i2.id, actorType: "agent" });

    const res = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/verify-queue`,
    );
    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find(
      (item) => item.kind === "agent-claim" && (item.entry as { id: string }).id === claim.id,
    );
    expect(found).toBeTruthy();
    expect(found!.distinctIssueReuse).toBe(2);
  });

  it("GET …/capture-inbox lists human-tier entries with a source citation", async () => {
    const svc = memoryService(handle.db);
    const issueRefId = "33333333-3333-4333-8333-333333333333";
    const captured = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Deploys go out on Thursdays",
      body: "Production deploys are batched to Thursday afternoons.",
      provenance: "human-answer",
      authorType: "user",
      authorId: "board-user",
      sourceRefType: "issue",
      sourceRefId: issueRefId,
    });
    const res = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/capture-inbox`,
    );
    expect(res.status).toBe(200);
    const item = (res.body as Array<Record<string, unknown>>).find(
      (r) => (r.entry as { id: string }).id === captured.id,
    );
    expect(item).toBeTruthy();
    expect(item!.citation).toBe(`issue #${issueRefId}`);

    // Confirm (verify) stamps verifiedBy → the item drains from the inbox.
    const confirm = await request(makeApp(handle, boardActor)).post(
      `/memory/entries/${captured.id}/verify`,
    );
    expect(confirm.status).toBe(200);
    const after = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/capture-inbox`,
    );
    expect(
      (after.body as Array<Record<string, unknown>>).find(
        (r) => (r.entry as { id: string }).id === captured.id,
      ),
    ).toBeFalsy();
  });

  it("GET …/conflicts groups distinct human-answers and pre-highlights the newest; MERGE supersedes both originals", async () => {
    const svc = memoryService(handle.db);
    // Two human-answers, same subject (→ same subjectKey), DIFFERENT bodies.
    const first = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Topic naming for billing",
      body: "Use snake_case topic names.",
      provenance: "human-answer",
      authorType: "user",
      authorId: "user-a",
      source: "human-answer:billing:1",
    });
    const second = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Topic naming for billing",
      body: "Use dot.delimited lowercase topic names.",
      provenance: "human-answer",
      authorType: "user",
      authorId: "user-b",
      source: "human-answer:billing:2",
    });
    expect(first.subjectKey).toBe(second.subjectKey);
    const subjectKey = first.subjectKey!;

    const list = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/conflicts`,
    );
    expect(list.status).toBe(200);
    const group = (list.body as Array<Record<string, unknown>>).find(
      (g) => g.subjectKey === subjectKey,
    );
    expect(group).toBeTruthy();
    expect((group!.entries as unknown[]).length).toBe(2);
    // Newest (second) is pre-highlighted.
    expect(group!.newestByThatUserId).toBe(second.id);

    // Non-board cannot resolve.
    const denied = await request(makeApp(handle, agentActor))
      .post(`/companies/${companyId}/memory/conflicts/${encodeURIComponent(subjectKey)}/resolve`)
      .send({ action: "merge", body: "Use dot.delimited lowercase topic names (canonical)." });
    expect(denied.status).toBe(403);

    // Board MERGE writes a NEW canonical and supersedes BOTH originals.
    const merged = await request(makeApp(handle, boardActor))
      .post(`/companies/${companyId}/memory/conflicts/${encodeURIComponent(subjectKey)}/resolve`)
      .send({ action: "merge", body: "Use dot.delimited lowercase topic names (canonical)." });
    expect(merged.status).toBe(200);
    const canonicalId = merged.body.id as string;
    expect(canonicalId).not.toBe(first.id);
    expect(canonicalId).not.toBe(second.id);
    expect(merged.body.provenance).toBe("human-answer");
    expect(merged.body.verificationState).toBe("verified");

    // Both originals are superseded to the new canonical (preserved for audit).
    const originals = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), isNull(memoryEntries.supersededById)));
    const survivingIds = originals.map((r) => r.id);
    expect(survivingIds).not.toContain(first.id);
    expect(survivingIds).not.toContain(second.id);

    const firstRow = await svc.getEntry(first.id);
    const secondRow = await svc.getEntry(second.id);
    expect(firstRow!.supersededById).toBe(canonicalId);
    expect(secondRow!.supersededById).toBe(canonicalId);

    // The detected-conflict group is now resolved (no longer listed).
    const after = await request(makeApp(handle, boardActor)).get(
      `/companies/${companyId}/memory/conflicts`,
    );
    expect(
      (after.body as Array<Record<string, unknown>>).find((g) => g.subjectKey === subjectKey),
    ).toBeUndefined();
  });
});
