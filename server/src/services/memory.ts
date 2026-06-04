import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
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
} from "@combyne/shared";
import type { MemoryEmbedder, EmbedForStorageResult } from "./memory-embedder.js";
import {
  getMemoryEmbedder,
  getEmbedderTelemetry,
  HASH_EMBEDDING_VERSION,
} from "./memory-embedder.js";
import { resolveContextDb } from "./context-db.js";

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
  // Version guard: if both versions are known and differ, refuse to cross-score.
  if (
    versionA !== undefined &&
    versionA !== null &&
    versionB !== undefined &&
    versionB !== null &&
    versionA !== versionB
  ) {
    return 0;
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
};

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

export interface CreateEntryInput {
  companyId: string;
  layer: MemoryLayer;
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
        .catch(() => {});
    }
  }

  async function createEntry(input: CreateEntryInput): Promise<MemoryEntry> {
    if (input.layer === "shared") {
      throw new Error("shared entries must be created via promotion");
    }
    if (input.layer === "personal" && (!input.ownerType || !input.ownerId)) {
      throw new Error("personal entries require ownerType and ownerId");
    }
    // PR-11: redact-before-embed + hash fallback. Writes the jsonb `embedding`
    // (oracle/fallback) + embedding_version always; the embedding_vec column is
    // written separately (best-effort) only on a real pgvector deployment.
    const embedResult = await embedder.embedForStorage(input.subject, input.body);
    const embedding = embedResult.vector;
    const subjectKey = computeSubjectKey(input.subject);

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
      companyId: input.companyId,
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
            eq(memoryEntries.companyId, input.companyId),
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
    const filters = [eq(memoryEntries.companyId, opts.companyId)];
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
    const filters = [eq(memoryEntries.companyId, companyId), eq(memoryEntries.status, "active")];
    if (opts.layers && opts.layers.length > 0) {
      filters.push(inArray(memoryEntries.layer, opts.layers));
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
      sql`company_id = ${companyId}`,
      sql`status = 'active'`,
      sql`embedding_vec IS NOT NULL`,
      sql`embedding_version = ${queryEmbedding.version}`,
    ];
    if (opts.layers && opts.layers.length > 0) {
      conds.push(sql`layer = ANY(${opts.layers})`);
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
    // semantic signal before the ranker is willing to surface a result.
    const signalled = ranked.filter((r) => r.lexical > 0 || r.semantic > 0.05);
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
    const topIds = deduped.slice(0, limit);
    const layerCounts: Record<MemoryLayer, number> = {
      workspace: 0,
      personal: 0,
      shared: 0,
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
    seed: { taskId?: string | null; ownerType?: MemoryOwnerType; ownerId?: string; serviceScope?: string },
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
    companyId: string;
    issueId?: string | null;
    actorType: string;
    actorId?: string | null;
    score?: number | null;
  }): Promise<void> {
    await cdb.insert(memoryUsage).values({
      entryId: input.entryId,
      companyId: input.companyId,
      issueId: input.issueId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      score: input.score ?? null,
    });
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

    let promotedEntryId: string | null = null;
    if (input.decision === "approved") {
      const promoted = await createSharedFromPromotion(existing);
      promotedEntryId = promoted.id;
    }
    const [row] = await cdb
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
    return row ? promotionRowToType(row) : null;
  }

  async function createSharedFromPromotion(
    promotion: typeof memoryPromotions.$inferSelect,
  ): Promise<MemoryEntry> {
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
    const [row] = await cdb
      .insert(memoryEntries)
      .values({
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
      })
      .returning();
    await writeVectorColumns(row.id, {
      vector: embedResult.vector,
      version: embedResult.version,
      model: embedResult.model,
      contentHash: embedResult.contentHash,
    });
    return rowToEntry(row);
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

    // Re-embed backlog = the EXACT predicate reembedBackfill uses, restricted to
    // this company. embedding_vec may be absent (no pgvector), so guard it.
    const hasVec = await hasVectorColumn();
    const backlogPredicate = hasVec
      ? sql`(embedding_version IS DISTINCT FROM ${currentVersion} OR embedding_vec IS NULL)`
      : sql`embedding_version IS DISTINCT FROM ${currentVersion}`;
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
    decidePromotion,
    runDecayPass,
    runAutoDistill,
    embeddingStatus,
  };
}

export type MemoryService = ReturnType<typeof memoryService>;
