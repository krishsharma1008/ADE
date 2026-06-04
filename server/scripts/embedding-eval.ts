/**
 * Embedding retrieval-quality eval (PR-12).
 *
 * Compares the deterministic hash-64 `embedText` oracle against the managed-API
 * embedder on a labeled fixture whose QUERIES are deliberately paraphrased (they
 * share little/no surface vocabulary with the target entry), so this measures
 * SEMANTIC retrieval — exactly the axis a bag-of-hashed-words vector cannot serve.
 *
 *   Hash tier (always, network-free, deterministic — the CI gate):
 *     cd server && pnpm exec tsx scripts/embedding-eval.ts
 *   Live tier (real OpenAI embeddings — proves the lift, costs tokens):
 *     cd server && COMBYNE_EVAL_LIVE_EMBEDDINGS=1 OPENAI_API_KEY=… \
 *       pnpm exec tsx scripts/embedding-eval.ts
 */
import { embedText } from "../src/services/memory.js";
import { makeEmbeddingDriver } from "../src/services/embedding-driver.js";
import {
  EVAL_ENTRIES as ENTRIES,
  EVAL_QUERIES as QUERIES,
  evalEntryText,
  evalMetrics as metrics,
  evalRankOf as rankOf,
} from "../src/services/embedding-eval-fixture.js";

// The fixture (entries, queries, cosine, rankOf, metrics) is shared with the
// in-process CI gate (retrieval-quality.test.ts) so the gate and this script
// always measure the EXACT same fixture and ranking math.

function pct(x: number) { return (x * 100).toFixed(1) + "%"; }

async function main() {
  const entryText = evalEntryText;

  // ---- hash-64 oracle ----
  const hashEntryVecs = new Map(ENTRIES.map((e) => [e.id, embedText(entryText(e))]));
  const hashRanks = QUERIES.map((qq) => rankOf(embedText(qq.q), hashEntryVecs, qq.expected));
  const hash = metrics(hashRanks);

  console.log(`\n  Embedding retrieval eval — ${ENTRIES.length} entries, ${QUERIES.length} paraphrased queries\n`);
  console.log("  tier        recall@1   recall@3   recall@5   MRR");
  console.log("  ----------  ---------  ---------  ---------  ------");
  console.log(`  hash-64     ${pct(hash.r1).padEnd(9)}  ${pct(hash.r3).padEnd(9)}  ${pct(hash.r5).padEnd(9)}  ${hash.mrr.toFixed(3)}`);

  if (process.env.COMBYNE_EVAL_LIVE_EMBEDDINGS === "1") {
    const driver = makeEmbeddingDriver({ model: "text-embedding-3-small", dim: 1536, provider: "openai" });
    const eRes = await driver.embed(ENTRIES.map(entryText));
    const qRes = await driver.embed(QUERIES.map((q) => q.q));
    const liveEntryVecs = new Map(ENTRIES.map((e, i) => [e.id, eRes.vectors[i]]));
    const liveRanks = QUERIES.map((qq, i) => rankOf(qRes.vectors[i], liveEntryVecs, qq.expected));
    const live = metrics(liveRanks);
    console.log(`  ${eRes.version.padEnd(28).slice(0, 10)}  ${pct(live.r1).padEnd(9)}  ${pct(live.r3).padEnd(9)}  ${pct(live.r5).padEnd(9)}  ${live.mrr.toFixed(3)}`);
    console.log(`\n  model=${eRes.version}  tokens=${eRes.inputTokens + qRes.inputTokens}`);
    console.log(`  per-query rank (hash → live):`);
    QUERIES.forEach((qq, i) => {
      const h = hashRanks[i] === Infinity ? "—" : String(hashRanks[i]);
      const l = liveRanks[i] === Infinity ? "—" : String(liveRanks[i]);
      console.log(`    [${qq.expected[0].padEnd(20)}] ${h.padStart(2)} → ${l.padStart(2)}   "${qq.q.slice(0, 52)}"`);
    });
    const lift = (live.mrr - hash.mrr);
    console.log(`\n  MRR lift: +${lift.toFixed(3)} (${pct(hash.mrr)} → ${pct(live.mrr)})  recall@1: ${pct(hash.r1)} → ${pct(live.r1)}`);
  } else {
    console.log(`\n  (live tier skipped — set COMBYNE_EVAL_LIVE_EMBEDDINGS=1 + an OpenAI key to compare)`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
