// Cond 2 — `pnpm db:company-pin` works in the DEFAULT embedded setup and is
// prefix-safe + no-clobber. Tests the in-process upsert helper (adoptPinnedCompany)
// + the connection resolver (resolveOpsConnectionString) directly — no argv / no
// process.exit, against the shared embedded test Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies } from "@combyne/db";
import { adoptPinnedCompany, resolveOpsConnectionString } from "../company-pin.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "../../src/services/__tests__/_test-db.js";

const uuid = (a: string) => `${a}-0000-4000-8000-000000000000`;

describe("company-pin adoption (Cond 2)", () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await stopTestDb();
  });

  it("fresh insert: adopts a new id with a derived, NON-default issue prefix", async () => {
    const id = uuid("11111111");
    const r = await adoptPinnedCompany(handle.db, { id, name: "Acme" });
    expect(r.action).toBe("inserted");
    expect(r.id).toBe(id);
    expect(r.name).toBe("Acme");
    expect(r.issuePrefix).not.toBe("PAP");
    expect(r.issuePrefix.startsWith("PIN")).toBe(true);
  });

  it("B-PIN-3: adopting succeeds even when a local company already holds the default 'PAP' prefix", async () => {
    // Seed a company with the seeded default prefix (mirrors seed.ts).
    const [pap] = await handle.db
      .insert(companies)
      .values({ name: "Combyne Demo Co", issuePrefix: "PAP" })
      .returning();
    const id = uuid("22222222");
    const r = await adoptPinnedCompany(handle.db, { id, name: "Pinned Team" });
    expect(r.action).toBe("inserted");
    expect(r.issuePrefix).not.toBe("PAP"); // would have crashed the UNIQUE index pre-fix
    // The pre-existing PAP company is untouched.
    const [stillPap] = await handle.db.select().from(companies).where(eq(companies.id, pap.id));
    expect(stillPap.issuePrefix).toBe("PAP");
  });

  it("retries on a derived-prefix collision (two pins sharing the same first 4 hex)", async () => {
    const id1 = `abcd0000-0000-4000-8000-000000000001`;
    const id2 = `abcd1111-1111-4111-8111-000000000002`; // same base prefix 'PINABCD'
    const r1 = await adoptPinnedCompany(handle.db, { id: id1, name: "Collide One" });
    const r2 = await adoptPinnedCompany(handle.db, { id: id2, name: "Collide Two" });
    expect(r1.issuePrefix).toBe("PINABCD");
    expect(r2.issuePrefix).not.toBe(r1.issuePrefix); // retried to a distinct candidate
    expect(r2.action).toBe("inserted");
  });

  it("B-PIN-4: re-running with a DIFFERENT name is a no-op (never silently renames a tenant)", async () => {
    const id = uuid("33333333");
    await adoptPinnedCompany(handle.db, { id, name: "Real Tenant Name" });
    const r = await adoptPinnedCompany(handle.db, { id, name: "Whatever Else" });
    expect(r.action).toBe("kept");
    expect(r.name).toBe("Real Tenant Name");
    const [row] = await handle.db.select().from(companies).where(eq(companies.id, id));
    expect(row.name).toBe("Real Tenant Name");
  });

  it("B-PIN-4: --force-rename overwrites the name explicitly", async () => {
    const id = uuid("44444444");
    await adoptPinnedCompany(handle.db, { id, name: "Old Name" });
    const r = await adoptPinnedCompany(handle.db, { id, name: "New Name", forceRename: true });
    expect(r.action).toBe("renamed");
    expect(r.name).toBe("New Name");
    const [row] = await handle.db.select().from(companies).where(eq(companies.id, id));
    expect(row.name).toBe("New Name");
  });

  it("re-running with the SAME name is an idempotent no-op", async () => {
    const id = uuid("55555555");
    await adoptPinnedCompany(handle.db, { id, name: "Same" });
    const r = await adoptPinnedCompany(handle.db, { id, name: "Same" });
    expect(r.action).toBe("kept");
    expect(r.name).toBe("Same");
  });

  it("resolveOpsConnectionString defaults to the embedded ops DB when DATABASE_URL is unset", () => {
    const savedDb = process.env.DATABASE_URL;
    const savedPort = process.env.COMBYNE_EMBEDDED_POSTGRES_PORT;
    const savedHome = process.env.COMBYNE_HOME;
    try {
      delete process.env.DATABASE_URL;
      delete process.env.COMBYNE_EMBEDDED_POSTGRES_PORT;
      // Point COMBYNE_HOME at a non-existent dir so no config.json is read → pure default.
      process.env.COMBYNE_HOME = "/nonexistent-combyne-home-for-test";
      const url = resolveOpsConnectionString(null);
      expect(url).toBe("postgres://combyne:combyne@127.0.0.1:54329/combyne");
    } finally {
      if (savedDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDb;
      if (savedPort === undefined) delete process.env.COMBYNE_EMBEDDED_POSTGRES_PORT;
      else process.env.COMBYNE_EMBEDDED_POSTGRES_PORT = savedPort;
      if (savedHome === undefined) delete process.env.COMBYNE_HOME;
      else process.env.COMBYNE_HOME = savedHome;
    }
  });

  it("resolveOpsConnectionString honors an explicit --db and $DATABASE_URL", () => {
    expect(resolveOpsConnectionString("postgres://x/y")).toBe("postgres://x/y");
    const saved = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = "postgres://env/db";
      expect(resolveOpsConnectionString(null)).toBe("postgres://env/db");
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});
