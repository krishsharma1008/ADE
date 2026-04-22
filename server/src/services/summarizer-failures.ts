// Round 3 Phase 6 PR 6.2 — quarantine state for (agent, scope, scopeId) keys.
//
// After 3 consecutive summarizer failures (JSON parse, cost gate, adapter
// error, etc.), stamp the row with `quarantined_until = now() + 24h` so the
// queue stops retrying. Operators can un-quarantine via the UI by clearing
// the row.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { summarizerFailures } from "@combyne/db";

export const QUARANTINE_AFTER_FAILURES = 3;
export const QUARANTINE_DURATION_MS = 24 * 60 * 60 * 1000;

export interface FailureKey {
  agentId: string;
  scopeKind: "standing" | "working";
  scopeId?: string | null;
}

export interface FailureRow {
  agentId: string;
  scopeKind: string;
  scopeId: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  quarantinedUntil: Date | null;
  updatedAt: Date;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function scopeMatch(key: FailureKey) {
  const filters = [
    eq(summarizerFailures.agentId, key.agentId),
    eq(summarizerFailures.scopeKind, key.scopeKind),
  ];
  if (key.scopeId) {
    filters.push(eq(summarizerFailures.scopeId, key.scopeId));
  } else {
    filters.push(isNull(summarizerFailures.scopeId));
  }
  return and(...filters);
}

export async function getFailureRow(db: Db, key: FailureKey): Promise<FailureRow | null> {
  const rows = await db
    .select()
    .from(summarizerFailures)
    .where(scopeMatch(key))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    agentId: r.agentId,
    scopeKind: r.scopeKind,
    scopeId: r.scopeId ?? null,
    consecutiveFailures: r.consecutiveFailures,
    lastError: r.lastError ?? null,
    quarantinedUntil: r.quarantinedUntil ?? null,
    updatedAt: r.updatedAt,
  };
}

export async function isQuarantined(db: Db, key: FailureKey, now: Date = new Date()): Promise<boolean> {
  const row = await getFailureRow(db, key);
  if (!row?.quarantinedUntil) return false;
  return row.quarantinedUntil.getTime() > now.getTime();
}

// Bump the failure counter. Returns the new consecutive-failure count and
// whether quarantine was newly applied this call.
export async function recordFailure(
  db: Db,
  key: FailureKey,
  error: string,
  now: Date = new Date(),
): Promise<{ consecutiveFailures: number; quarantined: boolean }> {
  const existing = await getFailureRow(db, key);
  const nextCount = (existing?.consecutiveFailures ?? 0) + 1;
  const shouldQuarantine = nextCount >= QUARANTINE_AFTER_FAILURES;
  const quarantinedUntil = shouldQuarantine
    ? new Date(now.getTime() + QUARANTINE_DURATION_MS)
    : existing?.quarantinedUntil ?? null;

  if (existing) {
    await db
      .update(summarizerFailures)
      .set({
        consecutiveFailures: nextCount,
        lastError: error.slice(0, 2_000),
        quarantinedUntil,
        updatedAt: now,
      })
      .where(scopeMatch(key));
  } else {
    await db.insert(summarizerFailures).values({
      agentId: key.agentId,
      scopeKind: key.scopeKind,
      scopeId: key.scopeId ?? null,
      consecutiveFailures: nextCount,
      lastError: error.slice(0, 2_000),
      quarantinedUntil,
      updatedAt: now,
    });
  }

  return {
    consecutiveFailures: nextCount,
    quarantined: Boolean(quarantinedUntil && !existing?.quarantinedUntil),
  };
}

// Reset the counter on success. Clears any pending quarantine since we just
// proved the pipeline works again.
export async function recordSuccess(db: Db, key: FailureKey, now: Date = new Date()): Promise<void> {
  const existing = await getFailureRow(db, key);
  if (!existing) return;
  await db
    .update(summarizerFailures)
    .set({
      consecutiveFailures: 0,
      lastError: null,
      quarantinedUntil: null,
      updatedAt: now,
    })
    .where(scopeMatch(key));
}

// Operator override — clears quarantine immediately. Keeps the row so we
// preserve the last-error string for forensic reads.
export async function clearQuarantine(db: Db, key: FailureKey, now: Date = new Date()): Promise<void> {
  await db
    .update(summarizerFailures)
    .set({
      consecutiveFailures: 0,
      quarantinedUntil: null,
      updatedAt: now,
    })
    .where(scopeMatch(key));
}

// Hash function used by the PG advisory lock: splits the 64-bit hash into
// two 32-bit ints. Exported for testing + the queue.
export function advisoryLockKeys(key: FailureKey): { classId: number; objId: number } {
  const keyStr = `summarizer/${key.agentId}/${key.scopeKind}/${key.scopeId ?? ZERO_UUID}`;
  // Keep it simple: two 32-bit hashes derived from a deterministic string.
  // Collisions are harmless — the unique index on transcript_summaries is the
  // real safety net; this lock is only a stampede guard.
  let h1 = 2_166_136_261; // FNV-1a basis
  let h2 = 2_246_822_519;
  for (let i = 0; i < keyStr.length; i++) {
    h1 ^= keyStr.charCodeAt(i);
    h1 = Math.imul(h1, 16_777_619);
    h2 ^= keyStr.charCodeAt(i);
    h2 = Math.imul(h2, 3_266_489_917);
  }
  // `pg_try_advisory_lock(int4, int4)` needs signed 32-bit ints.
  const toSigned32 = (n: number) => (n | 0);
  return { classId: toSigned32(h1), objId: toSigned32(h2) };
}

export async function tryAdvisoryLock(db: Db, key: FailureKey): Promise<boolean> {
  const { classId, objId } = advisoryLockKeys(key);
  const res = await db.execute<{ pg_try_advisory_lock: boolean }>(
    sql`SELECT pg_try_advisory_lock(${classId}, ${objId})`,
  );
  // node-postgres returns rows in `rows`; drizzle's execute passes it through.
  const row = (res as unknown as { rows?: Array<{ pg_try_advisory_lock: boolean }> }).rows?.[0]
    ?? (res as unknown as Array<{ pg_try_advisory_lock: boolean }>)[0];
  return Boolean(row?.pg_try_advisory_lock);
}

export async function releaseAdvisoryLock(db: Db, key: FailureKey): Promise<void> {
  const { classId, objId } = advisoryLockKeys(key);
  await db.execute(sql`SELECT pg_advisory_unlock(${classId}, ${objId})`);
}
