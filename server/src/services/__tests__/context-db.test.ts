import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, memoryEntries, type Db } from "@combyne/db";
import { memoryService } from "../memory.js";
import { resolveContextDb } from "../context-db.js";
import {
  startTestDb,
  startIsolatedTestDb,
  stopTestDb,
  type TestDbHandle,
} from "./_test-db.js";

const ENV_KEY = "COMBYNE_CONTEXT_DATABASE_URL";

describe("separate dedicated context DB", () => {
  let main: TestDbHandle;
  let context: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    main = await startTestDb();
    // A SECOND, physically-separate embedded Postgres acting as the context DB.
    // startIsolatedTestDb migrates it via the same rig path, so its memory tables exist.
    context = await startIsolatedTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c] = await main.db
      .insert(companies)
      .values({ name: `CtxCo-${suffix}`, issuePrefix: `C${suffix}` })
      .returning();
    companyId = c.id;
  }, 120_000);

  afterEach(() => {
    // resolveContextDb reads loadConfig() (env-driven); always restore single-DB default.
    delete process.env[ENV_KEY];
  });

  afterAll(async () => {
    delete process.env[ENV_KEY];
    if (context) await context.stop();
    if (main) await stopTestDb();
  });

  it("returns the SAME db instance when CONTEXT_DATABASE_URL is unset (single-DB mode)", () => {
    delete process.env[ENV_KEY];
    const resolved = resolveContextDb(main.db);
    expect(resolved).toBe(main.db);
  });

  it("routes the memory service to the separate context DB; main DB memory tables stay empty", async () => {
    // Point the memory layer at the second physical Postgres.
    process.env[ENV_KEY] = context.connectionString;
    expect(resolveContextDb(main.db)).not.toBe(main.db);

    // The service resolves its context db at construction → build it AFTER the env is set.
    const svc = memoryService(main.db);
    const created = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Context DB physical separation probe",
      body: "This entry must land in the context DB, never the main DB.",
      tags: ["context-db"],
      serviceScope: "server",
    });
    expect(created.id).toBeTruthy();

    // Round-trip read through the same service (also goes to the context DB).
    const ranked = await svc.queryRanked(companyId, "context db separation probe", {
      limit: 10,
    });
    expect(ranked.items.some((i) => i.id === created.id)).toBe(true);

    // PHYSICAL SEPARATION: the row exists in the context DB...
    const contextDirect: Db = createDb(context.connectionString);
    const inContext = await contextDirect.select().from(memoryEntries).where(eq(memoryEntries.id, created.id));
    expect(inContext.length).toBe(1);

    // ...and the MAIN DB's memory_entries table is empty for this company.
    const inMain = await main.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.companyId, companyId));
    expect(inMain.length).toBe(0);
  }, 60_000);
});
