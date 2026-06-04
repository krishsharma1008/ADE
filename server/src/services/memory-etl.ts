// Central Context DB — PR-7 cutover ETL core (CENTRAL_CONTEXT_DB_PLAN §6.5).
//
// The reusable, DB-touching core for the memory export/import cutover. The
// scripts under server/scripts/memory-export.ts and memory-import.ts are thin
// argv/IO wrappers around the functions here; all of the load-bearing logic
// (byte-for-byte embedding preservation, the trust-column round-trip, the
// idempotency keys, and the refuse-on-empty gate) lives in this module so it is
// unit-testable without spawning a CLI.

import {
  agentMemory,
  createDb,
  memoryEntries,
  memoryPromotions,
  memoryUsage,
  type Db,
} from "@combyne/db";
import { and, eq, sql as dsql } from "drizzle-orm";
import { resolveContextDb } from "./context-db.js";

export const MEMORY_EXPORT_VERSION = 1 as const;

export interface MemoryExportBundle {
  version: number;
  exportedAt: string;
  companyId: string | null;
  counts: {
    memory_entries: number;
    memory_promotions: number;
    memory_usage: number;
    agent_memory: number;
  };
  memory_entries: Record<string, unknown>[];
  memory_promotions: Record<string, unknown>[];
  memory_usage: Record<string, unknown>[];
  agent_memory: Record<string, unknown>[];
}

/**
 * Dump the durable memory tables for a company (or all companies) to an
 * in-memory bundle.
 *
 * Explicitly EXCLUDES transcript_summaries — an unverified, summarizer-generated
 * channel deliberately kept out of the trust spine and the ETL (§3, §6.5).
 *
 * Preservation: drizzle returns the jsonb `embedding` as the parsed number[];
 * JSON.stringify (done by the caller when writing the file) re-emits the same
 * canonical encoding the importer reads back, so the embedding survives
 * byte-for-byte. All 0049 trust columns + embedding_version are carried.
 */
export async function buildExportBundle(
  url: string,
  companyId: string | null,
): Promise<MemoryExportBundle> {
  const db = createDb(url);
  const [entries, promotions, usage, agent] = await Promise.all([
    companyId
      ? db.select().from(memoryEntries).where(eq(memoryEntries.companyId, companyId))
      : db.select().from(memoryEntries),
    companyId
      ? db.select().from(memoryPromotions).where(eq(memoryPromotions.companyId, companyId))
      : db.select().from(memoryPromotions),
    companyId
      ? db.select().from(memoryUsage).where(eq(memoryUsage.companyId, companyId))
      : db.select().from(memoryUsage),
    companyId
      ? db.select().from(agentMemory).where(eq(agentMemory.companyId, companyId))
      : db.select().from(agentMemory),
  ]);
  return {
    version: MEMORY_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    companyId,
    counts: {
      memory_entries: entries.length,
      memory_promotions: promotions.length,
      memory_usage: usage.length,
      agent_memory: agent.length,
    },
    memory_entries: entries as Record<string, unknown>[],
    memory_promotions: promotions as Record<string, unknown>[],
    memory_usage: usage as Record<string, unknown>[],
    agent_memory: agent as Record<string, unknown>[],
  };
}

export interface ImportResult {
  insertedEntries: number;
  skippedEntries: number;
  insertedPromotions: number;
  insertedUsage: number;
  insertedAgentMemory: number;
}

export interface ImportBundle {
  version?: number;
  memory_entries?: Record<string, unknown>[];
  memory_promotions?: Record<string, unknown>[];
  memory_usage?: Record<string, unknown>[];
  agent_memory?: Record<string, unknown>[];
}

/** Thrown when the bundle is empty / has zero entries — the refuse-to-proceed gate. */
export class EmptyExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyExportError";
  }
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v);
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Import a bundle under a target company.
 *
 * Pure of process.exit so it is unit-testable against a test DB handle. Throws
 * EmptyExportError when there is nothing to import (the caller maps that to a
 * non-zero exit). Entries are inserted DIRECTLY (preserving the stored jsonb
 * embedding byte-for-byte and every 0049 trust column) rather than through
 * createEntry — the entries in an export are already human-vetted, so re-running
 * the agent write-gate or recomputing the embedding would be wrong.
 *
 * Idempotency keys (§6.5): memory_entries on (companyId, layer, subject, source).
 */
export async function importBundle(
  db: Db,
  bundle: ImportBundle,
  opts: { companyId: string; ownerRemap: Map<string, string>; dryRun?: boolean },
): Promise<ImportResult> {
  // All memory tables physically live in the context DB when configured.
  const cdb = resolveContextDb(db);
  const entries = asArray(bundle.memory_entries);
  // ---- THE HARD GATE ----
  if (entries.length === 0) {
    throw new EmptyExportError(
      "refuse-to-proceed: the export contains zero memory_entries. " +
        "Refusing to import an empty bundle — this would silently boot an empty central DB " +
        "and lose all dogfooded memory. Verify the export source before retrying.",
    );
  }

  const result: ImportResult = {
    insertedEntries: 0,
    skippedEntries: 0,
    insertedPromotions: 0,
    insertedUsage: 0,
    insertedAgentMemory: 0,
  };

  // The export emits drizzle camelCase keys (companyId, ownerType, …), so the
  // readers below use camelCase to match the bundle exactly. We map old entry
  // ids → new entry ids so promotion / usage FKs re-point.
  const idMap = new Map<string, string>();
  for (const row of entries) {
    const oldId = str(row.id);
    const layer = str(row.layer) ?? "workspace";
    const subject = str(row.subject) ?? "";
    const body = str(row.body) ?? "";
    const source = str(row.source);
    const ownerType = str(row.ownerType);
    let ownerId = str(row.ownerId);
    if (layer === "personal" && ownerId && opts.ownerRemap.has(ownerId)) {
      ownerId = opts.ownerRemap.get(ownerId)!;
    }

    // Dedup probe on the §6.5 natural key. source may be null, so we build the
    // predicate conditionally (NULL = NULL is not true in SQL).
    const dedup = [
      eq(memoryEntries.companyId, opts.companyId),
      eq(memoryEntries.layer, layer),
      eq(memoryEntries.subject, subject),
      source === null
        ? dsql`${memoryEntries.source} IS NULL`
        : eq(memoryEntries.source, source),
    ];
    const [existing] = await cdb
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(and(...dedup))
      .limit(1);
    if (existing) {
      if (oldId) idMap.set(oldId, existing.id);
      result.skippedEntries++;
      continue;
    }

    if (opts.dryRun) {
      result.insertedEntries++;
      continue;
    }

    const [inserted] = await cdb
      .insert(memoryEntries)
      .values({
        companyId: opts.companyId,
        layer,
        ownerType: layer === "personal" ? ownerType : null,
        ownerId: layer === "personal" ? ownerId : null,
        subject,
        body,
        kind: str(row.kind) ?? "fact",
        tags: (Array.isArray(row.tags) ? row.tags : []) as string[],
        serviceScope: str(row.serviceScope),
        source,
        embedding: (row.embedding as number[] | null) ?? null,
        provenance: str(row.provenance),
        verificationState: str(row.verificationState) ?? "unverified",
        confidence: num(row.confidence, 0.5),
        authorType: str(row.authorType),
        authorId: str(row.authorId),
        sourceRefType: str(row.sourceRefType),
        sourceRefId: str(row.sourceRefId),
        subjectKey: str(row.subjectKey),
        // supersededById re-points below once the full id map is built.
        verifiedBy: str(row.verifiedBy),
        verifiedAt: toDate(row.verifiedAt),
        embeddingVersion: str(row.embeddingVersion),
        status: str(row.status) ?? "active",
        usageCount: num(row.usageCount, 0),
        lastUsedAt: toDate(row.lastUsedAt),
        ttlDays: row.ttlDays == null ? null : num(row.ttlDays, 0),
        createdBy: str(row.createdBy),
      })
      .returning({ id: memoryEntries.id });
    if (oldId && inserted) idMap.set(oldId, inserted.id);
    result.insertedEntries++;
  }

  // Re-point supersededById now that every entry id is mapped.
  if (!opts.dryRun) {
    for (const row of entries) {
      const oldId = str(row.id);
      const oldSup = str(row.supersededById);
      if (!oldId || !oldSup) continue;
      const newId = idMap.get(oldId);
      const newSup = idMap.get(oldSup);
      if (newId && newSup) {
        await cdb
          .update(memoryEntries)
          .set({ supersededById: newSup })
          .where(eq(memoryEntries.id, newId));
      }
    }
  }

  if (opts.dryRun) return result;

  // memory_promotions: re-point sourceEntryId; idempotent on (companyId, sourceEntryId, proposedSubject).
  for (const row of asArray(bundle.memory_promotions)) {
    const oldSource = str(row.sourceEntryId);
    const newSource = oldSource ? idMap.get(oldSource) : null;
    if (!newSource) continue; // orphaned promotion (source not imported)
    const proposedSubject = str(row.proposedSubject) ?? "";
    const [exists] = await cdb
      .select({ id: memoryPromotions.id })
      .from(memoryPromotions)
      .where(
        and(
          eq(memoryPromotions.companyId, opts.companyId),
          eq(memoryPromotions.sourceEntryId, newSource),
          eq(memoryPromotions.proposedSubject, proposedSubject),
        ),
      )
      .limit(1);
    if (exists) continue;
    const oldPromoted = str(row.promotedEntryId);
    await cdb.insert(memoryPromotions).values({
      companyId: opts.companyId,
      sourceEntryId: newSource,
      proposedSubject,
      proposedBody: str(row.proposedBody) ?? "",
      proposedTags: (Array.isArray(row.proposedTags) ? row.proposedTags : []) as string[],
      proposedKind: str(row.proposedKind) ?? "fact",
      proposerType: str(row.proposerType) ?? "system",
      proposerId: str(row.proposerId),
      state: str(row.state) ?? "pending",
      reviewerId: str(row.reviewerId),
      reviewNotes: str(row.reviewNotes),
      promotedEntryId: oldPromoted ? idMap.get(oldPromoted) ?? null : null,
      decidedAt: toDate(row.decidedAt),
    });
    result.insertedPromotions++;
  }

  // memory_usage: re-point entryId; idempotent on (entryId, usedAt, actorId).
  for (const row of asArray(bundle.memory_usage)) {
    const oldEntry = str(row.entryId);
    const newEntry = oldEntry ? idMap.get(oldEntry) : null;
    if (!newEntry) continue;
    const usedAt = toDate(row.usedAt);
    const actorId = str(row.actorId);
    const [exists] = await cdb
      .select({ id: memoryUsage.id })
      .from(memoryUsage)
      .where(
        and(
          eq(memoryUsage.entryId, newEntry),
          usedAt ? eq(memoryUsage.usedAt, usedAt) : dsql`${memoryUsage.usedAt} IS NULL`,
          actorId === null
            ? dsql`${memoryUsage.actorId} IS NULL`
            : eq(memoryUsage.actorId, actorId),
        ),
      )
      .limit(1);
    if (exists) continue;
    await cdb.insert(memoryUsage).values({
      entryId: newEntry,
      companyId: opts.companyId,
      issueId: str(row.issueId),
      actorType: str(row.actorType) ?? "system",
      actorId,
      score: row.score == null ? null : num(row.score, 0),
      ...(usedAt ? { usedAt } : {}),
    });
    result.insertedUsage++;
  }

  // agent_memory: idempotent on (companyId, scope, kind, body).
  for (const row of asArray(bundle.agent_memory)) {
    const scope = str(row.scope) ?? "company";
    const kind = str(row.kind) ?? "summary";
    const body = str(row.body) ?? "";
    const [exists] = await cdb
      .select({ id: agentMemory.id })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.companyId, opts.companyId),
          eq(agentMemory.scope, scope),
          eq(agentMemory.kind, kind),
          eq(agentMemory.body, body),
        ),
      )
      .limit(1);
    if (exists) continue;
    await cdb.insert(agentMemory).values({
      companyId: opts.companyId,
      // agentId/issueId/sourceRunId reference rows NOT carried by the ETL —
      // drop the FKs rather than dangle them (they are set-null columns).
      scope,
      kind,
      title: str(row.title),
      body,
      provenance: str(row.provenance),
      authorType: str(row.authorType),
      confidence: num(row.confidence, 0.5),
      verificationState: str(row.verificationState) ?? "unverified",
    });
    result.insertedAgentMemory++;
  }

  return result;
}
