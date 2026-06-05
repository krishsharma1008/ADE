import { sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { resolveContextDb } from "./context-db.js";

/**
 * The transaction handle passed to a `db.transaction(tx => …)` callback. Derived
 * from the `Db` type so the scoped `tx` exposes the same query builder as `db`.
 */
export type ScopedTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Run `fn` inside a transaction whose `app.current_company` GUC is bound to
 * `companyId`, scoping every memory/context read+write to that company under the
 * Postgres RLS policies authored in migration 0055.
 *
 * WHY a transaction + SET LOCAL semantics: set_config(name, value, is_local=true)
 * sets the GUC for the CURRENT TRANSACTION ONLY — Postgres clears it at COMMIT or
 * ROLLBACK. That is the pgbouncer-safe pattern: when the pooled backend is handed
 * to the next client there is NO leaked scope, so company A's GUC can never bleed
 * into company B's request on a reused connection. A session-level `SET` (is_local
 * = false) would be a cross-tenant leak under transaction/statement pooling.
 *
 * The RLS policy reads this GUC as `current_setting('app.current_company', true)`.
 * Global-layer rows (company_id IS NULL, layer='global') remain visible under any
 * scope because the policy's second arm allows them unconditionally.
 *
 * STATUS: exported and ready for the team-onboarding enforcement flip (which adds
 * the non-owner app role + `FORCE ROW LEVEL SECURITY`). It is NOT yet wired into
 * every request — under the current owner-connected app RLS is dormant (the owner
 * bypasses non-forced RLS), so calling this is a correctness no-op today but
 * exercises the exact code path that will enforce isolation post-flip. Wiring it
 * into the request/service boundary is the documented follow-up refactor.
 */
export async function withCompanyScope<T>(
  db: Db,
  companyId: string,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  // The GUC must be bound on the SAME physical connection the memory query runs
  // on. Under the separate-context-DB topology `memory_entries` lives on the
  // context connection, so scope the transaction there, not on the ops `db`.
  const cdb = resolveContextDb(db);
  return cdb.transaction(async (tx) => {
    // SET LOCAL via set_config(..., true): transaction-scoped, cleared at COMMIT.
    await tx.execute(sql`SELECT set_config('app.current_company', ${companyId}, true)`);
    return fn(tx);
  });
}
