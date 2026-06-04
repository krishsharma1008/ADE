import { describe, it, expect } from "vitest";
import { embedText, cosineSimilarity, rankEntries } from "../memory.js";

describe("memory ranker (pure)", () => {
  it("embedText is deterministic and L2-normalized", () => {
    const a = embedText("auth middleware token storage");
    const b = embedText("auth middleware token storage");
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  });

  it("cosine similarity is higher for related text", () => {
    const q = embedText("budget hard stop pause");
    const close = embedText("budget pause hard-stop policy");
    const far = embedText("react hooks rendering tree");
    expect(cosineSimilarity(q, close)).toBeGreaterThan(cosineSimilarity(q, far));
  });

  it("weights semantic-dominant for a real query embedding, lexical-primary for hash", () => {
    const qVec = [1, 0, 0, 0];
    const updatedAt = new Date("2026-01-01T00:00:00Z");
    // entry "lex": full lexical overlap with the query, embedding far from it.
    // entry "sem": zero lexical overlap, embedding identical to the query vector.
    const mk = (version: string) => [
      { id: "lex", layer: "workspace" as const, subject: "budget pause policy", body: "", tags: [], embedding: [0, 1, 0, 0], embeddingVersion: version, lastUsedAt: null, updatedAt },
      { id: "sem", layer: "workspace" as const, subject: "zzz qqq www", body: "", tags: [], embedding: [1, 0, 0, 0], embeddingVersion: version, lastUsedAt: null, updatedAt },
    ];
    // Real (non-hash) version → semantic dominates → the cosine match wins despite zero lexical overlap.
    const real = rankEntries("budget pause policy", mk("openai:test:4"), {}, { vector: qVec, version: "openai:test:4" });
    expect(real[0].id).toBe("sem");
    // Hash version → lexical stays primary → the keyword match wins (hash-era behavior; test rig unchanged).
    const hash = rankEntries("budget pause policy", mk("hash-64:64"), {}, { vector: qVec, version: "hash-64:64" });
    expect(hash[0].id).toBe("lex");
    // Explicit weights always override the embedding-aware default.
    const forced = rankEntries("budget pause policy", mk("openai:test:4"), { lexical: 0.9, semantic: 0.05 }, { vector: qVec, version: "openai:test:4" });
    expect(forced[0].id).toBe("lex");
  });

  it("rankEntries gives lexical hits in subject the top spot", () => {
    const entries = [
      {
        id: "a",
        layer: "workspace" as const,
        subject: "Database migration workflow",
        body: "Always run db:generate after editing schema",
        tags: ["db", "migration"],
        embedding: embedText("database migration workflow always run db generate"),
        lastUsedAt: null,
        updatedAt: new Date(),
      },
      {
        id: "b",
        layer: "workspace" as const,
        subject: "Auth middleware notes",
        body: "JWT decode happens here",
        tags: ["auth"],
        embedding: embedText("auth middleware jwt decode"),
        lastUsedAt: null,
        updatedAt: new Date(),
      },
    ];
    const ranked = rankEntries("database migration", entries);
    expect(ranked[0].id).toBe("a");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("personal layer entries outrank workspace entries with equal lexical match", () => {
    const updatedAt = new Date();
    const entries = [
      {
        id: "ws",
        layer: "workspace" as const,
        subject: "deploy steps",
        body: "deploy via vercel cli",
        tags: ["deploy"],
        embedding: embedText("deploy steps vercel cli"),
        lastUsedAt: null,
        updatedAt,
      },
      {
        id: "personal",
        layer: "personal" as const,
        subject: "deploy steps",
        body: "deploy via vercel cli",
        tags: ["deploy"],
        embedding: embedText("deploy steps vercel cli"),
        lastUsedAt: null,
        updatedAt,
      },
    ];
    const ranked = rankEntries("deploy steps", entries);
    expect(ranked[0].id).toBe("personal");
  });

  it("recently-used entries outrank older ones with similar match", () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 60);
    const fresh = new Date();
    const entries = [
      {
        id: "old",
        layer: "workspace" as const,
        subject: "kafka topic conventions",
        body: "name format is service.entity.event",
        tags: ["kafka"],
        embedding: embedText("kafka topic conventions name format service entity event"),
        lastUsedAt: old,
        updatedAt: old,
      },
      {
        id: "fresh",
        layer: "workspace" as const,
        subject: "kafka topic conventions",
        body: "name format is service.entity.event",
        tags: ["kafka"],
        embedding: embedText("kafka topic conventions name format service entity event"),
        lastUsedAt: fresh,
        updatedAt: fresh,
      },
    ];
    const ranked = rankEntries("kafka topic", entries);
    expect(ranked[0].id).toBe("fresh");
  });

  it("rankEntries stays PURE and SYNC (PR-3 must not lift embedText into an async pre-step)", () => {
    // PR-3 adds retrieval-side trust filtering in queryRanked/loadCandidates but
    // must NOT touch the ranker. rankEntries returns a plain array (not a
    // Promise), is deterministic across calls, and does not mutate its inputs.
    const entries = [
      {
        id: "a",
        layer: "workspace" as const,
        subject: "auth middleware jwt",
        body: "sessions live in signed jwt cookies",
        tags: ["auth"],
        embedding: embedText("auth middleware jwt cookies sessions"),
        lastUsedAt: null,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    const frozenInput = JSON.stringify(entries);
    const first = rankEntries("auth jwt", entries);
    const second = rankEntries("auth jwt", entries);
    // Synchronous: a real array, never a thenable.
    expect(Array.isArray(first)).toBe(true);
    expect(typeof (first as unknown as { then?: unknown }).then).toBe("undefined");
    // Deterministic: identical scores on repeat calls.
    expect(second.map((r) => r.score)).toEqual(first.map((r) => r.score));
    // Non-mutating: inputs unchanged.
    expect(JSON.stringify(entries)).toBe(frozenInput);
  });

  it("embedText is untouched by PR-3 (still deterministic + L2-normalized)", () => {
    const v = embedText("budget hard stop pause policy");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(embedText("budget hard stop pause policy")).toEqual(v);
  });
});
