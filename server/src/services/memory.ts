import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
}

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

export interface QueryOptions {
  layers?: MemoryLayer[];
  ownerType?: MemoryOwnerType;
  ownerId?: string;
  serviceScope?: string;
  limit?: number;
  includeSnippets?: boolean;
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
    const [row] = await db
      .insert(memoryEntries)
      .values({
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
        ttlDays: input.ttlDays ?? null,
        createdBy: input.createdBy ?? null,
      })
      .returning();
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
    const rows = await db
      .select()
      .from(memoryEntries)
      .where(and(...filters))
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
    // Recency alone keeps every entry above zero, so require some lexical or
    // semantic signal before the ranker is willing to surface a result.
    const topIds = ranked
      .filter((r) => r.lexical > 0 || r.semantic > 0.05)
      .slice(0, limit);
    const byId = new Map(candidates.map((r) => [r.id, r]));
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
