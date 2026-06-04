import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, memoryEntries } from "@combyne/db";
import { eq } from "drizzle-orm";
import { memoryService } from "../memory.js";
import {
  makeMemoryEmbedder,
  resetEmbedderTelemetry,
  getEmbedderTelemetry,
  HASH_EMBEDDING_VERSION,
  MAX_EMBED_CHARS,
  type EmbedderConfig,
} from "../memory-embedder.js";
import type { EmbeddingDriver } from "../embedding-driver.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

const API_VERSION = "openai:text-embedding-3-small:1536";
const API_MODEL = "text-embedding-3-small";

/** A mock 1536-dim driver that records the texts it was asked to embed. */
function makeMockDriver(): EmbeddingDriver & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    version: API_VERSION,
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      const vectors = texts.map(() => {
        const v = new Array(1536).fill(0);
        v[0] = 1;
        return v;
      });
      return { vectors, model: API_MODEL, dim: 1536, version: API_VERSION, inputTokens: 1 };
    },
  };
}

const ENABLED: EmbedderConfig = {
  vectorSearchEnabled: true,
  embeddingApiKey: "sk-test-key",
  embeddingProvider: "openai",
  embeddingModel: API_MODEL,
  embeddingDim: 1536,
};

const DISABLED: EmbedderConfig = {
  vectorSearchEnabled: false,
  embeddingApiKey: "",
  embeddingProvider: "openai",
  embeddingModel: API_MODEL,
  embeddingDim: 1536,
};

describe("PR-12 embedding ops surface + transition safety", () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  beforeEach(() => resetEmbedderTelemetry());

  async function freshCompany(prefix: string): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c] = await handle.db
      .insert(companies)
      .values({ name: `${prefix}-${suffix}`, issuePrefix: `${prefix[0]}${suffix}` })
      .returning();
    return c.id;
  }

  describe("embedding_model stores the bare model (not the composite version)", () => {
    it("createEntry writes embedding_model = bare model, embedding_version = composite", async () => {
      const driver = makeMockDriver();
      const embedder = makeMemoryEmbedder({ config: ENABLED, driver });
      const svc = memoryService(handle.db, embedder);
      const companyId = await freshCompany("Bare");
      const entry = await svc.createEntry({
        companyId,
        layer: "workspace",
        subject: "topic naming",
        body: "service.entity.event",
      });
      const [row] = await handle.db
        .select()
        .from(memoryEntries)
        .where(eq(memoryEntries.id, entry.id));
      expect(row.embeddingVersion).toBe(API_VERSION);
      expect(row.embeddingModel).toBe(API_MODEL); // bare, NOT the composite
    });
  });

  describe("long-body truncation guard (no silent hash-64 worst tier)", () => {
    it("head-truncates an over-limit body before egress and counts the truncation", async () => {
      const driver = makeMockDriver();
      const embedder = makeMemoryEmbedder({ config: ENABLED, driver });
      const longBody = "x".repeat(MAX_EMBED_CHARS + 5000);
      const result = await embedder.embedForStorage("subj", longBody);
      // The embed SUCCEEDED at the API version (did NOT silently fall to hash-64).
      expect(result.version).toBe(API_VERSION);
      // The egressed text was capped at the char budget.
      expect(driver.calls.length).toBe(1);
      expect(driver.calls[0][0].length).toBe(MAX_EMBED_CHARS);
      // And the truncation is visible in telemetry.
      expect(getEmbedderTelemetry().truncations).toBe(1);
    });

    it("does NOT truncate a normal-length body", async () => {
      const driver = makeMockDriver();
      const embedder = makeMemoryEmbedder({ config: ENABLED, driver });
      await embedder.embedForStorage("subj", "a short body");
      expect(getEmbedderTelemetry().truncations).toBe(0);
    });
  });

  describe("hash-fallback telemetry", () => {
    it("counts hash fallbacks on the disabled path", async () => {
      const embedder = makeMemoryEmbedder({ config: DISABLED });
      await embedder.embedForStorage("s", "b");
      await embedder.embedQuery("q");
      expect(getEmbedderTelemetry().hashFallbacks).toBe(2);
    });
  });

  describe("transition: enabling the embedder on a hash-64 corpus does NOT go dark (jsonb path)", () => {
    it("queryRanked still returns rows via lexical when the corpus is 0% on the current version", async () => {
      const companyId = await freshCompany("Trans");
      // Seed the corpus while the embedder is DISABLED (every row → hash-64:64).
      const disabledSvc = memoryService(handle.db, makeMemoryEmbedder({ config: DISABLED }));
      await disabledSvc.createEntry({
        companyId,
        layer: "workspace",
        subject: "kafka topic naming convention",
        body: "topics use service.entity.event lowercase dot-separated",
      });
      await disabledSvc.createEntry({
        companyId,
        layer: "workspace",
        subject: "budget pause policy",
        body: "an agent that exceeds its token salary is paused until the window resets",
      });

      // Now ENABLE the embedder (the query embeds at the API version) while every
      // entry still carries hash-64:64. The version guard zeroes semantic, but the
      // preamble must NOT be empty — lexical must still surface the matching row.
      const enabledSvc = memoryService(handle.db, makeMemoryEmbedder({ config: ENABLED, driver: makeMockDriver() }));
      const result = await enabledSvc.queryRanked(companyId, "kafka topic naming convention", {});
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items[0].subject).toContain("kafka");
    });
  });

  describe("GET-shaped embeddingStatus() snapshot", () => {
    it("reports coverage, backlog, hash-fallback %, redaction-blocked on a mixed corpus", async () => {
      const companyId = await freshCompany("Status");
      // Two hash-64 rows (embedder disabled), then one API-version row (enabled).
      const disabledSvc = memoryService(handle.db, makeMemoryEmbedder({ config: DISABLED }));
      await disabledSvc.createEntry({ companyId, layer: "workspace", subject: "a", body: "one" });
      await disabledSvc.createEntry({ companyId, layer: "workspace", subject: "b", body: "two" });

      const enabledEmbedder = makeMemoryEmbedder({ config: ENABLED, driver: makeMockDriver() });
      const enabledSvc = memoryService(handle.db, enabledEmbedder);
      await enabledSvc.createEntry({ companyId, layer: "workspace", subject: "c", body: "three" });
      // A secret body → redact-before-embed → needs_review quarantine.
      await enabledSvc.createEntry({
        companyId,
        layer: "workspace",
        subject: "creds",
        body: "the api key is sk-live-AAAABBBBCCCCDDDDEEEE1234 rotate it",
      });

      const status = await enabledSvc.embeddingStatus(companyId);
      expect(status.embedderEnabled).toBe(true);
      expect(status.currentVersion).toBe(API_VERSION);
      expect(status.activeEntries).toBe(4);
      // 2 of 4 are still hash-64 → coverage 50%, hash-fallback 50%.
      expect(status.versionCoveragePct).toBeCloseTo(0.5, 5);
      expect(status.hashFallbackPct).toBeCloseTo(0.5, 5);
      expect(status.versionBreakdown[HASH_EMBEDDING_VERSION]).toBe(2);
      expect(status.versionBreakdown[API_VERSION]).toBe(2);
      // Backlog = the 2 stale rows (no pgvector column on the rig).
      expect(status.reembedBacklog).toBe(2);
      // The secret entry is quarantined.
      expect(status.redactionBlocked).toBeGreaterThanOrEqual(1);
      // No pgvector on the embedded rig → no HNSW index.
      expect(status.pgvectorPresent).toBe(false);
      expect(status.hnswIndexPresent).toBe(false);
    });

    it("reports 0 backlog and full coverage when the embedder is disabled", async () => {
      const companyId = await freshCompany("Disab");
      const svc = memoryService(handle.db, makeMemoryEmbedder({ config: DISABLED }));
      await svc.createEntry({ companyId, layer: "workspace", subject: "x", body: "y" });
      const status = await svc.embeddingStatus(companyId);
      expect(status.embedderEnabled).toBe(false);
      expect(status.reembedBacklog).toBe(0); // disabled → nothing to backfill
      expect(status.versionCoveragePct).toBe(1); // current version IS hash-64:64
    });
  });
});
