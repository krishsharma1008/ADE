// Onboarding "join an existing team" — full server-side adopt path (integration).
//
// Uses TWO real embedded Postgres instances:
//   - the REGISTRY db plays the shared context DB whose `public.companies` table is
//     the team registry the join lists + verifies membership against.
//   - the OPS db is the local ops DB the route adopts the team into (the injected
//     `db` per app.ts).
//
// Covers the join contract that the stub-based unit tests can't:
//   1. teamId NOT in the registry → 400 'Team not found ...' (open-join membership).
//   2. teamId IN the registry → adoptPinnedCompany creates the local ops row at
//      id===teamId with a NON-default PIN<hex> prefix, ensureMembership grants the
//      board actor access, and the response is joined:true with company + action.
//   3. Re-join is idempotent (action:'kept'), never duplicates membership, and the
//      response still selects + advances.
//   4. A body.url merge-writes contextDatabaseUrl (restartRequired:true) and the
//      redactedEndpoint masks the credential; honoring an already-active rail
//      (no body.url) returns restartRequired:false.

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, companyMemberships } from "@combyne/db";
import { and, eq } from "drizzle-orm";
import { errorHandler } from "../../middleware/error-handler.js";
import { contextDatabaseRoutes } from "../context-database.js";
import { startTestDb, stopTestDb, startIsolatedTestDb, type TestDbHandle } from "../../services/__tests__/_test-db.js";

const adminActor = { type: "board", source: "session", userId: "owner-1", isInstanceAdmin: true };

function makeApp(opsDb: TestDbHandle["db"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = adminActor;
    next();
  });
  app.use(contextDatabaseRoutes(opsDb));
  app.use(errorHandler);
  return app;
}

const uuid = (a: string) => `${a}-3dbe-4d37-b1ad-3a3a8895192c`;

describe("POST /instance/context-database/join — adopt an existing team (integration)", () => {
  let ops: TestDbHandle; // local ops DB (the injected db)
  let registry: TestDbHandle; // the shared context DB whose companies are the team registry
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    ops = await startTestDb();
    registry = await startIsolatedTestDb();
  }, 120_000);

  afterAll(async () => {
    await registry.stop().catch(() => {});
    await stopTestDb();
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxdb-join-"));
    for (const k of ["COMBYNE_CONFIG", "COMBYNE_CONTEXT_DATABASE_URL", "CONTEXT_DATABASE_URL"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.COMBYNE_CONFIG = path.join(tmpDir, "config.json");
    delete process.env.COMBYNE_CONTEXT_DATABASE_URL;
    delete process.env.CONTEXT_DATABASE_URL;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("400s 'Team not found' when teamId is not in the shared registry (open-join check)", async () => {
    const app = makeApp(ops.db);
    const res = await request(app)
      .post("/instance/context-database/join")
      .send({ url: registry.connectionString, teamId: uuid("00000000"), teamName: "Ghost Team" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Team not found in the shared context database registry");
  });

  it("adopts the team locally at id===teamId with a NON-default prefix, grants membership, persists the url", async () => {
    const teamId = uuid("11111111");
    // Seed the team into the REGISTRY db (the shared context DB) — but NOT into ops,
    // so the local adopt is a fresh INSERT.
    await registry.db.insert(companies).values({ id: teamId, name: "Lending", issuePrefix: "REGA" });

    const app = makeApp(ops.db);
    const res = await request(app)
      .post("/instance/context-database/join")
      .send({ url: registry.connectionString, teamId, teamName: "Lending" });

    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(true);
    expect(res.body.action).toBe("inserted");
    expect(res.body.restartRequired).toBe(true); // a NEW url was persisted
    expect(res.body.company.id).toBe(teamId);
    expect(res.body.company.name).toBe("Lending");
    // Fresh adopt → a derived, non-default PIN<hex> prefix (the join contract).
    expect(res.body.company.issuePrefix).not.toBe("PAP");
    expect(res.body.company.issuePrefix.startsWith("PIN")).toBe(true);
    // The credential is masked — never the raw password.
    expect(res.body.redactedEndpoint).toContain("****");
    expect(JSON.stringify(res.body)).not.toContain("combyne@127.0.0.1");

    // The local ops company row now exists at id===teamId (the join mechanism).
    const [local] = await ops.db.select().from(companies).where(eq(companies.id, teamId));
    expect(local).toBeTruthy();
    expect(local.name).toBe("Lending");

    // Membership granted to the board actor so GET /companies surfaces it.
    const memberships = await ops.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, teamId),
          eq(companyMemberships.principalId, "owner-1"),
        ),
      );
    expect(memberships.length).toBe(1);
    expect(memberships[0].status).toBe("active");

    // The url was merge-persisted (restart-gated) for the memory rail.
    const written = JSON.parse(fs.readFileSync(process.env.COMBYNE_CONFIG as string, "utf-8")) as Record<string, unknown>;
    expect(written.contextDatabaseUrl).toBe(registry.connectionString);
    expect(fs.statSync(process.env.COMBYNE_CONFIG as string).mode & 0o777).toBe(0o600);
  });

  it("re-join is idempotent: action:'kept', no duplicate membership, still joined:true", async () => {
    const teamId = uuid("22222222");
    await registry.db.insert(companies).values({ id: teamId, name: "Zapforge", issuePrefix: "REGB" });

    const app = makeApp(ops.db);
    const first = await request(app)
      .post("/instance/context-database/join")
      .send({ url: registry.connectionString, teamId, teamName: "Zapforge" });
    expect(first.status).toBe(200);
    expect(first.body.action).toBe("inserted");

    // Re-join with a DIFFERENT name must NOT rename (no-clobber) and stays kept.
    const second = await request(app)
      .post("/instance/context-database/join")
      .send({ url: registry.connectionString, teamId, teamName: "Renamed Should Be Ignored" });
    expect(second.status).toBe(200);
    expect(second.body.joined).toBe(true);
    expect(second.body.action).toBe("kept");
    expect(second.body.company.name).toBe("Zapforge");

    const [local] = await ops.db.select().from(companies).where(eq(companies.id, teamId));
    expect(local.name).toBe("Zapforge"); // never silently renamed

    const memberships = await ops.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, teamId),
          eq(companyMemberships.principalId, "owner-1"),
        ),
      );
    expect(memberships.length).toBe(1); // idempotent membership, no dup
  });

  it("/teams lists the registry companies sorted by name (open join — every team)", async () => {
    const app = makeApp(ops.db);
    const res = await request(app)
      .post("/instance/context-database/teams")
      .send({ url: registry.connectionString });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const names = res.body.companies.map((c: { name: string }) => c.name);
    // Sorted ascending; includes the teams seeded by earlier tests in this file.
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain("Lending");
    expect(names).toContain("Zapforge");
  });

  it("honors an already-configured rail (no body.url): restartRequired:false, no re-persist", async () => {
    const teamId = uuid("33333333");
    await registry.db.insert(companies).values({ id: teamId, name: "Preconfigured", issuePrefix: "REGC" });
    // Configure the rail via env (resolveContextDbUrl honors COMBYNE_CONTEXT_DATABASE_URL).
    process.env.COMBYNE_CONTEXT_DATABASE_URL = registry.connectionString;

    const app = makeApp(ops.db);
    const res = await request(app)
      .post("/instance/context-database/join")
      .send({ teamId, teamName: "Preconfigured" }); // NO url
    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(true);
    expect(res.body.restartRequired).toBe(false); // nothing newly persisted
    // No config file was written when honoring the already-active rail.
    expect(fs.existsSync(process.env.COMBYNE_CONFIG as string)).toBe(false);

    const [local] = await ops.db.select().from(companies).where(eq(companies.id, teamId));
    expect(local).toBeTruthy(); // adoption still effective immediately
  });
});
