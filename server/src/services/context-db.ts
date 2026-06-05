import { sql } from "drizzle-orm";
import { createDb, type Db } from "@combyne/db";
import { loadConfig } from "../config.js";

/**
 * Separate dedicated context DB resolution.
 *
 * The memory/context layer can physically live in its own Postgres, selected by
 * `CONTEXT_DATABASE_URL`. When that env is unset (or equal to the main
 * `DATABASE_URL`) we are in single-DB mode and `resolveContextDb` returns the
 * SAME `Db` instance the caller passed in — zero behavior change, the default.
 *
 * When a distinct context URL is configured, every memory-table query is routed
 * to a MEMOIZED `createDb(contextUrl, …)` so a single connection pool is reused
 * across all memory call sites (one pool per URL). Non-memory queries continue
 * to use the main `db` the caller holds.
 */
const poolByUrl = new Map<string, Db>();

/** Per-op deadline (ms) for the REMOTE context pool so a stalled Cloud SQL
 * round-trip can't wedge the heartbeat (invariant I4). Postgres aborts the query
 * server-side; the best-effort retrieval try/catch treats it as a miss. */
const CONTEXT_STATEMENT_TIMEOUT_MS = 5000;

/** The resolved context DB URL, or '' when single-DB mode (main db reused). */
export function resolveContextDbUrl(): string {
  const cfg = loadConfig();
  const url = cfg.contextDatabaseUrl;
  if (!url || url === cfg.databaseUrl) return "";
  return url;
}

/**
 * Return the Db the memory layer should use. Memoized per URL so a single pool
 * is reused. Falls back to `mainDb` (single-DB mode) when no separate context
 * DB is configured.
 *
 * The remote context pool is built with a bounded `statement_timeout` and tighter
 * connect/idle timeouts (see `pgOptions` in @combyne/db) so a slow or dead Cloud
 * SQL connection fails fast instead of stalling the heartbeat loop.
 */
export function resolveContextDb(mainDb: Db): Db {
  const url = resolveContextDbUrl();
  if (!url) return mainDb;
  let pool = poolByUrl.get(url);
  if (!pool) {
    // createDb already (a) detects pooler URLs (port 6543) and disables prepared
    // statements and (b) applies remote SSL + pool/idle/connect tuning for
    // non-loopback hosts. We additionally cap per-statement wall time so a hung
    // context query rejects rather than blocking the heartbeat.
    pool = createDb(url, {
      connection: { statement_timeout: CONTEXT_STATEMENT_TIMEOUT_MS },
    });
    poolByUrl.set(url, pool);
  }
  return pool;
}

/**
 * Run `fn` against the CONTEXT db with the `app.current_company` RLS GUC bound to
 * `companyId` for the duration (transaction-local `set_config(..., true)`, the
 * pgbouncer-safe pattern). This binds the GUC on the SAME physical connection the
 * memory query runs on — which the separate-context-DB topology requires, since
 * the company-scoping GUC must live where `memory_entries` lives, not on the ops
 * connection.
 *
 * - `companyId === null` (company-agnostic / global-layer reads): no GUC is set;
 *   the RLS policy then yields only `company_id IS NULL` rows, which is correct.
 * - Under the current owner connection RLS is dormant (owner bypasses non-forced
 *   RLS), so this is a behavior-preserving no-op TODAY; it makes the eventual
 *   `FORCE ROW LEVEL SECURITY` + non-owner-role flip enforce correctly instead of
 *   fail-closing retrieval to globals.
 */
export async function withContextScope<T>(
  mainDb: Db,
  companyId: string | null,
  fn: (cdb: Db) => Promise<T>,
): Promise<T> {
  const cdb = resolveContextDb(mainDb);
  if (companyId === null) return fn(cdb);
  return cdb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_company', ${companyId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/** Postgres class-08 connection-exception codes + node socket errors that mean
 * "the shared context rail is unreachable", as opposed to a query/logic error. */
const CONTEXT_DB_CONN_ERROR_CODES = new Set([
  // node net / postgres-js socket errors
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  // Postgres class 08 — connection exception
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "08007",
  // Postgres class 57 — operator intervention (shutdown / admin disconnect)
  "57P01",
  "57P02",
  "57P03",
]);

/** True when `err` looks like a context-DB *connectivity* failure (rail down),
 * vs a benign empty result or a query/logic error. Used to escalate logging from
 * debug to warn and to flag the shared-rail health surface. */
export function isContextDbConnectivityError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && CONTEXT_DB_CONN_ERROR_CODES.has(code)) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH|ENETUNREACH|connection (?:closed|ended|refused|terminat)|statement timeout|timed out/i.test(
    msg,
  );
}

export type ContextDbHealth = {
  status: "ok" | "unreachable" | "unknown";
  at: number;
  lastError?: string;
};

let contextDbHealth: ContextDbHealth = { status: "unknown", at: 0 };

/** Record the most recent observed health of the shared context rail so the
 * status route / dashboard can surface "shared rail down" instead of it being
 * buried in debug logs. */
export function recordContextDbHealth(input: { status: "ok" | "unreachable"; error?: string }): void {
  contextDbHealth = { status: input.status, at: Date.now(), lastError: input.error };
}

export function getContextDbHealth(): ContextDbHealth {
  return contextDbHealth;
}
