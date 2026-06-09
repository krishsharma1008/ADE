// Server-side context-database management routes (instance-admin only).
//
// Covers the contract that matters for the credential surface and the gate:
//   1. A non-admin board actor and an agent actor are rejected 403 on all three.
//   2. The password is REDACTED (****) in the GET status response and the
//      /test probe response — the raw credential never leaves the server.
//   3. /test against an UNREACHABLE url returns { ok:false } (200), NOT a 500.
//   4. /save merge-writes contextDatabaseUrl into config.json and the GET
//      status then reflects configuredVia:'config-file'.
//
// The routes are mounted with an injectable actor + a stubbed Db, so no live
// Postgres is required. The real config-file writer is exercised against an
// isolated temp config path (COMBYNE_CONFIG).

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@combyne/db";
import { errorHandler } from "../../middleware/error-handler.js";
import { contextDatabaseRoutes, redactDbUrl } from "../context-database.js";

const DB_URL_WITH_PASSWORD = "postgres://admin:supersecret@db.internal:5432/combyne";
const SECRET = "supersecret";

// A Db whose execute() returns a row carrying every column the readers look
// for. Each reader picks its own field, so we don't need to discriminate on the
// (opaque) drizzle SQL object.
function stubDb(): Db {
  const execute = async () => [
    { version: "PostgreSQL 16.2 (stub)", present: true, count: 7 },
  ];
  return { execute } as unknown as Db;
}

function makeApp(actor: Record<string, unknown>, db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use(contextDatabaseRoutes(db));
  app.use(errorHandler);
  return app;
}

const adminActor = { type: "board", source: "session", userId: "u1", isInstanceAdmin: true };
const nonAdminBoardActor = { type: "board", source: "session", userId: "u2", isInstanceAdmin: false };
const agentActor = { type: "agent", source: "agent_key", agentId: "a1", companyId: "c1" };

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxdb-test-"));
  for (const k of ["COMBYNE_CONFIG", "DATABASE_URL", "COMBYNE_CONTEXT_DATABASE_URL", "CONTEXT_DATABASE_URL"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.COMBYNE_CONFIG = path.join(tmpDir, "config.json");
  process.env.DATABASE_URL = DB_URL_WITH_PASSWORD;
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

describe("redactDbUrl", () => {
  it("masks the password and never returns the raw secret", () => {
    const out = redactDbUrl(DB_URL_WITH_PASSWORD);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("****");
    expect(out).toContain("db.internal");
  });

  it("returns a safe placeholder for a malformed url", () => {
    expect(redactDbUrl("not a url")).toBe("(invalid url)");
  });
});

describe("context-database routes — instance-admin gate", () => {
  for (const [name, actor] of [
    ["non-admin board", nonAdminBoardActor],
    ["agent", agentActor],
  ] as const) {
    it(`rejects ${name} actor with 403 on GET status`, async () => {
      const app = makeApp(actor, stubDb());
      const res = await request(app).get("/instance/context-database");
      expect(res.status).toBe(403);
    });

    it(`rejects ${name} actor with 403 on POST test`, async () => {
      const app = makeApp(actor, stubDb());
      const res = await request(app)
        .post("/instance/context-database/test")
        .send({ url: DB_URL_WITH_PASSWORD });
      expect(res.status).toBe(403);
    });

    it(`rejects ${name} actor with 403 on POST save`, async () => {
      const app = makeApp(actor, stubDb());
      const res = await request(app)
        .post("/instance/context-database/save")
        .send({ url: DB_URL_WITH_PASSWORD });
      expect(res.status).toBe(403);
      // The rejected save must NOT have written a config file.
      expect(fs.existsSync(process.env.COMBYNE_CONFIG as string)).toBe(false);
    });
  }
});

describe("GET /instance/context-database", () => {
  it("redacts the password in redactedEndpoint and reports schema status", async () => {
    const app = makeApp(adminActor, stubDb());
    const res = await request(app).get("/instance/context-database");
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SECRET);
    expect(res.body.redactedEndpoint).toContain("****");
    expect(res.body.usingSeparateContextDb).toBe(false);
    expect(res.body.serverVersion).toBe("PostgreSQL 16.2 (stub)");
    expect(res.body.memorySchemaPresent).toBe(true);
    expect(res.body.memoryEntryCount).toBe(7);
    expect(res.body.configuredVia).toBe("default");
  });
});

describe("POST /instance/context-database/test", () => {
  it("redacts nothing it shouldn't and returns ok:false (200) for an unreachable url", async () => {
    const app = makeApp(adminActor, stubDb());
    const res = await request(app)
      .post("/instance/context-database/test")
      // Reserved TEST-NET-1 address + closed port → connection fails fast, no hang.
      .send({ url: "postgres://user:topsecret@192.0.2.1:5432/none?connect_timeout=2" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe("string");
    // The probe error message must never echo the supplied credential.
    expect(JSON.stringify(res.body)).not.toContain("topsecret");
  }, 20000);

  it("rejects a non-postgres url with 400", async () => {
    const app = makeApp(adminActor, stubDb());
    const res = await request(app)
      .post("/instance/context-database/test")
      .send({ url: "http://example.com" });
    expect(res.status).toBe(400);
  });
});

describe("POST /instance/context-database/save", () => {
  it("merge-writes contextDatabaseUrl into config.json (0600) and GET reflects it", async () => {
    const configPath = process.env.COMBYNE_CONFIG as string;
    // Seed an existing config to prove the writer MERGES rather than clobbers.
    fs.writeFileSync(configPath, JSON.stringify({ existingKey: "keep-me" }, null, 2));

    const app = makeApp(adminActor, stubDb());
    const saveRes = await request(app)
      .post("/instance/context-database/save")
      .send({ url: DB_URL_WITH_PASSWORD });
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.saved).toBe(true);
    expect(saveRes.body.restartRequired).toBe(true);
    expect(saveRes.body.redactedEndpoint).toContain("****");
    expect(JSON.stringify(saveRes.body)).not.toContain(SECRET);

    const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(written.contextDatabaseUrl).toBe(DB_URL_WITH_PASSWORD);
    expect(written.existingKey).toBe("keep-me");
    // 0600 perms.
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);

    // GET now reports configuredVia:'config-file' (env not set).
    const getRes = await request(app).get("/instance/context-database");
    expect(getRes.status).toBe(200);
    expect(getRes.body.configuredVia).toBe("config-file");
  });
});

describe("POST /instance/context-database/teams & /join — gate + credential surface", () => {
  const TEAM_ID = "b405dc3d-3dbe-4d37-b1ad-3a3a8895192c";

  for (const [name, actor] of [
    ["non-admin board", nonAdminBoardActor],
    ["agent", agentActor],
  ] as const) {
    it(`rejects ${name} actor with 403 on POST /teams`, async () => {
      const app = makeApp(actor, stubDb());
      const res = await request(app)
        .post("/instance/context-database/teams")
        .send({ url: DB_URL_WITH_PASSWORD });
      expect(res.status).toBe(403);
    });

    it(`rejects ${name} actor with 403 on POST /join and writes NO config file`, async () => {
      const app = makeApp(actor, stubDb());
      const res = await request(app)
        .post("/instance/context-database/join")
        .send({ url: DB_URL_WITH_PASSWORD, teamId: TEAM_ID, teamName: "Lending" });
      expect(res.status).toBe(403);
      // The rejected join must NOT have written a config file.
      expect(fs.existsSync(process.env.COMBYNE_CONFIG as string)).toBe(false);
    });
  }

  it("/teams with no url in single-DB mode returns ok:false with an explanatory message", async () => {
    const app = makeApp(adminActor, stubDb());
    const res = await request(app).post("/instance/context-database/teams").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.companies).toEqual([]);
    expect(res.body.error).toBe("No separate context database is configured");
  });

  it("/teams against an unreachable url returns ok:false (200) and never leaks the credential", async () => {
    const app = makeApp(adminActor, stubDb());
    const res = await request(app)
      .post("/instance/context-database/teams")
      // Reserved TEST-NET-1 address + closed port → connection fails fast.
      .send({ url: "postgres://user:topsecret@192.0.2.1:5432/none?connect_timeout=2" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.companies).toEqual([]);
    expect(typeof res.body.error).toBe("string");
    // The probe error must never echo the supplied credential.
    expect(JSON.stringify(res.body)).not.toContain("topsecret");
  }, 20000);

  it("/teams rejects a non-postgres url with 400", async () => {
    const app = makeApp(adminActor, stubDb());
    const res = await request(app)
      .post("/instance/context-database/teams")
      .send({ url: "http://example.com" });
    expect(res.status).toBe(400);
  });

  it("/join rejects a non-postgres url with 400 and writes NO config file", async () => {
    const app = makeApp(adminActor, stubDb());
    const res = await request(app)
      .post("/instance/context-database/join")
      .send({ url: "http://example.com", teamId: TEAM_ID, teamName: "Lending" });
    expect(res.status).toBe(400);
    expect(fs.existsSync(process.env.COMBYNE_CONFIG as string)).toBe(false);
  });

  it("/join rejects a missing/invalid teamId (zod uuid) with 400", async () => {
    const app = makeApp(adminActor, stubDb());
    const missing = await request(app)
      .post("/instance/context-database/join")
      .send({ url: DB_URL_WITH_PASSWORD, teamName: "Lending" });
    expect(missing.status).toBe(400);
    const invalid = await request(app)
      .post("/instance/context-database/join")
      .send({ url: DB_URL_WITH_PASSWORD, teamId: "not-a-uuid", teamName: "Lending" });
    expect(invalid.status).toBe(400);
  });

  it("/join with no url and single-DB mode 400s 'No shared context database configured'", async () => {
    const app = makeApp(adminActor, stubDb());
    const res = await request(app)
      .post("/instance/context-database/join")
      .send({ teamId: TEAM_ID, teamName: "Lending" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No shared context database configured");
    expect(fs.existsSync(process.env.COMBYNE_CONFIG as string)).toBe(false);
  });
});

describe("POST /instance/embedding-config", () => {
  const EMBED_KEY = "sk-proj-supersecret-embedding-key-0123456789";

  for (const [name, actor] of [
    ["non-admin board", nonAdminBoardActor],
    ["agent", agentActor],
  ] as const) {
    it(`rejects ${name} actor with 403`, async () => {
      const app = makeApp(actor, stubDb());
      const res = await request(app)
        .post("/instance/embedding-config")
        .send({ provider: "openai", model: "text-embedding-3-small", apiKey: EMBED_KEY, disclosureAcked: true });
      expect(res.status).toBe(403);
      // The rejected write must NOT have created a config file.
      expect(fs.existsSync(process.env.COMBYNE_CONFIG as string)).toBe(false);
    });
  }

  it("blocks the save when the disclosure is not acknowledged (400)", async () => {
    const app = makeApp(adminActor, stubDb());
    const res = await request(app)
      .post("/instance/embedding-config")
      .send({ provider: "openai", model: "text-embedding-3-small", apiKey: EMBED_KEY, disclosureAcked: false });
    expect(res.status).toBe(400);
    expect(fs.existsSync(process.env.COMBYNE_CONFIG as string)).toBe(false);
  });

  it("merge-writes the key into config.json (0600) and NEVER echoes the key back", async () => {
    const configPath = process.env.COMBYNE_CONFIG as string;
    fs.writeFileSync(configPath, JSON.stringify({ existingKey: "keep-me" }, null, 2));

    const app = makeApp(adminActor, stubDb());
    const res = await request(app)
      .post("/instance/embedding-config")
      .send({ provider: "openai", model: "text-embedding-3-large", apiKey: EMBED_KEY, disclosureAcked: true });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.restartRequired).toBe(true);
    expect(res.body.provider).toBe("openai");
    expect(res.body.model).toBe("text-embedding-3-large");
    expect(res.body.disclosureAcked).toBe(true);
    // The key is write-only — it must NEVER appear in the response.
    expect(JSON.stringify(res.body)).not.toContain(EMBED_KEY);

    // The key IS persisted (write-only storage), and the merge preserves prior keys.
    const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(written.embeddingApiKey).toBe(EMBED_KEY);
    expect(written.embeddingProvider).toBe("openai");
    expect(written.embeddingDisclosureAcked).toBe(true);
    expect(written.existingKey).toBe("keep-me");
    // 0600 perms — the key is never world-readable.
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
