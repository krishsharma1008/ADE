/**
 * Embedding eval — CODE-STYLE context (PR-12 companion).
 *
 * The real ADE workload is mostly code + things around it: conventions, snippets,
 * stack traces, service ownership, file/path facts, EM/CEO conventions, and the
 * human Q->A answers captured by HOOK 1. This fixture mixes those entry shapes and
 * queries them with realistic per-task questions an EM / CEO / engineer agent asks.
 *
 *   cd server && pnpm exec tsx scripts/embedding-eval-code.ts                 # hash tier
 *   cd server && COMBYNE_EVAL_LIVE_EMBEDDINGS=1 OPENAI_API_KEY=… \
 *       pnpm exec tsx scripts/embedding-eval-code.ts                          # + live
 */
import { embedText, rankEntries } from "../src/services/memory.js";
import { makeEmbeddingDriver } from "../src/services/embedding-driver.js";

interface Entry { id: string; subject: string; body: string; kind: string }
interface Query { q: string; expected: string[]; persona: string }

const ENTRIES: Entry[] = [
  // --- code conventions ---
  { id: "logging-conv", kind: "convention", subject: "Logging convention (Java services)", body: "All services use Lombok @Slf4j; call log.info/log.warn. Never System.out.println. Structured key=value fields only." },
  { id: "kafka-send", kind: "convention", subject: "Publishing to Kafka", body: "Use kafkaTemplate.send(topic, key, payload). Always set a non-null key so partition ordering is preserved per entity. Consumers are idempotent." },
  { id: "resilience", kind: "convention", subject: "Outbound HTTP must be resilient", body: "Wrap every outbound call in a Resilience4j @CircuitBreaker plus @Retry with exponential backoff; no naked RestTemplate.exchange." },
  { id: "error-handling", kind: "convention", subject: "Error responses", body: "Throw ApiException(status, code); the GlobalExceptionHandler maps it to a JSON body { error, code }. Never return raw stack traces to clients." },
  // --- code snippets / API usage ---
  { id: "jwt-verify", kind: "snippet", subject: "Verifying an agent JWT", body: "jwtService.verify(token) returns Claims; the company_id claim is trusted verbatim by actorMiddleware to scope the request. A leaked signing secret forges any tenant." },
  { id: "txn-wrapper", kind: "snippet", subject: "Per-request DB transaction for RLS", body: "Run SET LOCAL app.current_company = $1 inside db.transaction() that also contains the query; SET LOCAL clears at COMMIT so it cannot leak across a pooled connection." },
  // --- stack trace / error patterns ---
  { id: "npe-order", kind: "incident", subject: "NullPointerException in OrderService.charge", body: "NPE at OrderService.java:142 happens when the cart is null because the session expired; guard with Optional.ofNullable(cart) and return 409 CART_EXPIRED." },
  { id: "pool-exhaust", kind: "incident", subject: "Connection pool exhausted under load", body: "HikariPool timeout 'Connection is not available' means too many concurrent requests; behind pgbouncer transaction mode set prepare:false and bound the app pool max." },
  // --- service ownership / architecture ---
  { id: "refund-owner", kind: "ownership", subject: "Refund and chargeback ownership", body: "The billing-service owns all refund and chargeback logic and the RefundController. PaymentController is read-only and must call billing-service, never write refunds directly." },
  { id: "notif-owner", kind: "ownership", subject: "Who sends customer emails", body: "The notification-service owns all outbound email/SMS via the templates registry. Other services publish a NotificationRequested event; they never call SendGrid directly." },
  // --- file / path facts ---
  { id: "auth-path", kind: "pointer", subject: "Where request auth lives", body: "server/src/middleware/auth.ts — actorMiddleware resolves req.actor from the JWT; local_trusted mode hardcodes isInstanceAdmin and source local_implicit." },
  { id: "migration-path", kind: "pointer", subject: "Where schema migrations live", body: "Hand-written SQL under packages/db/src/migrations plus an entry in meta/_journal.json; statements separated by the statement-breakpoint marker, applied by db:migrate." },
  // --- EM / CEO conventions (decisions captured at PR approval) ---
  { id: "em-rate-limit", kind: "em-convention", subject: "EM merge rule: new endpoints need a rate limit", body: "EM approved PR #482: every new public endpoint must carry a @RateLimit annotation and a load test before merge. Approved pattern: token-bucket at 100 rpm default." },
  { id: "ceo-goal", kind: "ceo-directive", subject: "Company priority this quarter", body: "CEO directive: lending-tribe latency is the top objective; prioritize p99 reductions on the loan-origination path over new features until under 300ms." },
  // --- human Q->A answers (HOOK 1 capture format) ---
  { id: "qa-dburl", kind: "human-answer", subject: "Which env var configures the database?", body: "Q: which environment variable holds the database connection?\nA: DATABASE_URL. If it is unset the server runs an embedded Postgres on port 54329 and auto-migrates." },
  { id: "qa-deploy", kind: "human-answer", subject: "How do we deploy the staging build?", body: "Q: how is the staging environment deployed?\nA: push to the release/staging branch; CI builds the image and the Fly staging app picks it up. Never deploy staging from a laptop." },
];

/** Subjects of the code-style eval fixture, re-exported for the global-fixture
 *  cleanup allowlist (scripts/cleanup-global-fixtures.ts). Pairs with EVAL_ENTRIES
 *  in src/services/embedding-eval-fixture.ts. */
export const EVAL_CODE_SUBJECTS = ENTRIES.map((e) => e.subject);

const QUERIES: Query[] = [
  { q: "what should I use for logging in a new service?", expected: ["logging-conv"], persona: "engineer" },
  { q: "how do I make sure messages stay in order when producing to a stream?", expected: ["kafka-send"], persona: "engineer" },
  { q: "what's our standard for protecting calls to a flaky downstream API?", expected: ["resilience"], persona: "engineer" },
  { q: "how should the API return failures to the client?", expected: ["error-handling"], persona: "engineer" },
  { q: "how is the tenant determined from an incoming agent token?", expected: ["jwt-verify"], persona: "engineer" },
  { q: "how do I scope a query to the current company safely behind the pooler?", expected: ["txn-wrapper"], persona: "engineer" },
  { q: "I'm seeing a null pointer in the order charging code, what's the cause?", expected: ["npe-order"], persona: "engineer" },
  { q: "the app says connection is not available under load, how do I fix it?", expected: ["pool-exhaust"], persona: "engineer" },
  { q: "which service should I put new refund handling in?", expected: ["refund-owner"], persona: "em" },
  { q: "how do other services trigger a customer email?", expected: ["notif-owner"], persona: "engineer" },
  { q: "where in the repo is authentication handled?", expected: ["auth-path"], persona: "engineer" },
  { q: "how are database schema changes added to the project?", expected: ["migration-path"], persona: "engineer" },
  { q: "is there anything required before merging a new public route?", expected: ["em-rate-limit"], persona: "em" },
  { q: "what is the company focused on this quarter?", expected: ["ceo-goal"], persona: "ceo" },
  { q: "what env var points at the db connection string?", expected: ["qa-dburl"], persona: "engineer" },
  { q: "how do we ship to staging?", expected: ["qa-deploy"], persona: "engineer" },
  // cross-cutting EM/CEO "per task" retrieval — a sub-agent on a refund ticket should find the owner + the rate-limit rule
  { q: "I'm building a refund endpoint — what do I need to know?", expected: ["refund-owner", "em-rate-limit"], persona: "em" },
];

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function rankOf(qv: number[], vecs: Map<string, number[]>, expected: string[]): number {
  const scored = ENTRIES.map((e) => ({ id: e.id, s: cosine(qv, vecs.get(e.id)!) })).sort((x, y) => y.s - x.s);
  for (let i = 0; i < scored.length; i++) if (expected.includes(scored[i].id)) return i + 1;
  return Infinity;
}
function metrics(ranks: number[]) {
  const recAt = (k: number) => ranks.filter((r) => r <= k).length / ranks.length;
  return { r1: recAt(1), r3: recAt(3), r5: recAt(5), mrr: ranks.reduce((a, r) => a + (r === Infinity ? 0 : 1 / r), 0) / ranks.length };
}
const pct = (x: number) => (x * 100).toFixed(1) + "%";

async function main() {
  const text = (e: Entry) => `${e.subject}\n${e.body}`;
  const hashVecs = new Map(ENTRIES.map((e) => [e.id, embedText(text(e))]));
  const hashRanks = QUERIES.map((q) => rankOf(embedText(q.q), hashVecs, q.expected));
  const hash = metrics(hashRanks);

  console.log(`\n  CODE-CONTEXT embedding eval — ${ENTRIES.length} entries (conventions/snippets/incidents/ownership/pointers/EM+CEO/human-answers), ${QUERIES.length} task queries\n`);
  console.log("  tier        recall@1   recall@3   recall@5   MRR");
  console.log("  ----------  ---------  ---------  ---------  ------");
  console.log(`  hash-64     ${pct(hash.r1).padEnd(9)}  ${pct(hash.r3).padEnd(9)}  ${pct(hash.r5).padEnd(9)}  ${hash.mrr.toFixed(3)}`);

  if (process.env.COMBYNE_EVAL_LIVE_EMBEDDINGS === "1") {
    const driver = makeEmbeddingDriver({ model: "text-embedding-3-small", dim: 1536, provider: "openai" });
    const eRes = await driver.embed(ENTRIES.map(text));
    const qRes = await driver.embed(QUERIES.map((q) => q.q));
    const liveVecs = new Map(ENTRIES.map((e, i) => [e.id, eRes.vectors[i]]));
    const liveRanks = QUERIES.map((q, i) => rankOf(qRes.vectors[i], liveVecs, q.expected));
    const live = metrics(liveRanks);
    console.log(`  oai-1536    ${pct(live.r1).padEnd(9)}  ${pct(live.r3).padEnd(9)}  ${pct(live.r5).padEnd(9)}  ${live.mrr.toFixed(3)}`);

    // Through the ACTUAL production rankEntries (lexical + semantic + recency),
    // same real embeddings, OLD weights (0.5/0.35/0.15) vs NEW embedding-aware
    // weights (auto 0.30/0.55/0.15 when the query version is real). Proves the
    // re-tune lets the production ranker realize the embedder lift, not just cosine.
    const ua = new Date("2026-01-01T00:00:00Z");
    const through = (weights: { lexical?: number; semantic?: number; recency?: number }) => {
      const ranks = QUERIES.map((qq, i) => {
        const rin = ENTRIES.map((e) => ({ id: e.id, layer: "workspace" as const, subject: e.subject, body: e.body, tags: [] as string[], embedding: liveVecs.get(e.id)!, embeddingVersion: eRes.version, lastUsedAt: null, updatedAt: ua }));
        const order = rankEntries(qq.q, rin, weights, { vector: qRes.vectors[i], version: eRes.version }).map((x) => x.id);
        for (let k = 0; k < order.length; k++) if (qq.expected.includes(order[k])) return k + 1;
        return Infinity;
      });
      return metrics(ranks);
    };
    const prodOld = through({ lexical: 0.5, semantic: 0.35, recency: 0.15 });
    const prodNew = through({});
    console.log(`\n  THROUGH production rankEntries (real embeddings):`);
    console.log(`    OLD weights 0.5/0.35/0.15:  recall@1 ${pct(prodOld.r1)}  recall@5 ${pct(prodOld.r5)}  MRR ${prodOld.mrr.toFixed(3)}`);
    console.log(`    NEW weights 0.30/0.55/0.15: recall@1 ${pct(prodNew.r1)}  recall@5 ${pct(prodNew.r5)}  MRR ${prodNew.mrr.toFixed(3)}`);
    // break out the human-answer + EM/CEO subset specifically
    const subset = (ids: string[]) => {
      const idx = QUERIES.map((q, i) => ({ q, i })).filter((x) => x.q.expected.some((e) => ids.includes(e)));
      const h = metrics(idx.map((x) => hashRanks[x.i])); const l = metrics(idx.map((x) => liveRanks[x.i]));
      return { n: idx.length, h, l };
    };
    const ha = subset(["qa-dburl", "qa-deploy"]);
    const emceo = subset(["em-rate-limit", "ceo-goal", "refund-owner"]);
    console.log(`\n  human-answer queries (n=${ha.n}): hash MRR ${ha.h.mrr.toFixed(3)} → live ${ha.l.mrr.toFixed(3)}  (recall@1 ${pct(ha.h.r1)} → ${pct(ha.l.r1)})`);
    console.log(`  EM/CEO per-task queries (n=${emceo.n}): hash MRR ${emceo.h.mrr.toFixed(3)} → live ${emceo.l.mrr.toFixed(3)}  (recall@1 ${pct(emceo.h.r1)} → ${pct(emceo.l.r1)})`);
    console.log(`\n  per-query rank (hash → live):`);
    QUERIES.forEach((q, i) => {
      const h = hashRanks[i] === Infinity ? "—" : String(hashRanks[i]);
      const l = liveRanks[i] === Infinity ? "—" : String(liveRanks[i]);
      console.log(`    ${("[" + q.persona + "]").padEnd(11)} ${h.padStart(2)} → ${l.padStart(2)}  "${q.q.slice(0, 50)}"`);
    });
    console.log(`\n  MRR lift: +${(live.mrr - hash.mrr).toFixed(3)} (${pct(hash.mrr)} → ${pct(live.mrr)})  recall@1 ${pct(hash.r1)} → ${pct(live.r1)}  tokens=${eRes.inputTokens + qRes.inputTokens}`);
  } else {
    console.log(`\n  (live tier skipped — set COMBYNE_EVAL_LIVE_EMBEDDINGS=1 + an OpenAI key)`);
  }
}
// Only run the eval when executed directly as a CLI; importing this module (e.g.
// scripts/cleanup-global-fixtures.ts pulls in EVAL_CODE_SUBJECTS) must be a no-op.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
