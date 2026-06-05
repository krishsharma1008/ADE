// FINAL_REVIEW M6: the cross-company GLOBAL memory layer must be browsable from
// the operator UI. GET /companies/:id/memory/entries?layer=global must be HONORED
// (the layer whitelist previously coerced 'global' to undefined, silently dropping
// it) and resolve to the instance-wide company_id=NULL rows — never a company's
// own workspace rows. Per-company isolation for non-global layers is preserved.
//
// Uses an ISOLATED database: this test creates an instance-wide global row
// (company_id NULL), which is cross-company-visible BY DESIGN. Sharing the
// singleton DB would leak that global into sibling per-company-isolation tests.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { companies } from "@combyne/db";
import { memoryRoutes } from "../memory.js";
import { memoryService } from "../../services/memory.js";
import { errorHandler } from "../../middleware/error-handler.js";
import {
  startIsolatedTestDb,
  type TestDbHandle,
} from "../../services/__tests__/_test-db.js";

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

describe("M6: GET /companies/:id/memory/entries honors ?layer=global", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let boardActor: Actor;
  let workspaceId: string;
  let globalId: string;

  beforeAll(async () => {
    handle = await startIsolatedTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c] = await handle.db
      .insert(companies)
      .values({ name: `M6Co-${suffix}`, issuePrefix: `M6${suffix}` })
      .returning();
    companyId = c.id;
    // local_implicit board actor: passes assertCompanyAccess + assertInstanceAdmin.
    boardActor = { type: "board", source: "local_implicit", userId: "board-user" };

    const svc = memoryService(handle.db);
    // A company-scoped workspace row that MUST NOT surface in the global view.
    const workspace = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "m6 route company workspace row",
      body: "This workspace fact is company-scoped only.",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
    });
    workspaceId = workspace.id;
    // A real instance-wide global row (company_id NULL).
    const global = await svc.createEntry({
      companyId: null,
      layer: "global",
      isInstanceAdmin: true,
      subject: "m6 route instance-wide global row",
      body: "This global fact spans every company.",
      source: `global-direct:${crypto.randomUUID()}`,
      provenance: "verified-summary",
      verificationState: "verified",
      confidence: 0.9,
      authorType: "user",
    });
    globalId = global.id;
    expect(global.companyId).toBeNull();
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.stop();
  });

  it("?layer=global returns the company-NULL global rows and NOT the company workspace row", async () => {
    const app = makeApp(handle, boardActor);
    const res = await request(app)
      .get(`/companies/${companyId}/memory/entries`)
      .query({ layer: "global" });
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string; layer: string; companyId: string | null }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(globalId);
    expect(ids).not.toContain(workspaceId);
    // Every returned row is genuinely a global (company_id NULL) entry.
    expect(rows.every((r) => r.layer === "global" && r.companyId === null)).toBe(true);
  });

  it("?layer=workspace stays company-scoped and does NOT leak the global row", async () => {
    const app = makeApp(handle, boardActor);
    const res = await request(app)
      .get(`/companies/${companyId}/memory/entries`)
      .query({ layer: "workspace" });
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string; companyId: string | null }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(workspaceId);
    expect(ids).not.toContain(globalId);
    expect(rows.every((r) => r.companyId === companyId)).toBe(true);
  });
});
