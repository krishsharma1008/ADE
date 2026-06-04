import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@combyne/db";
import { cosineSimilarity, embedText, memoryService, rankEntries } from "../memory.js";
import {
  makeMemoryEmbedder,
  HASH_EMBEDDING_VERSION,
  type EmbedderConfig,
} from "../memory-embedder.js";
import type { EmbeddingDriver } from "../embedding-driver.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

const API_VERSION = "openai:text-embedding-3-small:1536";

/** A mock 1536-dim driver that records every call (proves zero-call on the OFF path). */
function makeMockDriver(): EmbeddingDriver & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    version: API_VERSION,
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      const vectors = texts.map(() => {
        const v = new Array(1536).fill(0);
        v[0] = 1; // unit vector — valid 1536-dim shape
        return v;
      });
      return { vectors, model: "text-embedding-3-small", dim: 1536, version: API_VERSION, inputTokens: 1 };
    },
  };
}

const ENABLED_CONFIG: EmbedderConfig = {
  vectorSearchEnabled: true,
  embeddingApiKey: "sk-test-key",
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
  embeddingDim: 1536,
};

const DISABLED_CONFIG: EmbedderConfig = {
  vectorSearchEnabled: false,
  embeddingApiKey: "",
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
  embeddingDim: 1536,
};

describe("PR-11 embedding version + redact-before-embed", () => {
  describe("cosineSimilarity version guard (no silent min-len score)", () => {
    it("scores normally when versions match (or are omitted)", () => {
      const a = embedText("budget pause policy");
      const b = embedText("budget pause policy");
      expect(cosineSimilarity(a, b)).toBeGreaterThan(0.9);
      expect(cosineSimilarity(a, b, "hash-64:64", "hash-64:64")).toBeGreaterThan(0.9);
    });

    it("falls back to 0 on a version mismatch (hash-64 query vs 1536 API entry)", () => {
      const hashQuery = embedText("budget pause policy"); // 64-dim
      const apiEntry = new Array(1536).fill(0);
      apiEntry[0] = 1;
      // Without the guard this would dot over min(64,1536)=64 and return a
      // valid-but-meaningless score. With the guard it must be exactly 0.
      expect(cosineSimilarity(hashQuery, apiEntry, "hash-64:64", API_VERSION)).toBe(0);
      expect(cosineSimilarity(apiEntry, hashQuery, API_VERSION, "hash-64:64")).toBe(0);
    });

    it("rankEntries never cross-scores a hash query against an API-version entry", () => {
      const apiVec = new Array(1536).fill(0);
      apiVec[0] = 1;
      const ranked = rankEntries(
        "budget pause",
        [
          {
            id: "api",
            layer: "workspace",
            subject: "budget pause policy",
            body: "hard stop at the cap",
            tags: ["budget"],
            embedding: apiVec,
            embeddingVersion: API_VERSION,
            lastUsedAt: null,
            updatedAt: new Date(),
          },
        ],
        {},
        // Query embedded in the hash space — semantic must be guarded to 0.
        { vector: embedText("budget pause"), version: "hash-64:64" },
      );
      expect(ranked[0].semantic).toBe(0);
    });
  });

  describe("no key → hash-64 fallback, zero driver calls, never throws", () => {
    it("embedForStorage/embedQuery use hash-64 and call the driver 0 times", async () => {
      const driver = makeMockDriver();
      const embedder = makeMemoryEmbedder({ config: DISABLED_CONFIG, driver });
      expect(embedder.enabled).toBe(false);
      expect(embedder.version).toBe(HASH_EMBEDDING_VERSION);

      const storage = await embedder.embedForStorage("subj", "body");
      const query = await embedder.embedQuery("a query");
      expect(storage.version).toBe(HASH_EMBEDDING_VERSION);
      expect(storage.vector).toEqual(embedText("subj\nbody"));
      expect(query.version).toBe(HASH_EMBEDDING_VERSION);
      // Zero egress on the OFF path.
      expect(driver.calls.length).toBe(0);
    });

    it("never throws when the driver throws (hash fallback on the ON path)", async () => {
      const throwingDriver: EmbeddingDriver = {
        version: API_VERSION,
        async embed() {
          throw new Error("embedding_http_500");
        },
      };
      const embedder = makeMemoryEmbedder({ config: ENABLED_CONFIG, driver: throwingDriver });
      expect(embedder.enabled).toBe(true);
      const storage = await embedder.embedForStorage("subj", "body");
      const query = await embedder.embedQuery("q");
      expect(storage.version).toBe(HASH_EMBEDDING_VERSION);
      expect(query.version).toBe(HASH_EMBEDDING_VERSION);
    });
  });

  describe("redact-before-embed on BOTH egress paths (mocked driver)", () => {
    const SECRET_BODY = "the api key is sk-live-AAAABBBBCCCCDDDDEEEE1234 use it in prod";

    it("storage path: scanBody redacts the sk- key BEFORE the driver sees it", async () => {
      const driver = makeMockDriver();
      const embedder = makeMemoryEmbedder({ config: ENABLED_CONFIG, driver });
      const result = await embedder.embedForStorage("auth", SECRET_BODY);
      expect(driver.calls.length).toBe(1);
      const egressed = driver.calls[0][0];
      // The raw key must NOT have reached the driver.
      expect(egressed).not.toContain("sk-live-AAAABBBBCCCCDDDDEEEE1234");
      expect(egressed).toContain("***REDACTED***");
      // And the finding is reported so the caller quarantines to needs_review.
      expect(result.redactedFindings.length).toBeGreaterThan(0);
    });

    it("query path: scanBody redacts the sk- key BEFORE the driver sees it", async () => {
      const driver = makeMockDriver();
      const embedder = makeMemoryEmbedder({ config: ENABLED_CONFIG, driver });
      await embedder.embedQuery(SECRET_BODY);
      expect(driver.calls.length).toBe(1);
      const egressed = driver.calls[0][0];
      expect(egressed).not.toContain("sk-live-AAAABBBBCCCCDDDDEEEE1234");
      expect(egressed).toContain("***REDACTED***");
    });
  });

  describe("DB integration: createEntry marks needs_review on a detected secret", () => {
    let handle: TestDbHandle;
    let companyId: string;

    beforeAll(async () => {
      handle = await startTestDb();
      const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
      const [c] = await handle.db
        .insert(companies)
        .values({ name: `EmbCo-${suffix}`, issuePrefix: `E${suffix}` })
        .returning();
      companyId = c.id;
    }, 60_000);

    afterAll(async () => {
      if (handle) await stopTestDb();
    });

    it("no key: createEntry writes hash-64 + 'hash-64:64', never throws, zero driver calls", async () => {
      const driver = makeMockDriver();
      const embedder = makeMemoryEmbedder({ config: DISABLED_CONFIG, driver });
      const svc = memoryService(handle.db, embedder);
      const entry = await svc.createEntry({
        companyId,
        layer: "workspace",
        subject: "kafka topic conventions",
        body: "name format is service.entity.event",
      });
      expect(entry.embeddingVersion).toBe(HASH_EMBEDDING_VERSION);
      expect(entry.embedding).toEqual(embedText("kafka topic conventions\nname format is service.entity.event"));
      expect(entry.verificationState).toBe("unverified");
      expect(driver.calls.length).toBe(0);
    });

    it("enabled + secret body: createEntry quarantines to needs_review and redacts before egress", async () => {
      const driver = makeMockDriver();
      const embedder = makeMemoryEmbedder({ config: ENABLED_CONFIG, driver });
      const svc = memoryService(handle.db, embedder);
      const entry = await svc.createEntry({
        companyId,
        layer: "workspace",
        subject: "deploy creds",
        body: "the api key is sk-live-ZZZZYYYYXXXXWWWW9999 rotate monthly",
      });
      expect(entry.verificationState).toBe("needs_review");
      expect(entry.embeddingVersion).toBe(API_VERSION);
      // The driver received the redacted text, not the raw key.
      expect(driver.calls.length).toBeGreaterThan(0);
      const egressed = driver.calls.flat().join(" ");
      expect(egressed).not.toContain("sk-live-ZZZZYYYYXXXXWWWW9999");
    });

    it("enabled + secret query: queryRanked (embedQuery) redacts the query before egress", async () => {
      const driver = makeMockDriver();
      const embedder = makeMemoryEmbedder({ config: ENABLED_CONFIG, driver });
      const svc = memoryService(handle.db, embedder);
      await svc.queryRanked(companyId, "what is the api key is sk-test-AAAABBBBCCCCDDDD1111", {});
      const egressed = driver.calls.flat().join(" ");
      expect(driver.calls.length).toBeGreaterThan(0);
      expect(egressed).not.toContain("sk-test-AAAABBBBCCCCDDDD1111");
    });
  });
});
