import { describe, expect, it } from "vitest";
import { embedText } from "../memory.js";
import {
  EVAL_ENTRIES,
  EVAL_QUERIES,
  evalEntryText,
  evalMetrics,
  evalRankOf,
} from "../embedding-eval-fixture.js";

/**
 * PR-12 retrieval-quality CI merge gate (ops-cost critique: "make the hash tier
 * a merge gate; keep the live tier opt-in").
 *
 * This runs the DETERMINISTIC, NETWORK-FREE hash-64 tier of the embedding-eval
 * fixture IN-PROCESS and asserts a regression band. The hash-64 oracle is the
 * permanent test/dev fallback embedder; if a refactor silently degrades it (or
 * the fixture) below the floor, this gate fails the merge. The expensive live
 * managed-API tier (which proves the +0.568 MRR lift) stays the opt-in script
 * (scripts/embedding-eval.ts behind COMBYNE_EVAL_LIVE_EMBEDDINGS=1) because it
 * needs network + a key + token spend.
 *
 * Measured baseline (real): hash-64 recall@1=14.3%, recall@3=50.0%,
 * recall@5=57.1%, MRR=0.375 on these 14 entries + 14 paraphrased queries.
 * The band is intentionally wide enough to absorb deterministic hashing
 * variation but tight enough to catch a real regression.
 */
describe("retrieval quality gate (hash-64 tier, deterministic)", () => {
  // Embed every entry + score every query exactly like the eval's hash tier.
  const entryVecs = new Map(EVAL_ENTRIES.map((e) => [e.id, embedText(evalEntryText(e))]));
  const ranks = EVAL_QUERIES.map((q) => evalRankOf(embedText(q.q), entryVecs, q.expected));
  const m = evalMetrics(ranks);

  it("is fully deterministic across runs (same vectors every time)", () => {
    const again = new Map(EVAL_ENTRIES.map((e) => [e.id, embedText(evalEntryText(e))]));
    for (const e of EVAL_ENTRIES) {
      expect(again.get(e.id)).toEqual(entryVecs.get(e.id));
    }
  });

  it("holds the hash-64 MRR within the regression band [0.30, 0.45]", () => {
    expect(m.mrr).toBeGreaterThanOrEqual(0.3);
    expect(m.mrr).toBeLessThanOrEqual(0.45);
  });

  it("holds recall@5 >= 0.5 for the hash-64 oracle", () => {
    expect(m.r5).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps the fixture intact (14 entries, 14 paraphrased queries, all labels valid)", () => {
    expect(EVAL_ENTRIES.length).toBe(14);
    expect(EVAL_QUERIES.length).toBe(14);
    const ids = new Set(EVAL_ENTRIES.map((e) => e.id));
    for (const q of EVAL_QUERIES) {
      expect(q.expected.length).toBeGreaterThan(0);
      for (const id of q.expected) expect(ids.has(id)).toBe(true);
    }
  });
});
