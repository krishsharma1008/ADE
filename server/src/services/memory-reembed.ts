// PR-11 — Re-embed backfill core (MEMORY_UI_AND_QUALITY_PLAN §1.8).
//
// Selects rows that are off the embedder's current version (or never got a
// vector) and re-embeds them through the SAME redact-before-embed gate as the
// live write path, writing embedding_vec + embedding_version + content_hash.
//
// Idempotent + resumable: the selection predicate is `embedding_version !=
// <current> OR embedding_vec IS NULL`, so a completed row falls out of the set
// and a re-run (after a crash) picks up exactly where it left off. Pages by id
// with exponential backoff on a failed batch. NEVER auto-runs — only the
// operator-triggered CLI (scripts/memory-reembed.ts) calls this.

import { sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { memoryEntries } from "@combyne/db";
import type { MemoryEmbedder } from "./memory-embedder.js";
import { HASH_EMBEDDING_VERSION } from "./memory-embedder.js";

export interface ReembedOptions {
  companyId?: string;
  batchSize?: number;
  maxRows?: number;
  /** Test seam: override the backoff sleeper (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  onBatch?: (info: { reembedded: number; skipped: number; totalReembedded: number }) => void;
}

export interface ReembedResult {
  scanned: number;
  reembedded: number;
}

const DEFAULT_BATCH = 100;
const MAX_RETRIES = 4;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when memory_entries.embedding_vec exists (real pgvector deployment). */
async function columnPresent(db: Db): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'memory_entries'
      AND column_name = 'embedding_vec'
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

interface StaleRow {
  id: string;
  subject: string;
  body: string;
}

export async function reembedBackfill(
  db: Db,
  embedder: MemoryEmbedder,
  opts: ReembedOptions = {},
): Promise<ReembedResult> {
  // Nothing to backfill on the hash-64 path; the local fallback is the oracle.
  if (!embedder.enabled) return { scanned: 0, reembedded: 0 };

  // ETL-ROUTE-1: honor the destination handle the caller passed (the CLI now
  // defaults it to the context DB). A non-CLI caller that wants the shared rail
  // passes resolveContextDb(db) explicitly — we do NOT override here.
  const cdb = db;
  const batchSize = Math.min(Math.max(opts.batchSize ?? DEFAULT_BATCH, 1), 2048);
  const sleep = opts.sleep ?? defaultSleep;
  const current = embedder.version;
  let scanned = 0;
  let reembedded = 0;

  // Detect whether the pgvector `embedding_vec` column exists. On a real
  // pgvector deployment it does (migration 0052 created it); on a rig without
  // pgvector it does not. The selection predicate and the UPDATE adapt so the
  // backfill is correct in both worlds (the jsonb embedding + version are always
  // updated; the vector column only when present).
  const hasVectorColumn = await columnPresent(cdb);

  // Resumable cursor: page by id ascending. Because re-embedded rows leave the
  // stale set, we keep selecting "the next stale page" until empty — but we also
  // advance a lastId cursor so a row that legitimately can't move (e.g. an embed
  // that keeps falling back to hash) does not wedge the loop forever.
  let lastId = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    if (opts.maxRows !== undefined && reembedded >= opts.maxRows) break;

    // EMB-2: on a SHARED corpus, fill GAPS only — never overwrite another
    // machine's already-real, different-version vector. A "gap" is a hash-fallback
    // row or a never-embedded row. This makes the backfill idempotent across
    // divergent machines (each row gets a real vector at most once, from whichever
    // machine first fills it), eliminating version ping-pong / double-spend. A row
    // left on a foreign version is simply skipped by the cross-version cosine guard
    // on the read path (lexical fallback) — acceptable and already the read behavior.
    const staleCond = hasVectorColumn
      ? sql`(embedding_version = ${HASH_EMBEDDING_VERSION} OR embedding_version IS NULL OR embedding_vec IS NULL)`
      : sql`(embedding_version = ${HASH_EMBEDDING_VERSION} OR embedding_version IS NULL)`;
    const conds = [staleCond, sql`status = 'active'`, sql`id > ${lastId}`];
    if (opts.companyId) conds.push(sql`company_id = ${opts.companyId}`);
    const whereSql = sql.join(conds, sql` AND `);
    const page = (await cdb.execute(sql`
      SELECT id, subject, body FROM ${memoryEntries}
      WHERE ${whereSql}
      ORDER BY id ASC
      LIMIT ${batchSize}
    `)) as unknown as StaleRow[];

    if (page.length === 0) break;
    scanned += page.length;

    let batchReembedded = 0;
    let batchSkipped = 0;
    for (const row of page) {
      lastId = row.id;
      if (opts.maxRows !== undefined && reembedded >= opts.maxRows) break;

      // embedForStorage runs redact-before-embed + the content-hash cache, and
      // returns the hash fallback on any embedder error (it never throws). We
      // only write the vector when a REAL embed succeeded (version != hash).
      let result = await embedder.embedForStorage(row.subject, row.body);
      // Exponential backoff retry on the hash fallback (transient 429/5xx).
      for (let attempt = 1; attempt <= MAX_RETRIES && result.version === "hash-64:64"; attempt++) {
        await sleep(2 ** attempt * 100);
        result = await embedder.embedForStorage(row.subject, row.body);
      }
      if (result.version === "hash-64:64") {
        batchSkipped++;
        continue;
      }
      // Always update the jsonb embedding (oracle/fallback) + version + bookkeeping.
      await cdb.execute(sql`
        UPDATE ${memoryEntries}
        SET embedding = ${JSON.stringify(result.vector)}::jsonb,
            embedding_version = ${result.version},
            embedding_model = ${result.model},
            embedding_dim = ${result.vector.length},
            content_hash = ${result.contentHash}
        WHERE id = ${row.id}
      `);
      // The vector column only when it exists (real pgvector deployment).
      if (hasVectorColumn) {
        const literal = `[${result.vector.join(",")}]`;
        await cdb
          .execute(sql`UPDATE ${memoryEntries} SET embedding_vec = ${literal}::vector WHERE id = ${row.id}`)
          .catch(() => {});
      }
      reembedded++;
      batchReembedded++;
    }

    opts.onBatch?.({
      reembedded: batchReembedded,
      skipped: batchSkipped,
      totalReembedded: reembedded,
    });

    // If a whole page made no forward progress (all hash fallbacks), the lastId
    // cursor still advanced past them, so the next iteration loads new rows — no
    // infinite loop. A short page means we reached the tail.
    if (page.length < batchSize) break;
  }

  return { scanned, reembedded };
}
