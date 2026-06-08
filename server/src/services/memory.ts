import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import {
  memoryEntries,
  memoryPromotions,
  memoryUsage,
  issues,
  agents,
  heartbeatRuns,
} from "@combyne/db";
import type {
  MemoryLayer,
  MemoryOwnerType,
  MemoryEntry,
  MemoryProvenance,
  MemoryVerificationState,
  MemoryAuthorType,
  MemorySourceRefType,
  MemoryQueryResult,
  MemoryManifest,
  MemoryManifestItem,
  MemoryCoreContext,
  MemoryPromotion,
  MemoryVerifyItem,
  MemoryConflictGroup,
} from "@combyne/shared";
import type { MemoryEmbedder, EmbedForStorageResult } from "./memory-embedder.js";
import {
  getMemoryEmbedder,
  getEmbedderTelemetry,
  HASH_EMBEDDING_VERSION,
} from "./memory-embedder.js";
import { resolveContextDb, resolveContextDbUrl } from "./context-db.js";
import { logger } from "../middleware/logger.js";

type MemoryEntryRow = typeof memoryEntries.$inferSelect;

const EMBEDDING_DIM = 64;
const HASH_PRIME = 0x01000193;
const HASH_OFFSET = 0x811c9dc5;

/**
 * Hash-based bag-of-words embedding. Deterministic, dependency-free, and
 * gives the ranker a real semantic-ish signal in tests + dev. Production
 * deployments should swap in a model-based embedder by replacing this one
 * function — the rest of the ranker is agnostic to how the vector is built.
 */
export function embedText(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const idx = h % EMBEDDING_DIM;
    vec[idx] += 1;
  }
  return l2Normalize(vec);
}

function fnv1a(s: string): number {
  let h = HASH_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, HASH_PRIME);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 32);
}

/**
 * Normalized dedup / conflict key for an entry. Conservative by design — it
 * reuses `tokenize()` (lowercase, punctuation-strip) over the SUBJECT only,
 * dedupes tokens, and sorts them so word-order variation collapses to the same
 * key. Because it is purely lexical it UNDER-MERGES: paraphrases, synonyms, and
 * other languages produce different keys, so conflict-detection / supersession
 * silently no-op for those. This is intentional — it never falsely merges two
 * distinct facts. Semantic near-dup detection is deferred until real embeddings
 * land (see CENTRAL_CONTEXT_DB_PLAN §3.6). Returns null for an empty subject.
 */
export function computeSubjectKey(subject: string): string | null {
  const tokens = Array.from(new Set(tokenize(subject))).sort();
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const norm = Math.sqrt(sum);
  return v.map((x) => x / norm);
}

/**
 * Cosine similarity between two L2-normalized vectors (returns the dot product).
 *
 * PR-11 embedding_version guard: when BOTH a version for the query side
 * (`versionA`) and the entry side (`versionB`) are provided, the score is only
 * computed when the versions MATCH. Mismatched versions mean the two vectors
 * live in different embedding spaces (e.g. a 64-dim hash vector vs a 1536-dim
 * API vector); dotting them over min(len) returns a valid-but-meaningless score
 * with no error. On a version mismatch we return 0 — never cross-score two
 * spaces. Callers that have unembedded/hash-space query+entry pairs simply omit
 * the versions (the legacy 2-arg call) and get the historical behaviour.
 */
export function cosineSimilarity(
  a: number[] | null,
  b: number[] | null,
  versionA?: string | null,
  versionB?: string | null,
): number {
  if (!a || !b) return 0;
  // Version guard: refuse to cross-score vectors from different embedding spaces.
  //
  // M1: a legacy row can carry a real embedding but a NULL embedding_version
  // (pre-versioning). Treating NULL as "unknown / skip the guard" let such a row
  // cross-score a real-model query (e.g. openai:…:1536 vs hash) — a silent
  // cross-space score. We instead treat a NULL version as the hash space
  // ('hash-64:64', the only thing that ever wrote a null-version vector), so a
  // null-vs-real comparison correctly refuses (returns 0) while null-vs-null
  // (hash vs hash) and same-version both stay allowed. The guard only fires when
  // at least one side carries a known (passed-in) version — the legacy 2-arg call
  // (both undefined) keeps its historical version-agnostic behaviour.
  if (
    (versionA !== undefined && versionA !== null) ||
    (versionB !== undefined && versionB !== null)
  ) {
    const va = versionA ?? "hash-64:64";
    const vb = versionB ?? "hash-64:64";
    if (va !== vb) return 0;
  }
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

function lexicalScore(query: string, subject: string, body: string, tags: string[]): number {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;
  const subjTokens = new Set(tokenize(subject));
  const bodyTokens = new Set(tokenize(body));
  const tagTokens = new Set(tags.map((t) => t.toLowerCase()));
  let hits = 0;
  let weight = 0;
  for (const q of qTokens) {
    if (subjTokens.has(q)) {
      hits++;
      weight += 3;
      continue;
    }
    if (tagTokens.has(q)) {
      hits++;
      weight += 2;
      continue;
    }
    if (bodyTokens.has(q)) {
      hits++;
      weight += 1;
    }
  }
  if (hits === 0) return 0;
  return weight / (qTokens.size * 3);
}

const RECENCY_HALF_LIFE_DAYS = 14;

function recencyBoost(lastUsedAt: Date | null, updatedAt: Date): number {
  const ref = lastUsedAt && lastUsedAt > updatedAt ? lastUsedAt : updatedAt;
  const ageMs = Date.now() - ref.getTime();
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

const LAYER_WEIGHT: Record<MemoryLayer, number> = {
  personal: 1.2,
  workspace: 1.0,
  shared: 0.95,
  // Instance-wide global org conventions: weighted like shared (a peer cross-cut
  // layer), so a global fact ranks comparably to a company's shared fact.
  global: 1.0,
};

/**
 * Default minimum combined relevance score a row must clear on the REAL-embedding
 * path before it is allowed to surface. Recency alone keeps every row above zero,
 * so without a score floor a fresh-but-semantically-orthogonal row (incl. a
 * force-fetched global fixture) leaks into results. Env-tunable so it can be
 * calibrated without a code change.
 */
const DEFAULT_MIN_RELEVANCE_SCORE = 0.25;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve the relevance floor for a query, keyed on the QUERY embedding's version.
 *
 * On the hash-64 oracle path (`undefined` / `HASH_EMBEDDING_VERSION`) the cosine
 * channel is near-noise, so we keep the historical `signal` mode — a row needs any
 * lexical or non-trivial semantic signal (`r.lexical > 0 || r.semantic > 0.05`)
 * and the suite stays byte-identical. On a REAL embedder version the cosine signal
 * is meaningful, so we switch to `score` mode: a row must clear an absolute combined
 * `score` floor (env-tunable via COMBYNE_MIN_RELEVANCE_SCORE), which drops
 * recency-only / orthogonal rows that the signal test would have let through.
 */
export function minRelevanceForVersion(
  version: string | undefined,
): { mode: "signal"; floor: 0 } | { mode: "score"; floor: number } {
  if (version === undefined || version === HASH_EMBEDDING_VERSION) {
    return { mode: "signal", floor: 0 };
  }
  return {
    mode: "score",
    floor: envNumber("COMBYNE_MIN_RELEVANCE_SCORE", DEFAULT_MIN_RELEVANCE_SCORE),
  };
}

export interface RankInputEntry {
  id: string;
  layer: MemoryLayer;
  subject: string;
  body: string;
  tags: string[];
  embedding: number[] | null;
  /**
   * embedding_version of `embedding` (PR-11). When present alongside the query
   * embedding's version, the cosine version-guard refuses to cross-score two
   * spaces. Omitted (undefined) for the legacy hash-only path.
   */
  embeddingVersion?: string | null;
  lastUsedAt: Date | null;
  updatedAt: Date;
}

/** A precomputed query embedding lifted OUT of rankEntries (PR-11, §0.3). */
export interface QueryEmbedding {
  vector: number[];
  version: string;
}

/** Read-only ops snapshot of the embedding stack for GET /memory/embedding-status. */
export interface EmbeddingStatus {
  /** True only when a real embedder will be called (flag on AND key present). */
  embedderEnabled: boolean;
  /** The embedding_version a successful embed currently writes. */
  currentVersion: string;
  /** Count of active entries in the company. */
  activeEntries: number;
  /** Fraction of active entries on currentVersion (1 when empty). 1.0 == fully migrated. */
  versionCoveragePct: number;
  /** Fraction of active entries stuck on the hash-64 oracle (0 when empty). */
  hashFallbackPct: number;
  /** Count of active entries per embedding_version value present. */
  versionBreakdown: Record<string, number>;
  /** Active entries off currentVersion (or missing embedding_vec) — the backfill backlog. */
  reembedBacklog: number;
  /** Active entries quarantined to needs_review (includes redact-before-embed blocks). */
  redactionBlocked: number;
  /** Whether an HNSW index exists on embedding_vec (else the pushdown is brute-force KNN). */
  hnswIndexPresent: boolean;
  /** Whether the pgvector embedding_vec column exists on this deployment. */
  pgvectorPresent: boolean;
  /** Process-local count of embeds that fell back to hash-64 (resets on restart). */
  queryHashFallbacks: number;
  /** Process-local count of long-body truncations before egress (resets on restart). */
  truncations: number;
  /** EMB-3: the dominant real (non-hash) embedding_version in the SHARED corpus
   * (across all companies), or null when none/single-DB. Lets the UI show whether
   * this machine's embedder agrees with the rest of the team. */
  corpusDominantVersion: string | null;
  /** EMB-3: true when this machine's embedder version disagrees with the shared
   * corpus's dominant version — its new real vectors would be cross-version
   * (ANN-invisible to teammates). A loud signal that EMBEDDING_MODEL/DIM drifted. */
  corpusVersionMismatch: boolean;
}

export interface RankedEntry {
  id: string;
  score: number;
  lexical: number;
  semantic: number;
  recency: number;
}

/**
 * Hybrid ranker: lexical + embedding-cosine + recency, scaled by layer weight.
 * Pure function — easy to unit-test without a DB. Stays SYNC and deterministic.
 *
 * PR-11 (§1.1 load-bearing): the QUERY-side embedding is lifted OUT of this
 * ranker into an async pre-step (embedQuery). queryRanked computes the query
 * embedding first and passes it in via `queryEmbedding`. When `queryEmbedding`
 * is omitted (the test oracle + any pure caller), the ranker falls back to the
 * deterministic hash-64 embedText(query) — preserving the historical behaviour
 * and keeping memory-ranker.test.ts green. The cosine version-guard then refuses
 * to cross-score a hash-space query against an API-space entry vector.
 */
export function rankEntries(
  query: string,
  entries: RankInputEntry[],
  weights: { lexical?: number; semantic?: number; recency?: number } = {},
  queryEmbedding?: QueryEmbedding,
): RankedEntry[] {
  // Fall back to the synchronous hash embedding when no precomputed query
  // embedding is supplied (the pure-ranker oracle path).
  const queryEmb = queryEmbedding?.vector ?? embedText(query);
  const queryVersion = queryEmbedding?.version;
  // Embedding-aware default weights. The hash-64 era weights (0.5/0.35/0.15) were
  // tuned when the semantic channel was near-noise, so lexical dominated. With a
  // REAL model the cosine signal is strong (eval: MRR 0.94 vs hash 0.38 on
  // paraphrased queries), but at 0.35 it is diluted below lexical — which is ~0 on
  // exactly the paraphrased/conceptual queries where semantic shines — and can be
  // outvoted by recency. So when the query was embedded by a real model, let
  // semantic dominate (lexical still rewards exact-keyword hits; recency stays a
  // light tiebreaker). Hash-64 / oracle path keeps the original weights, so the
  // test rig and every existing test are unaffected. Explicit weights always win.
  const semanticStrong = queryVersion != null && queryVersion !== HASH_EMBEDDING_VERSION;
  const wLex = weights.lexical ?? (semanticStrong ? 0.3 : 0.5);
  const wSem = weights.semantic ?? (semanticStrong ? 0.55 : 0.35);
  const wRec = weights.recency ?? 0.15;
  return entries
    .map((entry) => {
      const lex = lexicalScore(query, entry.subject, entry.body, entry.tags);
      const sem = cosineSimilarity(queryEmb, entry.embedding, queryVersion, entry.embeddingVersion);
      const rec = recencyBoost(entry.lastUsedAt, entry.updatedAt);
      const layerW = LAYER_WEIGHT[entry.layer];
      const score = (wLex * lex + wSem * sem + wRec * rec) * layerW;
      return { id: entry.id, score, lexical: lex, semantic: sem, recency: rec };
    })
    .sort((a, b) => b.score - a.score);
}

function rowToEntry(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    layer: row.layer as MemoryLayer,
    ownerType: (row.ownerType as MemoryOwnerType | null) ?? null,
    ownerId: row.ownerId ?? null,
    subject: row.subject,
    body: row.body,
    kind: row.kind as MemoryEntry["kind"],
    tags: (row.tags as string[]) ?? [],
    serviceScope: row.serviceScope ?? null,
    source: row.source ?? null,
    embedding: (row.embedding as number[] | null) ?? null,
    provenance: (row.provenance as MemoryProvenance | null) ?? null,
    verificationState: (row.verificationState as MemoryVerificationState) ?? "unverified",
    confidence: row.confidence ?? 0.5,
    authorType: (row.authorType as MemoryAuthorType | null) ?? null,
    authorId: row.authorId ?? null,
    sourceRefType: (row.sourceRefType as MemorySourceRefType | null) ?? null,
    sourceRefId: row.sourceRefId ?? null,
    subjectKey: row.subjectKey ?? null,
    supersededById: row.supersededById ?? null,
    verifiedBy: row.verifiedBy ?? null,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    embeddingVersion: row.embeddingVersion ?? null,
    status: row.status as MemoryEntry["status"],
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    ttlDays: row.ttlDays ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Human-readable source citation for the Capture inbox (§3.3). Prefers the
 * structured source-ref the capture hook stamped (e.g. issue/PR/comment), then
 * falls back to the free-text `source` string. Returns null when neither exists.
 */
function formatCitation(entry: MemoryEntry): string | null {
  if (entry.sourceRefType && entry.sourceRefId) {
    const label =
      entry.sourceRefType === "issue"
        ? "issue"
        : entry.sourceRefType === "pr"
          ? "PR"
          : entry.sourceRefType;
    return `${label} #${entry.sourceRefId}`;
  }
  if (entry.source) return entry.source;
  return null;
}

/**
 * Split a captured `Q: …\nA: …` human-answer body (HOOK 1 format, routes/issues.ts)
 * back into its question and answer halves for the Questions tab (PR-16). Falls
 * back gracefully: a body that does not match the convention yields `{question:
 * null, answer: <body>}` so older/free-form captures still render their answer.
 */
function splitCapturedQa(body: string): { question: string | null; answer: string | null } {
  const match = /^Q:\s*([\s\S]*?)\n+A:\s*([\s\S]*)$/.exec(body);
  if (match) {
    return { question: match[1].trim() || null, answer: match[2].trim() || null };
  }
  return { question: null, answer: body.trim() || null };
}

export interface CreateEntryInput {
  /**
   * Owning company. Required for workspace/personal/shared. For the instance-wide
   * GLOBAL layer (0054) it is ignored and forced to NULL (global entries are
   * company-agnostic).
   */
  companyId: string | null;
  layer: MemoryLayer;
  /**
   * GLOBAL-layer governance (0054): a layer='global' write is rejected unless the
   * actor is an instance admin. Mirrors the shared-layer "promotion-only" gate.
   * Threaded from the route (assertInstanceAdmin) — never from a raw request body.
   */
  isInstanceAdmin?: boolean;
  subject: string;
  body: string;
  kind?: string;
  tags?: string[];
  serviceScope?: string | null;
  source?: string | null;
  ownerType?: MemoryOwnerType | null;
  ownerId?: string | null;
  ttlDays?: number | null;
  createdBy?: string | null;
  // Trust spine (0049).
  provenance?: MemoryProvenance | null;
  verificationState?: MemoryVerificationState;
  confidence?: number;
  authorType?: MemoryAuthorType | null;
  authorId?: string | null;
  sourceRefType?: MemorySourceRefType | null;
  sourceRefId?: string | null;
}

/**
 * Provenances an AGENT author is allowed to carry. Anything else from an agent
 * is force-quarantined to unverified/low-confidence by the write-gate, so an
 * agent can never self-assert a trusted row (the primary trust amplifier).
 * 'human-answer' / 'pr-approval' are the human capture hooks; an agent actor
 * cannot reach those provenances (the route + hooks set authorType correctly).
 */
const AGENT_TRUSTED_PROVENANCES: ReadonlySet<MemoryProvenance> = new Set([
  "human-answer",
  "pr-approval",
]);

/** Max confidence an agent-authored, non-trusted-provenance entry may hold. */
const AGENT_QUARANTINE_MAX_CONFIDENCE = 0.4;

export interface UpdateEntryInput {
  subject?: string;
  body?: string;
  kind?: string;
  tags?: string[];
  serviceScope?: string | null;
  source?: string | null;
  status?: string;
  ttlDays?: number | null;
}

/**
 * The ONE canonical retrieval-options signature (MEMORY_UI_AND_QUALITY_PLAN §0.3).
 * Every retrieval call site — heartbeat self-retrieval, the EM passdown packet
 * (PR-9), and any future path — threads this exact shape through queryRanked so
 * the three in-flight designs (trust filter, embedding swap, passdown) cannot
 * collide on the opts object. The trust fields below are CENTRAL_CONTEXT_DB_PLAN
 * §3.2 (two-sided rule): apply requireVerified/minConfidence/excludeSuperseded on
 * the retrieval side to BOTH channels, never one.
 */
export interface QueryOptions {
  layers?: MemoryLayer[];
  ownerType?: MemoryOwnerType;
  ownerId?: string;
  serviceScope?: string;
  limit?: number;
  includeSnippets?: boolean;
  // ---- core-plan §3.2 trust filter (sufficiency gate + passdown consume) ----
  /** Drop rows below this confidence floor. undefined = no floor (label-only). */
  minConfidence?: number;
  /**
   * When true, only verification_state='verified' rows survive. DEFAULT false:
   * this is the §3.3 label-then-exclude rollout — flipping to true before a
   * backfill empties the preamble (the starvation failure). The flip is a
   * Phase-2 one-line change at the heartbeat call site, never here.
   */
  requireVerified?: boolean;
  /** When true (DEFAULT), hide rows whose supersededById is set (conflict losers). */
  excludeSuperseded?: boolean;
}

/**
 * Provenance precedence for §3.6 conflict resolution: within a subjectKey, the
 * highest-precedence row wins; ties break by recency. Higher number = stronger.
 * human-answer > pr-approval > verified-summary > agent-claim.
 */
const PROVENANCE_PRECEDENCE: Record<string, number> = {
  "human-answer": 4,
  "pr-approval": 3,
  "verified-summary": 2,
  "agent-claim": 1,
};

function provenanceRank(provenance: string | null): number {
  if (!provenance) return 0;
  return PROVENANCE_PRECEDENCE[provenance] ?? 0;
}

export function memoryService(db: Db, embedder: MemoryEmbedder = getMemoryEmbedder()) {
  // The memory tables (memory_entries/promotions/usage) physically live in the
  // context DB when CONTEXT_DATABASE_URL is configured; otherwise `cdb === db`
  // (single-DB mode, default). Non-memory reads (issues/agents/heartbeat_runs)
  // intentionally keep using `db` (the main DB) below.
  const cdb = resolveContextDb(db);
  /**
   * Best-effort vector write (PR-11). Writes the pgvector `embedding_vec` column
   * + bookkeeping ONLY when the embedder is enabled (real pgvector deployment).
   * On the hash-64/test path the column is absent, so we touch it via raw SQL
   * gated on `embedder.enabled` and swallow any error — a vector write must
   * never fail or block a memory write.
   */
  // Cached once per service instance: does the pgvector `embedding_vec` column
  // exist? On a real pgvector deployment yes; on a rig without pgvector no. We
  // avoid issuing a doomed `embedding_vec` write on every memory write.
  // EMB-3: the dominant REAL (non-hash) embedding_version across the whole shared
  // corpus, memoized once per service instance. Used to detect a teammate whose
  // EMBEDDING_MODEL/DIM drifted from the team's canonical version, and to surface
  // it on the status endpoint. null = no real rows yet / single-DB / not probed.
  let corpusDominantVersionMemo: { value: string | null } | null = null;
  let driftWarned = false;
  async function corpusDominantVersion(): Promise<string | null> {
    if (corpusDominantVersionMemo) return corpusDominantVersionMemo.value;
    // Only meaningful for a shared remote corpus with real vectors enabled.
    if (!embedder.enabled || !resolveContextDbUrl()) {
      corpusDominantVersionMemo = { value: null };
      return null;
    }
    try {
      const rows = (await cdb.execute(sql`
        SELECT embedding_version AS v, COUNT(*)::int AS n
        FROM ${memoryEntries}
        WHERE embedding_version IS NOT NULL AND embedding_version <> ${HASH_EMBEDDING_VERSION}
        GROUP BY embedding_version
        ORDER BY n DESC
        LIMIT 1
      `)) as unknown as Array<{ v: string; n: number }>;
      corpusDominantVersionMemo = { value: rows[0]?.v ?? null };
    } catch {
      corpusDominantVersionMemo = { value: null };
    }
    return corpusDominantVersionMemo.value;
  }

  let vectorColumnPresent: boolean | null = null;
  async function hasVectorColumn(): Promise<boolean> {
    if (vectorColumnPresent !== null) return vectorColumnPresent;
    try {
      const rows = (await cdb.execute(sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'memory_entries'
          AND column_name = 'embedding_vec'
        LIMIT 1
      `)) as unknown as unknown[];
      vectorColumnPresent = rows.length > 0;
    } catch {
      vectorColumnPresent = false;
    }
    return vectorColumnPresent;
  }

  async function writeVectorColumns(
    id: string,
    storage: { vector: number[]; version: string; model: string; contentHash: string },
  ): Promise<void> {
    if (!embedder.enabled || storage.version === "hash-64:64") return;
    // Always persist the bookkeeping columns (created unconditionally by 0052).
    // embedding_model holds the BARE model (e.g. 'text-embedding-3-small'); the
    // composite 'provider:model:dim' stays in embedding_version. Storing the
    // bare model keeps the column useful for per-model analytics / HNSW gating
    // instead of duplicating embedding_version.
    await cdb
      .execute(sql`
        UPDATE ${memoryEntries}
        SET embedding_model = ${storage.model},
            embedding_dim = ${storage.vector.length},
            content_hash = ${storage.contentHash}
        WHERE id = ${id}
      `)
      .catch(() => {});
    // The pgvector column only when it exists.
    if (await hasVectorColumn()) {
      const literal = `[${storage.vector.join(",")}]`;
      await cdb
        .execute(
          sql`UPDATE ${memoryEntries} SET embedding_vec = ${literal}::vector WHERE id = ${id}`,
        )
        // EMB-1: distinguish a DIMENSION MISMATCH (the configured EMBEDDING_DIM does
        // not match the shared vector(N) column → the write is silently dropped and
        // the row is ANN-invisible) from the benign column-absent / transient case.
        // A dim mismatch is logged loudly so a mis-configured teammate is detectable.
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (/dimension|expected \d+ dimensions/i.test(msg)) {
            logger.warn(
              { id, configuredDim: storage.vector.length, err: msg },
              "memory.embedding_vec_dim_mismatch: configured EMBEDDING_DIM disagrees with the shared " +
                "vector column width; this vector was NOT stored and the row is ANN-invisible.",
            );
          }
          // else tolerate quietly (column absent / transient)
        });
    }
  }

  async function createEntry(input: CreateEntryInput): Promise<MemoryEntry> {
    if (input.layer === "shared") {
      throw new Error("shared entries must be created via promotion");
    }
    // GLOBAL-layer governance (0054): an instance-wide global write requires an
    // instance admin (mirrors the shared-layer write fence). A non-admin actor —
    // including a company board — can never author a global row.
    if (input.layer === "global" && !input.isInstanceAdmin) {
      throw new Error("global entries require an instance admin");
    }
    if (input.layer === "personal" && (!input.ownerType || !input.ownerId)) {
      throw new Error("personal entries require ownerType and ownerId");
    }
    // Global entries are company-agnostic: company_id is NULL regardless of any
    // company context the caller passed. Every other layer carries its company id.
    const companyId = input.layer === "global" ? null : input.companyId;
    // PR-11: redact-before-embed + hash fallback. Writes the jsonb `embedding`
    // (oracle/fallback) + embedding_version always; the embedding_vec column is
    // written separately (best-effort) only on a real pgvector deployment.
    const embedResult = await embedder.embedForStorage(input.subject, input.body);
    const embedding = embedResult.vector;
    const subjectKey = computeSubjectKey(input.subject);

    // EMB-3: detect embedding-config drift on a SHARED corpus. If this machine's
    // real embedder version disagrees with the corpus's dominant version, its new
    // vectors are cross-version (ANN-invisible to teammates; the read-side cosine
    // guard already prevents mis-scoring). Surface it loudly ONCE so a fat-fingered
    // EMBEDDING_MODEL/DIM is detected at write time instead of silently degrading.
    if (embedResult.version !== HASH_EMBEDDING_VERSION) {
      const dominant = await corpusDominantVersion();
      if (dominant && dominant !== embedResult.version && !driftWarned) {
        driftWarned = true;
        logger.warn(
          { localVersion: embedResult.version, corpusVersion: dominant },
          "memory.embedding_version_drift: this machine's embedder disagrees with the shared corpus; " +
            "new vectors will be ANN-invisible to teammates. Align COMBYNE_EMBEDDING_MODEL/DIM with the team.",
        );
      }
    }

    // ---- WRITE-side trust gate (§3.2) ----
    // The default verification state is 'unverified' / confidence 0.5. A caller
    // may request a higher trust tier, but when the AUTHOR is an agent and the
    // provenance is not one of the human capture hooks we FORCE the entry back
    // to unverified and clamp confidence — regardless of what the caller asked
    // for. This is the single chokepoint that stops an agent self-asserting a
    // 'verified' workspace fact. authorType is set by the caller from the actor
    // (route / capture hooks), never from a raw request body.
    let provenance = input.provenance ?? null;
    let verificationState: MemoryVerificationState = input.verificationState ?? "unverified";
    let confidence = input.confidence ?? 0.5;
    const authorType = input.authorType ?? null;
    if (
      authorType === "agent" &&
      (provenance === null || !AGENT_TRUSTED_PROVENANCES.has(provenance))
    ) {
      provenance = provenance ?? "agent-claim";
      verificationState = "unverified";
      confidence = Math.min(confidence, AGENT_QUARANTINE_MAX_CONFIDENCE);
    }

    // ---- PR-11 redact-before-embed quarantine (§1.4.1) ----
    // The embedder scanned subject+body for credential shapes before egress. If
    // it found and redacted any, the entry is force-quarantined to needs_review
    // (excluded from retrieval) so a secret never both egresses AND lands in the
    // highest-trust, never-expiring tier.
    if (embedResult.redactedFindings.length > 0) {
      verificationState = "needs_review";
    }

    const insertValues = {
      companyId,
      layer: input.layer,
      ownerType: input.layer === "personal" ? input.ownerType ?? null : null,
      ownerId: input.layer === "personal" ? input.ownerId ?? null : null,
      subject: input.subject,
      body: input.body,
      kind: input.kind ?? "fact",
      tags: input.tags ?? [],
      serviceScope: input.serviceScope ?? null,
      source: input.source ?? null,
      embedding,
      embeddingVersion: embedResult.version,
      provenance,
      verificationState,
      confidence,
      authorType,
      authorId: input.authorId ?? null,
      sourceRefType: input.sourceRefType ?? null,
      sourceRefId: input.sourceRefId ?? null,
      subjectKey,
      ttlDays: input.ttlDays ?? null,
      createdBy: input.createdBy ?? null,
    };

    // ---- Idempotent capture (§4.3) ----
    // (companyId, source) is the natural key for sourced captures (human-answer
    // retries, reconcile-twice, accepted-work replays). The unique partial index
    // on (company_id, source) WHERE source IS NOT NULL backs an onConflictDoNothing
    // upsert: a re-fire inserts zero rows, then we re-select the existing one.
    // Un-sourced entries (source IS NULL) are never deduped here.
    if (input.source) {
      const [inserted] = await cdb
        .insert(memoryEntries)
        .values(insertValues)
        .onConflictDoNothing({
          target: [memoryEntries.companyId, memoryEntries.source],
          // Match the PARTIAL unique index (WHERE source IS NOT NULL); without
          // this predicate Postgres rejects the ON CONFLICT target as unmatched.
          // For onConflictDoNothing, `where` is the target index predicate.
          where: sql`${memoryEntries.source} IS NOT NULL`,
        })
        .returning();
      if (inserted) {
        await writeVectorColumns(inserted.id, {
          vector: embedding,
          version: embedResult.version,
          model: embedResult.model,
          contentHash: embedResult.contentHash,
        });
        return rowToEntry(inserted);
      }
      const [existing] = await cdb
        .select()
        .from(memoryEntries)
        .where(
          and(
            companyId === null
              ? isNull(memoryEntries.companyId)
              : eq(memoryEntries.companyId, companyId),
            eq(memoryEntries.source, input.source),
          ),
        )
        .limit(1);
      return rowToEntry(existing);
    }

    const [row] = await cdb.insert(memoryEntries).values(insertValues).returning();
    await writeVectorColumns(row.id, {
      vector: embedding,
      version: embedResult.version,
      model: embedResult.model,
      contentHash: embedResult.contentHash,
    });
    return rowToEntry(row);
  }

  async function getEntry(id: string): Promise<MemoryEntry | null> {
    const rows = await cdb.select().from(memoryEntries).where(eq(memoryEntries.id, id)).limit(1);
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async function updateEntry(id: string, input: UpdateEntryInput): Promise<MemoryEntry | null> {
    const existing = await getEntry(id);
    if (!existing) return null;
    const next = {
      subject: input.subject ?? existing.subject,
      body: input.body ?? existing.body,
    };
    // PR-11: re-embed ONLY when the subject/body content actually changed. The
    // previous code re-embedded on ANY subject/body field touch even when the
    // value was identical; gating on the content hash skips a redundant embed
    // (and a provider call on the real embedder path) for an unchanged body.
    const textChanged =
      (input.subject !== undefined && input.subject !== existing.subject) ||
      (input.body !== undefined && input.body !== existing.body);
    let embedResult: EmbedForStorageResult | undefined;
    if (textChanged) {
      embedResult = await embedder.embedForStorage(next.subject, next.body);
    }
    const updates: Partial<MemoryEntryRow> & { updatedAt: Date } = { updatedAt: new Date() };
    if (input.subject !== undefined) updates.subject = input.subject;
    if (input.body !== undefined) updates.body = input.body;
    if (input.kind !== undefined) updates.kind = input.kind;
    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.serviceScope !== undefined) updates.serviceScope = input.serviceScope;
    if (input.source !== undefined) updates.source = input.source;
    if (input.status !== undefined) updates.status = input.status;
    if (input.ttlDays !== undefined) updates.ttlDays = input.ttlDays;
    if (embedResult) {
      updates.embedding = embedResult.vector;
      updates.embeddingVersion = embedResult.version;
      // A re-embed that newly redacted a secret re-quarantines the entry.
      if (embedResult.redactedFindings.length > 0) updates.verificationState = "needs_review";
    }
    if (input.subject !== undefined) updates.subjectKey = computeSubjectKey(input.subject);
    const [row] = await cdb
      .update(memoryEntries)
      .set(updates)
      .where(eq(memoryEntries.id, id))
      .returning();
    if (row && embedResult) {
      await writeVectorColumns(row.id, {
        vector: embedResult.vector,
        version: embedResult.version,
        model: embedResult.model,
        contentHash: embedResult.contentHash,
      });
    }
    return row ? rowToEntry(row) : null;
  }

  async function archiveEntry(id: string): Promise<MemoryEntry | null> {
    return updateEntry(id, { status: "archived" });
  }

  async function listEntries(opts: {
    companyId: string;
    layer?: MemoryLayer;
    ownerType?: MemoryOwnerType;
    ownerId?: string;
    status?: string;
    limit?: number;
    // Trust-spine (0049) browse filters surfaced by the Memory UI (PR-13).
    provenance?: MemoryProvenance;
    verificationState?: MemoryVerificationState;
    minConfidence?: number;
    serviceScope?: string;
    // Relative recency window: only return rows updated within the last N days.
    ageDays?: number;
  }): Promise<MemoryEntry[]> {
    // M6: the instance-wide GLOBAL layer (0054) is the only cross-company layer —
    // its rows carry company_id = NULL. When the caller explicitly asks for it,
    // scope by `company_id IS NULL` so the global rows surface; every other layer
    // stays strictly company-scoped (eq(companyId)), preserving per-company
    // isolation exactly as before.
    const filters =
      opts.layer === "global"
        ? [isNull(memoryEntries.companyId)]
        : [eq(memoryEntries.companyId, opts.companyId)];
    if (opts.layer) filters.push(eq(memoryEntries.layer, opts.layer));
    if (opts.ownerType) filters.push(eq(memoryEntries.ownerType, opts.ownerType));
    if (opts.ownerId) filters.push(eq(memoryEntries.ownerId, opts.ownerId));
    filters.push(eq(memoryEntries.status, opts.status ?? "active"));
    if (opts.provenance) filters.push(eq(memoryEntries.provenance, opts.provenance));
    if (opts.verificationState) {
      filters.push(eq(memoryEntries.verificationState, opts.verificationState));
    }
    if (opts.minConfidence !== undefined) {
      filters.push(gte(memoryEntries.confidence, opts.minConfidence));
    }
    if (opts.serviceScope) filters.push(eq(memoryEntries.serviceScope, opts.serviceScope));
    if (opts.ageDays !== undefined && opts.ageDays > 0) {
      const cutoff = new Date(Date.now() - opts.ageDays * 24 * 60 * 60 * 1000);
      filters.push(gte(memoryEntries.updatedAt, cutoff));
    }
    const rows = await cdb
      .select()
      .from(memoryEntries)
      .where(and(...filters))
      .orderBy(desc(memoryEntries.updatedAt))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    return rows.map(rowToEntry);
  }

  /**
   * Load candidate entries for ranking. We over-fetch (cap at 500) and rank
   * in-process. With pgvector this would become a `<=> queryEmb LIMIT k`
   * query — the swap point lives entirely inside this function.
   */
  async function loadCandidates(
    companyId: string,
    opts: QueryOptions,
    queryEmbedding?: QueryEmbedding,
  ): Promise<MemoryEntryRow[]> {
    // Company scope UNION the instance-wide GLOBAL layer (0054): a query for any
    // company surfaces its own rows AND the company-agnostic global rows
    // (company_id = $companyId OR layer = 'global'). Per-company isolation for
    // workspace/personal/shared is preserved — only global is cross-company.
    const filters = [
      or(eq(memoryEntries.companyId, companyId), eq(memoryEntries.layer, "global")),
      eq(memoryEntries.status, "active"),
    ];
    if (opts.layers && opts.layers.length > 0) {
      // M2: a plain `inArray(layer, opts.layers)` AND'd onto the company-OR-global
      // base filter masks the global arm — an agent path that requests explicit
      // layers (e.g. ['workspace','shared'], omitting 'global') would lose every
      // global row. OR 'global' back in so the cross-company global layer ALWAYS
      // survives a layer restriction.
      filters.push(
        or(inArray(memoryEntries.layer, opts.layers), eq(memoryEntries.layer, "global")),
      );
    }
    if (opts.serviceScope) {
      filters.push(eq(memoryEntries.serviceScope, opts.serviceScope));
    }
    // ---- §3.2 retrieval-side trust filter (BOTH channels) ----
    if (opts.requireVerified) {
      filters.push(eq(memoryEntries.verificationState, "verified"));
    }
    if (opts.minConfidence !== undefined) {
      filters.push(gte(memoryEntries.confidence, opts.minConfidence));
    }
    // excludeSuperseded defaults true once 0049 lands: hide conflict losers.
    if (opts.excludeSuperseded !== false) {
      filters.push(isNull(memoryEntries.supersededById));
    }

    // ---- PR-11 pgvector ANN pushdown (§1.7) ----
    // When the embedder is enabled (real pgvector deployment) and the query was
    // embedded with the SAME version, push the nearest-neighbour ordering into
    // Postgres: `embedding_vec <=> $q ORDER BY … LIMIT k`. This replaces the
    // unordered 500-row window with a true top-k and is best-effort — any error
    // (e.g. column absent) falls through to the jsonb/lexical path below.
    if (
      embedder.enabled &&
      queryEmbedding &&
      queryEmbedding.version !== "hash-64:64" &&
      (await hasVectorColumn())
    ) {
      const annRows = await loadCandidatesByVector(companyId, opts, queryEmbedding).catch(
        () => null,
      );
      // CRITICAL (correctness-transition critique): the ANN query filters
      // `embedding_version = <current>`, so on a not-yet-reembedded corpus it
      // returns `[]` — and `[]` is TRUTHY. The old `if (annRows)` therefore
      // short-circuited and returned ZERO candidates for EVERY query during the
      // pre-backfill window (a silent dark-retrieval blackout, the worst failure
      // for a memory system). We now fall through to the jsonb/lexical window
      // when the ANN result is EMPTY so a partially/never-backfilled corpus
      // still surfaces context (lexical + any reembedded rows). A genuinely
      // empty corpus pays one cheap jsonb scan, which is harmless.
      if (annRows && annRows.length > 0) return filterPersonal(annRows, opts);
    }

    const rows = await cdb
      .select()
      .from(memoryEntries)
      .where(and(...filters))
      // Deterministic 500-row window: ORDER BY updatedAt desc so the cap drops
      // the oldest rows rather than an arbitrary set (the ORDER BY-into-rank
      // quality fix is a later slice; this only makes the window stable).
      .orderBy(desc(memoryEntries.updatedAt))
      .limit(500);
    return filterPersonal(rows, opts);
  }

  function filterPersonal(rows: MemoryEntryRow[], opts: QueryOptions): MemoryEntryRow[] {
    if (!opts.ownerType || !opts.ownerId) {
      return rows.filter((r) => r.layer !== "personal");
    }
    return rows.filter(
      (r) =>
        r.layer !== "personal" ||
        (r.ownerType === opts.ownerType && r.ownerId === opts.ownerId),
    );
  }

  /**
   * pgvector top-k candidate load. Selects ids ordered by cosine distance to the
   * query vector (only rows on the SAME embedding_version — never cross-score
   * two spaces), then hydrates the full drizzle rows for those ids (preserving
   * the distance order). Raw SQL because the `embedding_vec` column is NOT a
   * drizzle column (it is absent on rigs without pgvector).
   */
  async function loadCandidatesByVector(
    companyId: string,
    opts: QueryOptions,
    queryEmbedding: QueryEmbedding,
  ): Promise<MemoryEntryRow[]> {
    const literal = `[${queryEmbedding.vector.join(",")}]`;
    const k = Math.min(Math.max((opts.limit ?? 10) * 5, 50), 500);
    const conds = [
      // Company scope UNION the instance-wide global layer (0054), mirroring the
      // jsonb loadCandidates filter so the ANN path surfaces global rows too.
      sql`(company_id = ${companyId} OR layer = 'global')`,
      sql`status = 'active'`,
      sql`embedding_vec IS NOT NULL`,
      sql`embedding_version = ${queryEmbedding.version}`,
    ];
    if (opts.layers && opts.layers.length > 0) {
      // M2 (mirror of the jsonb loadCandidates fix): OR 'global' back in so a
      // layer restriction on the ANN path never masks the cross-company global
      // layer.
      conds.push(sql`(layer = ANY(${opts.layers}) OR layer = 'global')`);
    }
    if (opts.serviceScope) conds.push(sql`service_scope = ${opts.serviceScope}`);
    if (opts.requireVerified) conds.push(sql`verification_state = 'verified'`);
    if (opts.minConfidence !== undefined) conds.push(sql`confidence >= ${opts.minConfidence}`);
    if (opts.excludeSuperseded !== false) conds.push(sql`superseded_by_id IS NULL`);
    const whereSql = sql.join(conds, sql` AND `);
    const idRows = (await cdb.execute(sql`
      SELECT id FROM ${memoryEntries}
      WHERE ${whereSql}
      ORDER BY embedding_vec <=> ${literal}::vector
      LIMIT ${k}
    `)) as unknown as Array<{ id: string }>;
    const ids = idRows.map((r) => r.id);
    if (ids.length === 0) return [];
    const hydrated = await cdb
      .select()
      .from(memoryEntries)
      .where(inArray(memoryEntries.id, ids));
    const order = new Map(ids.map((id, i) => [id, i]));
    return hydrated.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  function buildSnippet(body: string, query: string): string {
    const tokens = tokenize(query);
    if (tokens.length === 0) return body.slice(0, 200);
    const lowered = body.toLowerCase();
    let best = -1;
    for (const t of tokens) {
      const idx = lowered.indexOf(t);
      if (idx >= 0 && (best < 0 || idx < best)) best = idx;
    }
    const start = best < 0 ? 0 : Math.max(0, best - 60);
    const end = Math.min(body.length, start + 240);
    const slice = body.slice(start, end).trim();
    const prefix = start > 0 ? "…" : "";
    const suffix = end < body.length ? "…" : "";
    return `${prefix}${slice}${suffix}`;
  }

  async function queryRanked(
    companyId: string,
    query: string,
    opts: QueryOptions = {},
  ): Promise<MemoryQueryResult> {
    // PR-11 (§1.1): compute the QUERY embedding FIRST (async, redact-before-embed
    // on the query path too), then load candidates (ANN pushdown when enabled)
    // and pass the precomputed embedding into the PURE/SYNC ranker. The ranker
    // never embeds the query itself, so it stays deterministic for the oracle.
    const queryEmbedding = await embedder.embedQuery(query);
    const candidates = await loadCandidates(companyId, opts, queryEmbedding);
    const ranked = rankEntries(
      query,
      candidates.map((r) => ({
        id: r.id,
        layer: r.layer as MemoryLayer,
        subject: r.subject,
        body: r.body,
        tags: (r.tags as string[]) ?? [],
        embedding: (r.embedding as number[] | null) ?? null,
        embeddingVersion: r.embeddingVersion ?? null,
        lastUsedAt: r.lastUsedAt ?? null,
        updatedAt: r.updatedAt,
      })),
      {},
      queryEmbedding,
    );
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const byId = new Map(candidates.map((r) => [r.id, r]));
    // Recency alone keeps every entry above zero, so require some lexical or
    // semantic signal before the ranker is willing to surface a result. On the
    // REAL-embedding path the cosine signal is meaningful, so we additionally
    // enforce an absolute combined-score floor (mode:'score') that drops
    // recency-only / semantically-orthogonal rows (incl. force-fetched global
    // fixtures); the hash-64 oracle path keeps the byte-identical `signal` test.
    const floor = minRelevanceForVersion(queryEmbedding?.version);
    const signalled = ranked.filter((r) =>
      floor.mode === "score" ? r.score >= floor.floor : r.lexical > 0 || r.semantic > 0.05,
    );
    // ---- §3.6 deterministic conflict resolution ----
    // Group ranked hits by subjectKey; the winner is the highest-precedence
    // provenance (human-answer > pr-approval > verified-summary > agent-claim),
    // ties broken by recency (updatedAt). Losers are dropped from ranked output.
    // Rows with no subjectKey never conflict (each is its own group). subjectKey
    // normalization is conservative (tokenize() only), so paraphrases that key
    // differently are NOT merged — accepted residual duplication, not silent
    // wrong-merges (CENTRAL_CONTEXT_DB_PLAN §3.6 caveat).
    const winnerBySubjectKey = new Map<string, string>();
    for (const r of signalled) {
      const row = byId.get(r.id);
      if (!row || !row.subjectKey) continue;
      const key = row.subjectKey;
      const currentWinnerId = winnerBySubjectKey.get(key);
      if (!currentWinnerId) {
        winnerBySubjectKey.set(key, r.id);
        continue;
      }
      const currentWinner = byId.get(currentWinnerId);
      if (!currentWinner) {
        winnerBySubjectKey.set(key, r.id);
        continue;
      }
      const challengerRank = provenanceRank(row.provenance ?? null);
      const winnerRank = provenanceRank(currentWinner.provenance ?? null);
      if (challengerRank > winnerRank) {
        winnerBySubjectKey.set(key, r.id);
      } else if (
        challengerRank === winnerRank &&
        row.updatedAt.getTime() > currentWinner.updatedAt.getTime()
      ) {
        winnerBySubjectKey.set(key, r.id);
      }
    }
    const deduped = signalled.filter((r) => {
      const row = byId.get(r.id);
      if (!row || !row.subjectKey) return true;
      return winnerBySubjectKey.get(row.subjectKey) === r.id;
    });
    // `deduped` already descends from `signalled`, which the relevance floor
    // applied ABOVE — this slice MUST stay AFTER the floor so the returned count
    // is min(limit, rows-above-floor), never a limit window padded with
    // below-floor rows. Do not hoist the slice above the floor.
    const topIds = deduped.slice(0, limit);
    const layerCounts: Record<MemoryLayer, number> = {
      workspace: 0,
      personal: 0,
      shared: 0,
      global: 0,
    };
    const items = topIds
      .map((r) => {
        const row = byId.get(r.id);
        if (!row) return null;
        layerCounts[row.layer as MemoryLayer]++;
        const item: MemoryManifestItem & { snippet: string } = {
          id: row.id,
          layer: row.layer as MemoryLayer,
          subject: row.subject,
          kind: row.kind as MemoryEntry["kind"],
          tags: (row.tags as string[]) ?? [],
          serviceScope: row.serviceScope ?? null,
          score: Number(r.score.toFixed(4)),
          snippet:
            opts.includeSnippets === false ? "" : buildSnippet(row.body, query),
        };
        return item;
      })
      .filter((x): x is MemoryManifestItem & { snippet: string } => x !== null);
    return { items, layerCounts };
  }

  async function buildManifest(
    companyId: string,
    seed: {
      taskId?: string | null;
      ownerType?: MemoryOwnerType;
      ownerId?: string;
      serviceScope?: string;
      // M5: agent-reachable manifest route threads verified-only retrieval through.
      requireVerified?: boolean;
    },
    limit = 15,
  ): Promise<MemoryManifest> {
    let queryText = "";
    if (seed.taskId) {
      const [task] = await db.select().from(issues).where(eq(issues.id, seed.taskId)).limit(1);
      if (task) {
        queryText = `${task.title}\n${task.description ?? ""}`.slice(0, 1024);
      }
    }
    if (!queryText) queryText = seed.serviceScope ?? "";
    const ranked = await queryRanked(companyId, queryText || "general", {
      ownerType: seed.ownerType,
      ownerId: seed.ownerId,
      serviceScope: seed.serviceScope,
      limit,
      includeSnippets: false,
      requireVerified: seed.requireVerified,
    });
    return {
      taskId: seed.taskId ?? null,
      generatedAt: new Date().toISOString(),
      items: ranked.items.map(({ snippet: _snippet, ...rest }) => rest),
      layerCounts: ranked.layerCounts,
    };
  }

  async function recordUsage(input: {
    entryId: string;
    // NULL for instance-wide global entries (0054): memory_usage.company_id is a
    // NOT NULL uuid, so a company-agnostic global usage skips the per-company
    // usage-event row but still bumps the entry's usageCount/lastUsedAt below.
    companyId: string | null;
    issueId?: string | null;
    actorType: string;
    actorId?: string | null;
    score?: number | null;
  }): Promise<void> {
    if (input.companyId !== null) {
      await cdb.insert(memoryUsage).values({
        entryId: input.entryId,
        companyId: input.companyId,
        issueId: input.issueId ?? null,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        score: input.score ?? null,
      });
    }
    await cdb
      .update(memoryEntries)
      .set({
        usageCount: sql`${memoryEntries.usageCount} + 1`,
        lastUsedAt: new Date(),
      })
      .where(eq(memoryEntries.id, input.entryId));
  }

  /**
   * Layer A — built fresh per task call. Pulls ticket, assignee, and the
   * agent's recent runs. Never persisted: the caller is expected to use this
   * directly and discard.
   */
  async function buildCoreContext(
    companyId: string,
    taskId: string,
  ): Promise<MemoryCoreContext> {
    const [task] = await db.select().from(issues).where(eq(issues.id, taskId)).limit(1);
    if (!task || task.companyId !== companyId) {
      return {
        taskId,
        generatedAt: new Date().toISOString(),
        ticket: null,
        ownership: null,
        recentRuns: [],
        branch: null,
      };
    }
    let ownership: MemoryCoreContext["ownership"] = null;
    if (task.assigneeAgentId) {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, task.assigneeAgentId))
        .limit(1);
      if (agent) {
        ownership = {
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role ?? null,
        };
      }
    }
    const runFilter = task.assigneeAgentId
      ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, task.assigneeAgentId))
      : eq(heartbeatRuns.companyId, companyId);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(runFilter)
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(3);
    return {
      taskId,
      generatedAt: new Date().toISOString(),
      ticket: {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority ?? null,
        assigneeAgentId: task.assigneeAgentId ?? null,
      },
      ownership,
      recentRuns: runs.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt ? r.startedAt.toISOString() : null,
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      })),
      branch: null,
    };
  }

  async function refreshCoreContext(
    companyId: string,
    taskId: string,
  ): Promise<MemoryCoreContext> {
    return buildCoreContext(companyId, taskId);
  }

  // ---------- Promotions ----------

  function promotionRowToType(row: typeof memoryPromotions.$inferSelect): MemoryPromotion {
    return {
      id: row.id,
      companyId: row.companyId,
      sourceEntryId: row.sourceEntryId,
      proposedSubject: row.proposedSubject,
      proposedBody: row.proposedBody,
      proposedTags: (row.proposedTags as string[]) ?? [],
      proposedKind: row.proposedKind as MemoryEntry["kind"],
      proposerType: row.proposerType as MemoryPromotion["proposerType"],
      proposerId: row.proposerId ?? null,
      state: row.state as MemoryPromotion["state"],
      reviewerId: row.reviewerId ?? null,
      reviewNotes: row.reviewNotes ?? null,
      promotedEntryId: row.promotedEntryId ?? null,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    };
  }

  async function proposePromotion(input: {
    companyId: string;
    sourceEntryId: string;
    proposedSubject?: string;
    proposedBody?: string;
    proposedTags?: string[];
    proposedKind?: string;
    proposerType: "system" | "agent" | "user";
    proposerId?: string | null;
  }): Promise<MemoryPromotion | null> {
    const source = await getEntry(input.sourceEntryId);
    if (!source || source.companyId !== input.companyId) return null;
    if (source.layer === "shared") return null;
    const [row] = await cdb
      .insert(memoryPromotions)
      .values({
        companyId: input.companyId,
        sourceEntryId: input.sourceEntryId,
        proposedSubject: input.proposedSubject ?? source.subject,
        proposedBody: input.proposedBody ?? source.body,
        proposedTags: input.proposedTags ?? source.tags,
        proposedKind: input.proposedKind ?? source.kind,
        proposerType: input.proposerType,
        proposerId: input.proposerId ?? null,
      })
      .returning();
    return promotionRowToType(row);
  }

  async function listPromotions(
    companyId: string,
    state?: MemoryPromotion["state"],
  ): Promise<MemoryPromotion[]> {
    const filters = [eq(memoryPromotions.companyId, companyId)];
    if (state) filters.push(eq(memoryPromotions.state, state));
    const rows = await cdb
      .select()
      .from(memoryPromotions)
      .where(and(...filters))
      .orderBy(desc(memoryPromotions.createdAt))
      .limit(200);
    return rows.map(promotionRowToType);
  }

  /**
   * Fetch a single promotion by id (company-agnostic lookup) so a route can read
   * its companyId BEFORE deciding — needed to run assertCompanyAccess + the company
   * pin on the promotion's tenant (the /decide route is keyed only by promotion id).
   */
  async function getPromotion(promotionId: string): Promise<MemoryPromotion | null> {
    const [existing] = await cdb
      .select()
      .from(memoryPromotions)
      .where(eq(memoryPromotions.id, promotionId))
      .limit(1);
    return existing ? promotionRowToType(existing) : null;
  }

  async function decidePromotion(
    promotionId: string,
    input: {
      decision: "approved" | "rejected";
      reviewerId: string;
      reviewNotes?: string | null;
    },
  ): Promise<MemoryPromotion | null> {
    const [existing] = await cdb
      .select()
      .from(memoryPromotions)
      .where(eq(memoryPromotions.id, promotionId))
      .limit(1);
    if (!existing) return null;
    if (existing.state !== "pending") return promotionRowToType(existing);

    // XDBTX-2: the shared-entry insert and the promotion-row update are BOTH
    // context-DB writes — commit them in ONE context transaction so a crash can't
    // leave a shared row with the promotion stuck 'pending' (or vice versa). The
    // embed (network round-trip) is computed BEFORE the txn so no DB locks are held
    // across it; the best-effort vector write runs AFTER commit (it tolerates
    // failure and is content-hash gated, exactly as the createEntry path).
    let prepared: PreparedSharedEntry | null = null;
    if (input.decision === "approved") {
      prepared = await prepareSharedFromPromotion(existing);
    }

    const decided = await cdb.transaction(async (tx) => {
      let promotedEntryId: string | null = null;
      if (prepared) {
        const [inserted] = await tx
          .insert(memoryEntries)
          .values(prepared.values)
          // Idempotent: a replay after a partial earlier attempt collapses to the
          // existing shared row instead of a 23505 crash + permanently stuck promotion.
          .onConflictDoNothing({
            target: [memoryEntries.companyId, memoryEntries.source],
            where: sql`${memoryEntries.source} IS NOT NULL`,
          })
          .returning();
        if (inserted) {
          promotedEntryId = inserted.id;
        } else {
          const [existingShared] = await tx
            .select()
            .from(memoryEntries)
            .where(
              and(
                eq(memoryEntries.companyId, prepared.values.companyId as string),
                eq(memoryEntries.source, prepared.values.source as string),
              ),
            )
            .limit(1);
          promotedEntryId = existingShared?.id ?? null;
        }
      }
      const [row] = await tx
        .update(memoryPromotions)
        .set({
          state: input.decision,
          reviewerId: input.reviewerId,
          reviewNotes: input.reviewNotes ?? null,
          promotedEntryId,
          decidedAt: new Date(),
        })
        .where(eq(memoryPromotions.id, promotionId))
        .returning();
      return { row: row ?? null, promotedEntryId };
    });

    // Best-effort vector write AFTER commit (only when we just created the row).
    if (prepared && decided.promotedEntryId) {
      await writeVectorColumns(decided.promotedEntryId, prepared.storage);
    }
    return decided.row ? promotionRowToType(decided.row) : null;
  }

  type PreparedSharedEntry = {
    values: typeof memoryEntries.$inferInsert;
    storage: { vector: number[]; version: string; model: string; contentHash: string };
  };

  /** Embed + build the shared-entry insert values for an approved promotion.
   * The network embed happens here so the caller can open a short txn afterwards. */
  async function prepareSharedFromPromotion(
    promotion: typeof memoryPromotions.$inferSelect,
  ): Promise<PreparedSharedEntry> {
    // PR-11: redact-before-embed + hash fallback on the promotion path too.
    const embedResult = await embedder.embedForStorage(
      promotion.proposedSubject,
      promotion.proposedBody,
    );
    // Board-promoted lineage is trusted: verified-summary / verified / 0.9.
    // Mirrors the 0049 backfill for pre-existing promotion:% rows. A secret
    // detected in the promoted body still quarantines to needs_review.
    const verificationState: MemoryVerificationState =
      embedResult.redactedFindings.length > 0 ? "needs_review" : "verified";
    return {
      values: {
        companyId: promotion.companyId,
        layer: "shared",
        subject: promotion.proposedSubject,
        body: promotion.proposedBody,
        kind: promotion.proposedKind,
        tags: promotion.proposedTags as string[],
        embedding: embedResult.vector,
        embeddingVersion: embedResult.version,
        source: `promotion:${promotion.id}`,
        provenance: "verified-summary",
        verificationState,
        confidence: 0.9,
        authorType: "system",
        sourceRefType: "promotion",
        sourceRefId: promotion.id,
        subjectKey: computeSubjectKey(promotion.proposedSubject),
      },
      storage: {
        vector: embedResult.vector,
        version: embedResult.version,
        model: embedResult.model,
        contentHash: embedResult.contentHash,
      },
    };
  }

  // ---------- 0054: instance-wide GLOBAL layer promotion ----------

  /**
   * Promote an existing company entry to the instance-wide GLOBAL layer (0054).
   * Instance-admin only — the route gates this via assertInstanceAdmin and threads
   * `isInstanceAdmin: true`. Copies a verified workspace/shared source row into a
   * company-agnostic (company_id = NULL) global entry; the original is left intact.
   * Returns null for an unknown source. Only workspace/shared (verified-tier) rows
   * are promotable — a personal or already-global row is rejected so global stays
   * an org-wide-conventions layer, never a leaked personal/duplicate row.
   */
  async function createGlobalFromEntry(input: {
    sourceEntryId: string;
    isInstanceAdmin: boolean;
    createdBy?: string | null;
  }): Promise<MemoryEntry | null> {
    if (!input.isInstanceAdmin) {
      throw new Error("global entries require an instance admin");
    }
    const source = await getEntry(input.sourceEntryId);
    if (!source) return null;
    if (source.layer !== "workspace" && source.layer !== "shared") {
      throw new Error("only workspace/shared entries can be promoted to global");
    }
    // B1: never launder unverified / superseded content into the cross-company
    // global layer. Mirrors the curated-pin invariant in em-passdown.ts:207 — a
    // promotion can't admit an agent-claim or a conflict-loser into the trust
    // spine. The route maps these Errors to a 400.
    if (source.verificationState !== "verified") {
      throw new Error("only verified entries can be promoted to global");
    }
    if (source.supersededById) {
      throw new Error("cannot promote a superseded entry");
    }
    // M3: global rows carry company_id = NULL, so the (company_id, source) partial
    // unique index never collides (NULLs are distinct in SQL). Probe the dedicated
    // company-agnostic global-source unique index (0057) before insert so promoting
    // the SAME source twice is idempotent — return the existing global row.
    const [existingGlobal] = await cdb
      .select()
      .from(memoryEntries)
      .where(
        and(
          isNull(memoryEntries.companyId),
          eq(memoryEntries.source, `global-promotion:${source.id}`),
        ),
      )
      .limit(1);
    if (existingGlobal) {
      return rowToEntry(existingGlobal);
    }
    // The createEntry write-gate writes the company-agnostic global row (company_id
    // NULL) and re-runs redact-before-embed. Instance-admin lineage is trusted, so
    // it lands verified/verified-summary/0.9 (mirrors the shared promotion stamp),
    // unless a secret in the body re-quarantines it to needs_review.
    return createEntry({
      companyId: null,
      layer: "global",
      isInstanceAdmin: true,
      subject: source.subject,
      body: source.body,
      kind: source.kind,
      tags: source.tags,
      serviceScope: source.serviceScope,
      source: `global-promotion:${source.id}`,
      provenance: "verified-summary",
      verificationState: "verified",
      confidence: 0.9,
      authorType: "system",
      createdBy: input.createdBy ?? null,
    });
  }

  // ---------- PR-14: Capture / Verify / Conflicts ----------

  /**
   * Capture inbox (§3.3): freshly-captured human-tier entries awaiting a human
   * Confirm/Edit/Dismiss. These are the rows the capture hooks stamped with a
   * human-answer / pr-approval provenance. We surface a readable `citation`
   * from the source-ref the hook recorded so the reviewer can trace it back.
   */
  async function captureInbox(companyId: string): Promise<
    Array<{ entry: MemoryEntry; citation: string | null }>
  > {
    const rows = await cdb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, companyId),
          eq(memoryEntries.status, "active"),
          inArray(memoryEntries.provenance, ["human-answer", "pr-approval"]),
          isNull(memoryEntries.supersededById),
          // Captured entries are born verified (verifiedBy is null until a human
          // acts). The inbox shows only the not-yet-human-acknowledged ones; the
          // Confirm action calls verifyEntry, which stamps verifiedBy and drains it.
          isNull(memoryEntries.verifiedBy),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(100);
    return rows.map((row) => {
      const entry = rowToEntry(row);
      return { entry, citation: formatCitation(entry) };
    });
  }

  /**
   * Questions tab (PR-16 §3.1 — the ask-don't-hallucinate loop, made visible).
   * Lists ALL `human-answer` provenance entries (acknowledged or not, unlike the
   * Capture inbox which only shows the not-yet-acknowledged ones) so the loop is
   * fully auditable: the question that was asked → the answer that was captured →
   * the reusable entry it became. The capture hook writes the body as `Q: …\nA: …`
   * (HOOK 1, routes/issues.ts), so we split that back out for display, and surface
   * the source citation + the capture time (`answeredAt`).
   */
  async function questions(companyId: string): Promise<
    Array<{
      entry: MemoryEntry;
      question: string | null;
      answer: string | null;
      citation: string | null;
      answeredAt: string;
      acknowledged: boolean;
    }>
  > {
    const rows = await cdb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, companyId),
          eq(memoryEntries.status, "active"),
          eq(memoryEntries.provenance, "human-answer"),
          isNull(memoryEntries.supersededById),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(200);
    return rows.map((row) => {
      const entry = rowToEntry(row);
      const { question, answer } = splitCapturedQa(entry.body);
      return {
        entry,
        question,
        answer,
        citation: formatCitation(entry),
        answeredAt: entry.createdAt,
        acknowledged: entry.verifiedBy != null,
      };
    });
  }

  /**
   * Verify queue (§3.4 hybrid SLA, decision #3): two streams folded into one
   * list — (a) agent-claim entries with their DISTINCT-issue reuse count (the
   * §3 hybrid reuse signal a board user weighs before verifying), and (b) the
   * pending promotion proposals (decided via the existing decidePromotion).
   */
  async function verifyQueue(companyId: string): Promise<MemoryVerifyItem[]> {
    const claimRows = await cdb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, companyId),
          eq(memoryEntries.status, "active"),
          eq(memoryEntries.provenance, "agent-claim"),
          eq(memoryEntries.verificationState, "unverified"),
          isNull(memoryEntries.supersededById),
        ),
      )
      .orderBy(desc(memoryEntries.usageCount), desc(memoryEntries.updatedAt))
      .limit(100);

    // Distinct-issue reuse per entry, counted from memory_usage. A NULL issueId
    // (usage not tied to an issue) does not contribute to the distinct count.
    const reuseByEntry = new Map<string, number>();
    if (claimRows.length > 0) {
      const reuseRows = (await cdb
        .select({
          entryId: memoryUsage.entryId,
          distinctIssues: sql<number>`count(distinct ${memoryUsage.issueId})`,
        })
        .from(memoryUsage)
        .where(
          and(
            eq(memoryUsage.companyId, companyId),
            inArray(
              memoryUsage.entryId,
              claimRows.map((r) => r.id),
            ),
          ),
        )
        .groupBy(memoryUsage.entryId)) as Array<{ entryId: string; distinctIssues: number }>;
      for (const r of reuseRows) {
        reuseByEntry.set(r.entryId, Number(r.distinctIssues));
      }
    }

    const claimItems: MemoryVerifyItem[] = claimRows.map((row) => ({
      kind: "agent-claim" as const,
      entry: rowToEntry(row),
      distinctIssueReuse: reuseByEntry.get(row.id) ?? 0,
    }));
    const promotions = await listPromotions(companyId, "pending");
    const promotionItems: MemoryVerifyItem[] = promotions.map((promotion) => ({
      kind: "promotion" as const,
      promotion,
    }));
    return [...claimItems, ...promotionItems];
  }

  /**
   * Board verify action (§3.4): stamp an entry verified. assertBoard is enforced
   * at the route — here we only mutate. Mirrors the createSharedFromPromotion
   * trust stamp: verificationState='verified', verifiedBy/verifiedAt set. A
   * needs_review (redaction-quarantined) entry is NOT verifiable through here.
   */
  async function verifyEntry(
    id: string,
    verifiedBy: string,
  ): Promise<MemoryEntry | null> {
    const existing = await getEntry(id);
    if (!existing) return null;
    if (existing.verificationState === "needs_review") {
      throw new Error("needs_review entries must clear redaction before verification");
    }
    const [row] = await cdb
      .update(memoryEntries)
      .set({
        verificationState: "verified",
        verifiedBy,
        verifiedAt: new Date(),
        confidence: Math.max(existing.confidence, 0.7),
        updatedAt: new Date(),
      })
      .where(eq(memoryEntries.id, id))
      .returning();
    return row ? rowToEntry(row) : null;
  }

  /**
   * Redaction queue (§3.6 / §1.4 — the blocking redact-before-embed gate). Lists
   * active, non-superseded `needs_review` entries: the secret-quarantine bucket
   * that was held OUT of retrieval because the body-text scanner found a
   * credential-shape (or a human force-flagged it). Board-only at the route. The
   * body is the raw (already redacted-in-storage) text; the UI masks it by
   * default and only reveals on an explicit, audited board click.
   */
  async function redactionQueue(companyId: string): Promise<MemoryEntry[]> {
    const rows = await cdb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, companyId),
          eq(memoryEntries.status, "active"),
          eq(memoryEntries.verificationState, "needs_review"),
          isNull(memoryEntries.supersededById),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(100);
    return rows.map(rowToEntry);
  }

  /**
   * Resolve a redaction-queue entry (§3.6). Board-only at the route.
   *  - `approve` (approve-as-clean): a human judged the body holds no live
   *    secret → clear the quarantine to `verified`, stamping verifiedBy/At so it
   *    re-enters retrieval. Mirrors the verifyEntry trust stamp.
   *  - `reject` (keep-redacted): the entry stays out of retrieval → archive it
   *    (status='archived'), preserving the row for audit but never re-surfacing.
   * Returns null for an unknown id or an entry not actually in needs_review.
   */
  async function resolveRedaction(
    id: string,
    action: "approve" | "reject",
    resolvedBy: string,
  ): Promise<MemoryEntry | null> {
    const existing = await getEntry(id);
    if (!existing) return null;
    if (existing.verificationState !== "needs_review") return null;
    if (action === "approve") {
      const [row] = await cdb
        .update(memoryEntries)
        .set({
          verificationState: "verified",
          verifiedBy: resolvedBy,
          verifiedAt: new Date(),
          confidence: Math.max(existing.confidence, 0.7),
          updatedAt: new Date(),
        })
        .where(eq(memoryEntries.id, id))
        .returning();
      return row ? rowToEntry(row) : null;
    }
    // reject → keep-redacted: archive so it never re-enters retrieval.
    return archiveEntry(id);
  }

  /**
   * Detected conflicts (§3.5, decision #5 — THE first-class ask). Groups active,
   * non-superseded human-answer entries by subjectKey, keeping only the groups
   * with >1 DISTINCT body (a real disagreement, not an idempotent duplicate).
   * Each group pre-computes `newestByThatUserId` — the newest entry by updatedAt
   * — which the resolver pre-highlights (default-surface, NOT silent newest-wins).
   *
   * Labeled "Detected conflicts" because subjectKey normalization is conservative
   * (tokenize() only) and under-reports paraphrases (CENTRAL_CONTEXT_DB_PLAN §3.6).
   */
  async function listConflicts(companyId: string): Promise<MemoryConflictGroup[]> {
    const rows = await cdb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, companyId),
          eq(memoryEntries.status, "active"),
          eq(memoryEntries.provenance, "human-answer"),
          isNull(memoryEntries.supersededById),
        ),
      )
      .orderBy(desc(memoryEntries.updatedAt));

    const byKey = new Map<string, MemoryEntryRow[]>();
    for (const row of rows) {
      if (!row.subjectKey) continue;
      const list = byKey.get(row.subjectKey) ?? [];
      list.push(row);
      byKey.set(row.subjectKey, list);
    }

    const groups: MemoryConflictGroup[] = [];
    for (const [subjectKey, group] of byKey) {
      const distinctBodies = new Set(group.map((r) => r.body.trim()));
      if (distinctBodies.size < 2) continue; // not a real conflict — duplicate bodies
      const entries = group.map(rowToEntry);
      // Newest by updatedAt (rows already desc-ordered, so [0] is newest).
      const newest = group.reduce((a, b) =>
        b.updatedAt.getTime() > a.updatedAt.getTime() ? b : a,
      );
      groups.push({
        subjectKey,
        subject: newest.subject,
        entries,
        newestByThatUserId: newest.id,
      });
    }
    return groups;
  }

  /**
   * Resolve a detected conflict (§3.5). assertBoard is enforced at the route.
   *  - override: canonicalEntryId wins; every other group member is superseded to it.
   *  - merge: write a BRAND-NEW canonical shared-tier-equivalent workspace entry
   *    from `body`, then supersede ALL originals to it (losers preserved for audit).
   *  - edit: rewrite canonicalEntryId's body to `body`; supersede the rest to it.
   * Returns the canonical (winning) entry, or null if the group/canonical is invalid.
   */
  async function resolveConflict(input: {
    companyId: string;
    subjectKey: string;
    action: "override" | "merge" | "edit";
    canonicalEntryId?: string;
    body?: string;
    resolvedBy: string;
  }): Promise<MemoryEntry | null> {
    // Re-derive the live conflict group so a stale client can't supersede rows
    // outside the group it saw.
    const groupRows = await cdb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, input.companyId),
          eq(memoryEntries.status, "active"),
          eq(memoryEntries.subjectKey, input.subjectKey),
          eq(memoryEntries.provenance, "human-answer"),
          isNull(memoryEntries.supersededById),
        ),
      );
    if (groupRows.length === 0) return null;
    const originalIds = groupRows.map((r) => r.id);
    const sample = groupRows[0];

    if (input.action === "merge") {
      if (!input.body) throw new Error("merge requires a body");
      // Brand-new canonical row carrying the merged body. Human-tier provenance
      // is legitimate here because a board principal authored the merge.
      const embedResult = await embedder.embedForStorage(sample.subject, input.body);
      const verificationState: MemoryVerificationState =
        embedResult.redactedFindings.length > 0 ? "needs_review" : "verified";
      const [canonical] = await cdb
        .insert(memoryEntries)
        .values({
          companyId: input.companyId,
          layer: sample.layer,
          subject: sample.subject,
          body: input.body,
          kind: sample.kind,
          tags: sample.tags as string[],
          serviceScope: sample.serviceScope,
          embedding: embedResult.vector,
          embeddingVersion: embedResult.version,
          provenance: "human-answer",
          verificationState,
          confidence: 0.9,
          authorType: "user",
          authorId: input.resolvedBy,
          subjectKey: input.subjectKey,
          verifiedBy: input.resolvedBy,
          verifiedAt: new Date(),
          createdBy: input.resolvedBy,
        })
        .returning();
      await writeVectorColumns(canonical.id, {
        vector: embedResult.vector,
        version: embedResult.version,
        model: embedResult.model,
        contentHash: embedResult.contentHash,
      });
      // Supersede BOTH (all) originals to the new canonical — preserved for audit.
      await cdb
        .update(memoryEntries)
        .set({ supersededById: canonical.id, updatedAt: new Date() })
        .where(inArray(memoryEntries.id, originalIds));
      return rowToEntry(canonical);
    }

    // override / edit both need a canonical that lives in this group.
    if (!input.canonicalEntryId || !originalIds.includes(input.canonicalEntryId)) {
      throw new Error("canonicalEntryId must be one of the conflicting entries");
    }
    const canonicalId = input.canonicalEntryId;

    if (input.action === "edit") {
      if (!input.body) throw new Error("edit requires a body");
      await updateEntry(canonicalId, { body: input.body });
      // updateEntry re-runs the redact-before-embed scan and may quarantine the
      // entry to needs_review if the new body trips it. Never force-verify over a
      // redaction quarantine — only stamp verified when the edited entry is clean.
      const edited = await getEntry(canonicalId);
      if (edited && edited.verificationState !== "needs_review") {
        await cdb
          .update(memoryEntries)
          .set({
            verificationState: "verified",
            verifiedBy: input.resolvedBy,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(memoryEntries.id, canonicalId));
      }
    }

    // Supersede every OTHER group member to the canonical (losers kept for audit).
    const loserIds = originalIds.filter((id) => id !== canonicalId);
    if (loserIds.length > 0) {
      await cdb
        .update(memoryEntries)
        .set({ supersededById: canonicalId, updatedAt: new Date() })
        .where(inArray(memoryEntries.id, loserIds));
    }
    return getEntry(canonicalId);
  }

  // ---------- Decay ----------

  /**
   * TTL + usage decay pass. Marks entries archived when:
   *   - ttlDays is set and updatedAt is older than ttlDays
   *   - or usageCount === 0 and entry is older than 90 days (cold-start cleanup)
   * Returns the number of entries archived.
   */
  async function runDecayPass(companyId: string, now: Date = new Date()): Promise<number> {
    const COLD_DAYS = 90;
    const rows = await cdb
      .select()
      .from(memoryEntries)
      .where(
        and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.status, "active")),
      )
      .limit(2000);
    const toArchive: string[] = [];
    for (const r of rows) {
      const ageDays = (now.getTime() - r.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (r.ttlDays && ageDays > r.ttlDays) {
        toArchive.push(r.id);
        continue;
      }
      if (r.usageCount === 0 && ageDays > COLD_DAYS) {
        toArchive.push(r.id);
      }
    }
    if (toArchive.length === 0) return 0;
    await cdb
      .update(memoryEntries)
      .set({ status: "archived", updatedAt: now })
      .where(inArray(memoryEntries.id, toArchive));
    return toArchive.length;
  }

  /**
   * Auto-distill: scan workspace/personal entries with usageCount >= threshold
   * and no existing pending promotion, and propose them for the shared layer.
   * Returns the promotions created.
   */
  async function runAutoDistill(
    companyId: string,
    opts: { minUsage?: number; max?: number; proposerId?: string } = {},
  ): Promise<MemoryPromotion[]> {
    const minUsage = opts.minUsage ?? 3;
    const max = Math.min(opts.max ?? 20, 100);
    const candidates = await cdb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, companyId),
          eq(memoryEntries.status, "active"),
          inArray(memoryEntries.layer, ["workspace", "personal"]),
        ),
      )
      .orderBy(desc(memoryEntries.usageCount))
      .limit(max * 4);

    const eligible = candidates.filter((c) => c.usageCount >= minUsage);
    const proposals: MemoryPromotion[] = [];
    for (const c of eligible) {
      if (proposals.length >= max) break;
      const existing = await cdb
        .select()
        .from(memoryPromotions)
        .where(
          and(
            eq(memoryPromotions.sourceEntryId, c.id),
            eq(memoryPromotions.state, "pending"),
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;
      const created = await proposePromotion({
        companyId,
        sourceEntryId: c.id,
        proposerType: "system",
        proposerId: opts.proposerId ?? "auto-distill",
      });
      if (created) proposals.push(created);
    }
    return proposals;
  }

  /**
   * Ops visibility for the embedding stack (ops-cost + correctness-transition
   * critiques §1.9). Read-only — every field maps to a query/signal already on
   * disk. Surfaces, for the operator, whether the corpus is on the current
   * model, how big the re-embed backlog is (so a flipped flag's blackout window
   * is visible), the hash-fallback / truncation telemetry, the redaction
   * quarantine count, and config-vs-reality (HNSW index present? cap/rpm echoes).
   */
  async function embeddingStatus(companyId: string): Promise<EmbeddingStatus> {
    const currentVersion = embedder.version;
    // One pass over active rows: total, current-version coverage, hash count,
    // distinct version breakdown. embedding_version is a real drizzle column.
    const rows = (await cdb.execute(sql`
      SELECT COALESCE(embedding_version, 'null') AS version, COUNT(*)::int AS n
      FROM ${memoryEntries}
      WHERE company_id = ${companyId} AND status = 'active'
      GROUP BY embedding_version
    `)) as unknown as Array<{ version: string; n: number }>;
    let total = 0;
    let onCurrent = 0;
    let hashCount = 0;
    const byVersion: Record<string, number> = {};
    for (const r of rows) {
      const n = Number(r.n) || 0;
      total += n;
      byVersion[r.version] = n;
      if (r.version === currentVersion) onCurrent += n;
      if (r.version === HASH_EMBEDDING_VERSION) hashCount += n;
    }

    // Re-embed backlog = the EXACT (gap-only) predicate reembedBackfill uses,
    // restricted to this company. On a shared corpus the backlog counts only true
    // GAPS (hash-fallback / never-embedded / missing vector) — NOT another machine's
    // real, different-version rows (EMB-2), so the gauge isn't permanently inflated
    // by teammates on a different model. embedding_vec may be absent (no pgvector).
    const hasVec = await hasVectorColumn();
    const backlogPredicate = hasVec
      ? sql`(embedding_version = ${HASH_EMBEDDING_VERSION} OR embedding_version IS NULL OR embedding_vec IS NULL)`
      : sql`(embedding_version = ${HASH_EMBEDDING_VERSION} OR embedding_version IS NULL)`;
    const backlogRows = (await cdb.execute(sql`
      SELECT COUNT(*)::int AS n FROM ${memoryEntries}
      WHERE company_id = ${companyId} AND status = 'active' AND ${backlogPredicate}
    `)) as unknown as Array<{ n: number }>;
    const reembedBacklog = embedder.enabled ? Number(backlogRows[0]?.n ?? 0) : 0;

    // Redaction-blocked = the needs_review quarantine (createEntry forces this
    // when the body scan found+redacted a secret before egress).
    const redactRows = (await cdb.execute(sql`
      SELECT COUNT(*)::int AS n FROM ${memoryEntries}
      WHERE company_id = ${companyId} AND status = 'active'
        AND verification_state = 'needs_review'
    `)) as unknown as Array<{ n: number }>;
    const redactionBlocked = Number(redactRows[0]?.n ?? 0);

    // HNSW index present? config-vs-reality for the "ANN" label (the index is a
    // documented later step; without it the pushdown is brute-force KNN).
    let hnswIndexPresent = false;
    if (hasVec) {
      const idxRows = (await cdb
        .execute(sql`
          SELECT 1 FROM pg_indexes
          WHERE tablename = 'memory_entries' AND indexdef ILIKE '%hnsw%'
          LIMIT 1
        `)
        .catch(() => [] as unknown[])) as unknown as unknown[];
      hnswIndexPresent = idxRows.length > 0;
    }

    const tel = getEmbedderTelemetry();
    const dominant = await corpusDominantVersion();
    return {
      embedderEnabled: embedder.enabled,
      currentVersion,
      activeEntries: total,
      versionCoveragePct: total > 0 ? onCurrent / total : 1,
      hashFallbackPct: total > 0 ? hashCount / total : 0,
      versionBreakdown: byVersion,
      reembedBacklog,
      redactionBlocked,
      hnswIndexPresent,
      pgvectorPresent: hasVec,
      // Process-local telemetry (resets on restart — multi-worker is per-worker).
      queryHashFallbacks: tel.hashFallbacks,
      truncations: tel.truncations,
      // EMB-3: shared-corpus version agreement.
      corpusDominantVersion: dominant,
      corpusVersionMismatch:
        embedder.enabled && dominant != null && dominant !== currentVersion,
    };
  }

  return {
    createEntry,
    getEntry,
    updateEntry,
    archiveEntry,
    listEntries,
    queryRanked,
    buildManifest,
    recordUsage,
    buildCoreContext,
    refreshCoreContext,
    proposePromotion,
    listPromotions,
    getPromotion,
    decidePromotion,
    createGlobalFromEntry,
    captureInbox,
    questions,
    verifyQueue,
    verifyEntry,
    redactionQueue,
    resolveRedaction,
    listConflicts,
    resolveConflict,
    runDecayPass,
    runAutoDistill,
    embeddingStatus,
  };
}

export type MemoryService = ReturnType<typeof memoryService>;
