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
 * to a MEMOIZED `createDb(contextUrl)` so a single connection pool is reused
 * across all 7 memory call sites (one pool per URL). Non-memory queries continue
 * to use the main `db` the caller holds.
 */
const poolByUrl = new Map<string, Db>();

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
 */
export function resolveContextDb(mainDb: Db): Db {
  const url = resolveContextDbUrl();
  if (!url) return mainDb;
  let pool = poolByUrl.get(url);
  if (!pool) {
    // createDb already detects pooler URLs (port 6543) and disables prepared
    // statements, so we get the same client behavior as the main db.
    pool = createDb(url);
    poolByUrl.set(url, pool);
  }
  return pool;
}
