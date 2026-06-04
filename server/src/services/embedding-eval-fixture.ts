// PR-12 — Shared retrieval-quality eval fixture.
//
// The labeled fixture (ADE-domain knowledge entries + deliberately PARAPHRASED
// queries with minimal lexical overlap) lives here so it has a SINGLE source of
// truth, consumed by BOTH:
//   - the in-process CI merge gate (retrieval-quality.test.ts), which runs the
//     deterministic, network-free hash-64 tier and asserts a regression band, and
//   - the opt-in eval script (scripts/embedding-eval.ts), which additionally
//     measures the live managed-API tier behind COMBYNE_EVAL_LIVE_EMBEDDINGS=1.
//
// Keeping it here (under src/) lets the test import it without reaching into a
// script and keeps the gate and the script measuring the EXACT same fixture.

export interface EvalEntry {
  id: string;
  subject: string;
  body: string;
}

export interface EvalQuery {
  q: string;
  expected: string[];
}

/** Knowledge entries grounded in ADE/Combyne domains (what a human would capture). */
export const EVAL_ENTRIES: EvalEntry[] = [
  { id: "kafka-naming", subject: "Kafka topic naming convention", body: "Every topic uses the pattern <domain>.<entity>.<event>, lowercase and dot-separated. Never use camelCase or hyphens." },
  { id: "budget-pause", subject: "Token salary budget pause policy", body: "When an agent exceeds its allotted token salary for the window the heartbeat pauses that agent until the window resets; spend is tracked per agent." },
  { id: "auth-actor", subject: "Request identity resolution", body: "actorMiddleware populates req.actor from the agent JWT; in local_trusted mode every request is hardcoded to isInstanceAdmin with source local_implicit." },
  { id: "migration-mech", subject: "How migrations are applied", body: "db:migrate runs tsx src/migrate.ts which reads the .sql files plus meta/_journal.json; there is no snapshot file at apply time. Statements are split on the statement-breakpoint marker." },
  { id: "pr-merge-approval", subject: "Merging a pull request requires an EM decision note", body: "An EM board merge records a human decision note and the deciding user; the reconcile feedback is captured alongside the approval." },
  { id: "memory-trust", subject: "Agent-written memory is never authoritative without a human", body: "Entries authored by an agent are forced to unverified with low confidence at write time; only a human promote/verify action makes them retrievable as fact." },
  { id: "rls-tenant", subject: "Cross-company isolation under row-level security", body: "Once two companies share the instance, Postgres RLS scopes every row by the current company set via SET LOCAL inside a per-request transaction; background scanners use a BYPASSRLS role." },
  { id: "embedded-pg", subject: "Local database with no configuration", body: "If DATABASE_URL is unset the server starts an embedded Postgres on port 54329 and auto-applies migrations; data persists under the home instance directory." },
  { id: "pgbouncer-prepare", subject: "Connection pooler breaks prepared statements", body: "Behind a transaction-mode pooler the postgres client must disable prepared statements, otherwise named prepared-statement errors occur under load." },
  { id: "redact-before-embed", subject: "Secrets are scrubbed before leaving the box", body: "Memory bodies are scanned for credential shapes and the matched span is removed before the text is ever sent to the embedding provider; a detection quarantines the entry for review." },
  { id: "heartbeat-loop", subject: "How an agent gets woken to do work", body: "The control plane does not run agents; on each heartbeat it either executes a process or fires a webhook so an externally running agent wakes, checks its tasks, and reports back." },
  { id: "ticket-parentage", subject: "Every task traces to the company goal", body: "Work is hierarchical: each ticket exists in service of a parent, all the way up to the top-level company objective, so an agent can always answer why it is doing something." },
  { id: "conflict-resolve", subject: "Two humans disagree on the same fact", body: "When answers collide on a normalized subject the UI surfaces both, defaults to the newest entry pushed by that user, and lets a person override, merge, or edit into one canonical record." },
  { id: "summarizer-off", subject: "Transcript summaries stay disabled while dogfooding", body: "The run summarizer is opt-in and left off so no machine-generated, unverified summary content enters the knowledge store during early use." },
];

/** Paraphrased queries — minimal lexical overlap with the target's wording. */
export const EVAL_QUERIES: EvalQuery[] = [
  { q: "what format should I give a brand new event stream channel?", expected: ["kafka-naming"] },
  { q: "an employee blew through its spending allowance — what stops it?", expected: ["budget-pause"] },
  { q: "where in the code is the caller's identity figured out?", expected: ["auth-actor"] },
  { q: "what reads the schema change files when bringing the database up to date?", expected: ["migration-mech"] },
  { q: "what does a manager have to write down before landing someone's code?", expected: ["pr-merge-approval"] },
  { q: "can a bot's own note be trusted as ground truth straight away?", expected: ["memory-trust"] },
  { q: "how do we stop one tenant from reading another tenant's rows?", expected: ["rls-tenant"] },
  { q: "I didn't set any connection string — where does the data live?", expected: ["embedded-pg"] },
  { q: "queries fail with prepared-statement errors behind the pooler — why?", expected: ["pgbouncer-prepare"] },
  { q: "does a password typed into an answer get shipped to a third party?", expected: ["redact-before-embed"] },
  { q: "the platform doesn't execute the workers itself — so how do they run?", expected: ["heartbeat-loop"] },
  { q: "why must each piece of work tie back to the mission?", expected: ["ticket-parentage"] },
  { q: "two people gave different answers — how does a person settle it?", expected: ["conflict-resolve"] },
  { q: "why aren't machine-written run recaps in the store yet?", expected: ["summarizer-off"] },
];

/** Canonical text an entry is embedded as (storage side): `${subject}\n${body}`. */
export function evalEntryText(e: EvalEntry): string {
  return `${e.subject}\n${e.body}`;
}

/** True normalized cosine between two vectors (used by the eval's hash + live tiers). */
export function evalCosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Rank of the first expected entry for a query vector (1-based; Infinity if missing). */
export function evalRankOf(
  queryVec: number[],
  entryVecs: Map<string, number[]>,
  expected: string[],
): number {
  const scored = EVAL_ENTRIES.map((e) => ({ id: e.id, s: evalCosine(queryVec, entryVecs.get(e.id)!) })).sort(
    (x, y) => y.s - x.s,
  );
  for (let i = 0; i < scored.length; i++) {
    if (expected.includes(scored[i].id)) return i + 1;
  }
  return Infinity;
}

export interface EvalMetrics {
  r1: number;
  r3: number;
  r5: number;
  mrr: number;
}

/** recall@1/3/5 + MRR over a set of 1-based ranks. */
export function evalMetrics(ranks: number[]): EvalMetrics {
  const recAt = (k: number) => ranks.filter((r) => r <= k).length / ranks.length;
  const mrr = ranks.reduce((acc, r) => acc + (r === Infinity ? 0 : 1 / r), 0) / ranks.length;
  return { r1: recAt(1), r3: recAt(3), r5: recAt(5), mrr };
}
