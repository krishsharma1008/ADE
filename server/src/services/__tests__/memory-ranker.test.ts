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
});
