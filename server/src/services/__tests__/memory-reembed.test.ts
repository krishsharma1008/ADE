import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, memoryEntries } from "@combyne/db";
import { eq } from "drizzle-orm";
import { memoryService } from "../memory.js";
import { reembedBackfill } from "../memory-reembed.js";
import {
  makeMemoryEmbedder,
  HASH_EMBEDDING_VERSION,
  type EmbedderConfig,
} from "../memory-embedder.js";
import type { EmbeddingDriver } from "../embedding-driver.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

const API_VERSION = "openai:text-embedding-3-small:1536";

function makeMockDriver(): EmbeddingDriver & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    version: API_VERSION,
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      return {
        vectors: texts.map(() => {
          const v = new Array(1536).fill(0);
          v[0] = 1;
          return v;
        }),
        model: "text-embedding-3-small",
        dim: 1536,
        version: API_VERSION,
        inputTokens: 1,
      };
    },
  };
}

const ENABLED: EmbedderConfig = {
  vectorSearchEnabled: true,
  embeddingApiKey: "sk-test-key",
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
  embeddingDim: 1536,
};

const DISABLED: EmbedderConfig = {
  vectorSearchEnabled: false,
  embeddingApiKey: "",
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
  embeddingDim: 1536,
};

const noSleep = async () => {};

describe("PR-11 memory-reembed backfill", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c] = await handle.db
      .insert(companies)
      .values({ name: `ReembedCo-${suffix}`, issuePrefix: `R${suffix}` })
      .returning();
    companyId = c.id;
    // Seed entries on the hash-64 path (disabled embedder) so they are "stale"
    // relative to the API version the enabled embedder will write.
    const hashSvc = memoryService(handle.db, makeMemoryEmbedder({ config: DISABLED }));
    for (let i = 0; i < 5; i++) {
      await hashSvc.createEntry({
        companyId,
        layer: "workspace",
        subject: `kafka topic conventions ${i}`,
        body: `name format is service.entity.event ${i}`,
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("is a no-op when the embedder is disabled (hash-64 path)", async () => {
    const embedder = makeMemoryEmbedder({ config: DISABLED });
    const result = await reembedBackfill(handle.db, embedder, { companyId, sleep: noSleep });
    expect(result).toEqual({ scanned: 0, reembedded: 0 });
  });

  it("backfills stale rows to the current embedding_version and is idempotent/resumable", async () => {
    const driver = makeMockDriver();
    const embedder = makeMemoryEmbedder({ config: ENABLED, driver });

    const first = await reembedBackfill(handle.db, embedder, {
      companyId,
      batchSize: 2,
      sleep: noSleep,
    });
    expect(first.reembedded).toBe(5);
    expect(driver.calls.length).toBeGreaterThan(0);

    // Every seeded row is now on the API version.
    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.companyId, companyId));
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.embeddingVersion === API_VERSION)).toBe(true);
    expect(rows.every((r) => r.embeddingModel === API_VERSION)).toBe(true);
    expect(rows.every((r) => r.embeddingDim === 1536)).toBe(true);
    expect(rows.every((r) => r.contentHash && r.contentHash.length > 0)).toBe(true);

    // Idempotent: a second run finds nothing stale and re-embeds 0 rows.
    const driver2 = makeMockDriver();
    const embedder2 = makeMemoryEmbedder({ config: ENABLED, driver: driver2 });
    const second = await reembedBackfill(handle.db, embedder2, { companyId, sleep: noSleep });
    expect(second.reembedded).toBe(0);
    expect(driver2.calls.length).toBe(0);
  });

  it("respects --max (stops after maxRows re-embeds)", async () => {
    // Reset two rows back to a stale version so there is something to backfill.
    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.companyId, companyId))
      .limit(2);
    for (const r of rows) {
      await handle.db
        .update(memoryEntries)
        .set({ embeddingVersion: HASH_EMBEDDING_VERSION })
        .where(eq(memoryEntries.id, r.id));
    }
    const driver = makeMockDriver();
    const embedder = makeMemoryEmbedder({ config: ENABLED, driver });
    const result = await reembedBackfill(handle.db, embedder, {
      companyId,
      maxRows: 1,
      sleep: noSleep,
    });
    expect(result.reembedded).toBe(1);
  });

  it("NEVER runs on boot: importing the script module has no side effects", async () => {
    // The backfill is operator-triggered only. Importing the core module must
    // not perform any DB work or embedder calls — it only exports a function.
    const before = await handle.db.execute(
      sql`SELECT count(*)::int AS n FROM ${memoryEntries} WHERE company_id = ${companyId}`,
    );
    const mod = await import("../memory-reembed.js");
    expect(typeof mod.reembedBackfill).toBe("function");
    const after = await handle.db.execute(
      sql`SELECT count(*)::int AS n FROM ${memoryEntries} WHERE company_id = ${companyId}`,
    );
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
