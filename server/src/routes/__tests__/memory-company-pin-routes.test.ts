// Phase B (company-pin enforcement) route contract:
//   When a SEPARATE shared context DB is wired (resolveContextDbUrl() non-empty)
//   AND the team has pinned a canonical company UUID (cfg.contextCompanyId), every
//   company-scoped memory route must address EXACTLY that tenant:
//     - a request to a DIFFERENT companyId → 403 (fail-closed),
//     - a request to the pinned companyId → ok (201/200).
//   With no pin, no context DB, or single-DB mode it is a no-op (the local-first
//   default) — exercised both directly against assertPinnedCompany and via routes.
//
// The pin check (assertPinnedCompany) reads only env-derived config + the
// resolveContextDbUrl() truthiness — it never CONNECTS to the context DB — so the
// fence can be exercised with the local embedded test DB while a DISTINCT
// COMBYNE_CONTEXT_DATABASE_URL flips resolveContextDbUrl() on. The vitest rig forces
// these env vars to "" for single-DB determinism; we override per-test and restore.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { companies } from "@combyne/db";
import { memoryRoutes } from "../memory.js";
import { memoryService } from "../../services/memory.js";
import { assertPinnedCompany } from "../authz.js";
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

const UNPINNED_UUID = "99999999-9999-4999-8999-999999999999";

describe("Phase B memory company-pin enforcement", () => {
  let handle: TestDbHandle;
  let pinnedCompanyId: string;
  let boardActor: Actor;
  // A DISTINCT (non-"") context URL flips resolveContextDbUrl() on (it must differ
  // from cfg.databaseUrl; the rig leaves DATABASE_URL unset → cfg.databaseUrl is
  // undefined, so the test DB URL qualifies as "separate"). We deliberately point
  // it at the SAME embedded test Postgres so the pin fence is ACTIVE while the
  // service write still lands in a reachable DB that has the company row — exercising
  // the real route, not a connection failure to a bogus host.
  let distinctContextUrl: string;

  const savedContextUrl = process.env.COMBYNE_CONTEXT_DATABASE_URL;
  const savedPin = process.env.COMBYNE_CONTEXT_COMPANY_ID;

  beforeAll(async () => {
    handle = await startTestDb();
    distinctContextUrl = handle.connectionString;
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c] = await handle.db
      .insert(companies)
      .values({ name: `PinCo-${suffix}`, issuePrefix: `P${suffix}` })
      .returning();
    pinnedCompanyId = c.id;
    // local_implicit board bypasses the per-company access check, so
    // assertCompanyAccess passes for ANY non-empty companyId — isolating the pin
    // fence as the sole thing that can 403.
    boardActor = { type: "board", source: "local_implicit", userId: "board-user" };
  }, 60_000);

  afterEach(() => {
    // Restore the rig's single-DB determinism after each test.
    process.env.COMBYNE_CONTEXT_DATABASE_URL = savedContextUrl ?? "";
    process.env.COMBYNE_CONTEXT_COMPANY_ID = savedPin ?? "";
  });

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  // ---------- direct unit coverage of the chokepoint ----------

  it("assertPinnedCompany: mismatch throws 403 when a context DB + pin are configured", () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    let thrown: unknown;
    try {
      assertPinnedCompany(UNPINNED_UUID);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect((thrown as { status?: number }).status).toBe(403);
  });

  it("assertPinnedCompany: the pinned id passes", () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    expect(() => assertPinnedCompany(pinnedCompanyId)).not.toThrow();
  });

  it("assertPinnedCompany: a pin WITHOUT a separate context DB is a no-op (single-DB local-first)", () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = "";
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    expect(() => assertPinnedCompany(UNPINNED_UUID)).not.toThrow();
  });

  it("assertPinnedCompany: a context DB but NO pin is a no-op (unenforced)", () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = "";
    expect(() => assertPinnedCompany(UNPINNED_UUID)).not.toThrow();
  });

  it("assertPinnedCompany: global-layer null companyId is exempt", () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    expect(() => assertPinnedCompany(null)).not.toThrow();
  });

  // ---------- route-level contract ----------

  it("POST …/{OTHER}/memory/entries → 403 when OTHER !== pinned and a context DB is configured", async () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    const res = await request(makeApp(handle, boardActor))
      .post(`/companies/${UNPINNED_UUID}/memory/entries`)
      .send({ layer: "workspace", subject: "off-tenant", body: "should be rejected" });
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? "")).toMatch(/pinned context tenant/i);
  });

  it("POST …/{PINNED}/memory/entries → 201 when the companyId matches the pin", async () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    const res = await request(makeApp(handle, boardActor))
      .post(`/companies/${pinnedCompanyId}/memory/entries`)
      .send({ layer: "workspace", subject: "on-tenant fact", body: "captured for the pinned tenant" });
    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe(pinnedCompanyId);
  });

  it("POST …/{OTHER}/memory/entries → NOT pin-blocked in single-DB mode (no separate context DB)", async () => {
    // No context URL → resolveContextDbUrl() === "" → the pin is inert even when set.
    process.env.COMBYNE_CONTEXT_DATABASE_URL = "";
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    // Pin-block does not fire; the request reaches the service and succeeds because
    // the pinned company row exists locally (we post to it to keep the FK valid).
    const res = await request(makeApp(handle, boardActor))
      .post(`/companies/${pinnedCompanyId}/memory/entries`)
      .send({ layer: "workspace", subject: "single-db", body: "no pin fence in single-DB mode" });
    expect(res.status).toBe(201);
  });

  // ---------- Cond 1: the fence is UNIVERSAL across company-scoped routes ----------
  // The user's Condition 1 calls out query/manifest/status routes by name. These
  // prove a READ route and the QUERY route 403 off-tenant, not just the create POST.

  it("GET …/{OTHER}/memory/entries (read) → 403 off-tenant (Cond 1 — reads are fenced too)", async () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    const res = await request(makeApp(handle, boardActor)).get(`/companies/${UNPINNED_UUID}/memory/entries`);
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? "")).toMatch(/pinned context tenant/i);
  });

  it("POST …/{OTHER}/memory/query → 403 off-tenant (Cond 1 — the named query route)", async () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    const res = await request(makeApp(handle, boardActor))
      .post(`/companies/${UNPINNED_UUID}/memory/query`)
      .send({ query: "anything" });
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? "")).toMatch(/pinned context tenant/i);
  });

  it("GET …/{OTHER}/memory/manifest → 403 off-tenant (Cond 1 — the named manifest route)", async () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    const res = await request(makeApp(handle, boardActor)).get(`/companies/${UNPINNED_UUID}/memory/manifest`);
    expect(res.status).toBe(403);
  });

  it("the PINNED id still passes on a read route (no over-blocking)", async () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    const res = await request(makeApp(handle, boardActor)).get(`/companies/${pinnedCompanyId}/memory/entries`);
    expect(res.status).toBe(200);
  });

  // ---------- Cond 1: indirect routes keyed by id (not companyId) honor the pin ----------

  it("POST /memory/promotions/:id/decide → 403 when the promotion's company ≠ pin (P1-c)", async () => {
    // Seed an OFF-TENANT source entry + a promotion BEFORE the pin is active (service
    // writes don't check the pin; only routes do).
    const svc = memoryService(handle.db);
    const src = await svc.createEntry({
      companyId: UNPINNED_UUID,
      layer: "workspace",
      kind: "fact",
      subject: "off-tenant source",
      body: "promote me",
      authorType: "user",
    });
    const promotion = await svc.proposePromotion({
      companyId: UNPINNED_UUID,
      sourceEntryId: src.id,
      proposerType: "user",
      proposerId: "seed",
    });
    expect(promotion).toBeTruthy();

    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    const res = await request(makeApp(handle, boardActor))
      .post(`/memory/promotions/${promotion!.id}/decide`)
      .send({ decision: "approved" });
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? "")).toMatch(/pinned context tenant/i);
  });

  it("POST /memory/global/promote → 403 when the SOURCE entry's company ≠ pin (P2-a, anti-laundering)", async () => {
    const svc = memoryService(handle.db);
    const src = await svc.createEntry({
      companyId: UNPINNED_UUID,
      layer: "workspace",
      kind: "fact",
      subject: "off-tenant fact",
      body: "should not be launderable into global",
      verificationState: "verified",
      authorType: "user",
    });

    process.env.COMBYNE_CONTEXT_DATABASE_URL = distinctContextUrl;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    const res = await request(makeApp(handle, boardActor))
      .post(`/memory/global/promote`)
      .send({ sourceEntryId: src.id });
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? "")).toMatch(/pinned context tenant/i);
  });
});
