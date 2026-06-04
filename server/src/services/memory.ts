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

export function cosineSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return 0;
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
  lastUsedAt: Date | null;
  updatedAt: Date;
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
 * Pure function — easy to unit-test without a DB.
 */
export function rankEntries(
  query: string,
  entries: RankInputEntry[],
  weights: { lexical?: number; semantic?: number; recency?: number } = {},
): RankedEntry[] {
  const wLex = weights.lexical ?? 0.5;
  const wSem = weights.semantic ?? 0.35;
  const wRec = weights.recency ?? 0.15;
  const queryEmb = embedText(query);
  return entries
    .map((entry) => {
      const lex = lexicalScore(query, entry.subject, entry.body, entry.tags);
      const sem = cosineSimilarity(queryEmb, entry.embedding);
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

export function memoryService(db: Db) {
  async function createEntry(input: CreateEntryInput): Promise<MemoryEntry> {
    if (input.layer === "shared") {
      throw new Error("shared entries must be created via promotion");
    }
    if (input.layer === "personal" && (!input.ownerType || !input.ownerId)) {
      throw new Error("personal entries require ownerType and ownerId");
    }
    const embedding = embedText(`${input.subject}\n${input.body}`);
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
      const [inserted] = await db
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
      if (inserted) return rowToEntry(inserted);
      const [existing] = await db
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

    const [row] = await db.insert(memoryEntries).values(insertValues).returning();
    return rowToEntry(row);
  }

  async function getEntry(id: string): Promise<MemoryEntry | null> {
    const rows = await db.select().from(memoryEntries).where(eq(memoryEntries.id, id)).limit(1);
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async function updateEntry(id: string, input: UpdateEntryInput): Promise<MemoryEntry | null> {
    const existing = await getEntry(id);
    if (!existing) return null;
    const next = {
      subject: input.subject ?? existing.subject,
      body: input.body ?? existing.body,
    };
    const embedding =
      input.subject !== undefined || input.body !== undefined
        ? embedText(`${next.subject}\n${next.body}`)
        : undefined;
    const updates: Partial<MemoryEntryRow> & { updatedAt: Date } = { updatedAt: new Date() };
    if (input.subject !== undefined) updates.subject = input.subject;
    if (input.body !== undefined) updates.body = input.body;
    if (input.kind !== undefined) updates.kind = input.kind;
    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.serviceScope !== undefined) updates.serviceScope = input.serviceScope;
    if (input.source !== undefined) updates.source = input.source;
    if (input.status !== undefined) updates.status = input.status;
    if (input.ttlDays !== undefined) updates.ttlDays = input.ttlDays;
    if (embedding !== undefined) updates.embedding = embedding;
    if (input.subject !== undefined) updates.subjectKey = computeSubjectKey(input.subject);
    const [row] = await db
      .update(memoryEntries)
      .set(updates)
      .where(eq(memoryEntries.id, id))
      .returning();
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
  }): Promise<MemoryEntry[]> {
    const filters = [eq(memoryEntries.companyId, opts.companyId)];
    if (opts.layer) filters.push(eq(memoryEntries.layer, opts.layer));
    if (opts.ownerType) filters.push(eq(memoryEntries.ownerType, opts.ownerType));
    if (opts.ownerId) filters.push(eq(memoryEntries.ownerId, opts.ownerId));
    filters.push(eq(memoryEntries.status, opts.status ?? "active"));
    const rows = await db
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
    const rows = await db
      .select()
      .from(memoryEntries)
      .where(and(...filters))
      // Deterministic 500-row window: ORDER BY updatedAt desc so the cap drops
      // the oldest rows rather than an arbitrary set (the ORDER BY-into-rank
      // quality fix is a later slice; this only makes the window stable).
      .orderBy(desc(memoryEntries.updatedAt))
      .limit(500);
    if (!opts.ownerType || !opts.ownerId) {
      return rows.filter((r) => r.layer !== "personal");
    }
    return rows.filter(
      (r) =>
        r.layer !== "personal" ||
        (r.ownerType === opts.ownerType && r.ownerId === opts.ownerId),
    );
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
    const candidates = await loadCandidates(companyId, opts);
    const ranked = rankEntries(
      query,
      candidates.map((r) => ({
        id: r.id,
        layer: r.layer as MemoryLayer,
        subject: r.subject,
        body: r.body,
        tags: (r.tags as string[]) ?? [],
        embedding: (r.embedding as number[] | null) ?? null,
        lastUsedAt: r.lastUsedAt ?? null,
        updatedAt: r.updatedAt,
      })),
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
    await db.insert(memoryUsage).values({
      entryId: input.entryId,
      companyId: input.companyId,
      issueId: input.issueId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      score: input.score ?? null,
    });
    await db
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
    const [row] = await db
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
    const rows = await db
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
    const [existing] = await db
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
    const [row] = await db
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
    const embedding = embedText(`${promotion.proposedSubject}\n${promotion.proposedBody}`);
    // Board-promoted lineage is trusted: verified-summary / verified / 0.9.
    // Mirrors the 0049 backfill for pre-existing promotion:% rows.
    const [row] = await db
      .insert(memoryEntries)
      .values({
        companyId: promotion.companyId,
        layer: "shared",
        subject: promotion.proposedSubject,
        body: promotion.proposedBody,
        kind: promotion.proposedKind,
        tags: promotion.proposedTags as string[],
        embedding,
        source: `promotion:${promotion.id}`,
        provenance: "verified-summary",
        verificationState: "verified",
        confidence: 0.9,
        authorType: "system",
        sourceRefType: "promotion",
        sourceRefId: promotion.id,
        subjectKey: computeSubjectKey(promotion.proposedSubject),
      })
      .returning();
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
    const rows = await db
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
    await db
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
    const candidates = await db
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
      const existing = await db
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
  };
}

export type MemoryService = ReturnType<typeof memoryService>;
