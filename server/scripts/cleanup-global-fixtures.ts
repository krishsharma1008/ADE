// Phase 4 — Global eval-fixture cleanup (IMPROVEMENT_PLAN §Phase 4).
//
// The embedding-eval fixtures (EVAL_ENTRIES + the code-style EVAL_CODE_SUBJECTS)
// were at some point seeded into the GLOBAL memory layer and now pollute board
// retrieval: an agent asking a real question can surface "Kafka topic naming
// convention" or "Logging convention (Java services)" as if they were captured
// company knowledge. This script reversibly removes exactly those leftover rows.
//
// SAFETY MODEL (read before running):
//   - DRY-RUN by DEFAULT. Nothing is written unless `--apply` is passed.
//   - The match predicate is built ONLY from declared drizzle columns
//     (companyId/layer/status/subject/source). It NEVER references the pgvector
//     `embedding_vec` column — that column is conditional (see the `vector`
//     customType doc in memory_layers.ts) and a `SELECT … embedding_vec …` would
//     THROW on a deployment / rig without pgvector.
//   - The allowlist is IMPORTED from the fixture source of truth (EVAL_ENTRIES ∪
//     EVAL_CODE_SUBJECTS), never hardcoded, so it can never drift from the
//     fixtures. It must total FIXTURE_SUBJECT_COUNT (30).
//   - We scope to GLOBAL only: companyId IS NULL AND layer='global'. A
//     workspace/personal/shared row (real company_id) with a colliding subject is
//     NEVER matched.
//   - We exclude human-governed promotions: a row whose source was set by the
//     global-promotion pipeline (`global-promotion:…`) is left alone. The
//     `(source IS NULL OR source NOT LIKE 'global-promotion:%')` form is REQUIRED;
//     a bare `NOT LIKE` would silently skip NULL-source rows (SQL NULL semantics)
//     and thus MISS the fixtures we are trying to delete.
//   - select + delete run inside ONE transaction and we assert
//     deleteCount === previewCount, rolling back on any mismatch.
//   - `--apply` is refused if any matched subject is outside the allowlist or the
//     match count exceeds MAX_APPLY_ROWS (50) — a blast-radius backstop.
//
// Rollback: pass `--export <path>` to dump the matched rows to a JSON bundle
// BEFORE the delete, then restore with `pnpm db:memory-import --in <path>`.
//
// Usage:
//   DATABASE_URL=postgres://… node server/scripts/cleanup-global-fixtures.ts          # dry-run
//   pnpm db:cleanup-global-fixtures -- --export bundle.json --apply                    # delete
//
// Flags:
//   --db <url>        Source connection string. Default:
//                     $COMBYNE_CONTEXT_DATABASE_URL ?? $DATABASE_URL.
//   --dry-run         Preview only; write nothing. DEFAULT (true). --apply overrides.
//   --apply           Actually delete the matched rows (otherwise dry-run).
//   --export <path>   Write the matched rows to a JSON file BEFORE deleting.
//   --help, -h        Print this help and exit (no DB required).

import { writeFile } from "node:fs/promises";
import { and, eq, inArray, isNull, notLike, or, type SQL } from "drizzle-orm";
import { createDb, memoryEntries, type Db } from "@combyne/db";
import { EVAL_ENTRIES } from "../src/services/embedding-eval-fixture.js";
import { EVAL_CODE_SUBJECTS } from "./embedding-eval-code.js";

/**
 * The fixture-subject allowlist, derived from the SINGLE source of truth: the
 * shared eval fixture (EVAL_ENTRIES) plus the code-style eval fixture
 * (EVAL_CODE_SUBJECTS). Never hardcoded — adding/removing a fixture entry keeps
 * this in lockstep. The cleanup deletes ONLY global rows whose subject is in here.
 */
export const FIXTURE_SUBJECT_ALLOWLIST: readonly string[] = [
  ...EVAL_ENTRIES.map((e) => e.subject),
  ...EVAL_CODE_SUBJECTS,
];

/** Expected size of the fixture allowlist (14 EVAL_ENTRIES + 16 EVAL_CODE_SUBJECTS). */
export const FIXTURE_SUBJECT_COUNT = FIXTURE_SUBJECT_ALLOWLIST.length;

/** Hard cap on how many rows `--apply` will delete in one run (blast-radius backstop). */
export const MAX_APPLY_ROWS = 50;

/**
 * The match predicate over DECLARED drizzle columns only (never embedding_vec):
 *
 *   companyId IS NULL                       -- instance-wide global, not company-owned
 *   AND layer = 'global'                    -- only the global layer
 *   AND status = 'active'                   -- leave archived/deprecated alone
 *   AND subject IN (allowlist)              -- only the known fixture subjects
 *   AND (source IS NULL OR source NOT LIKE 'global-promotion:%')
 *                                           -- never touch human-governed promotions;
 *                                           -- the IS-NULL arm is required so NULL-source
 *                                           -- fixture rows are still matched.
 */
export function buildFixtureCleanupFilter(
  allowlist: readonly string[] = FIXTURE_SUBJECT_ALLOWLIST,
): SQL {
  return and(
    isNull(memoryEntries.companyId),
    eq(memoryEntries.layer, "global"),
    eq(memoryEntries.status, "active"),
    inArray(memoryEntries.subject, [...allowlist]),
    or(
      isNull(memoryEntries.source),
      notLike(memoryEntries.source, "global-promotion:%"),
    ),
  )!;
}

/** A matched fixture row (declared columns only — never embedding_vec). */
export type FixtureRow = typeof memoryEntries.$inferSelect;

/**
 * Read (preview) the global fixture rows that match the cleanup predicate.
 * Pure read; writes nothing. `db.select().from(memoryEntries)` is safe because
 * the schema intentionally does NOT declare embedding_vec as a column.
 */
export async function selectFixtureRows(
  db: Db,
  allowlist: readonly string[] = FIXTURE_SUBJECT_ALLOWLIST,
): Promise<FixtureRow[]> {
  return db.select().from(memoryEntries).where(buildFixtureCleanupFilter(allowlist));
}

export interface DeleteFixtureResult {
  previewed: number;
  deleted: number;
  rows: FixtureRow[];
}

/**
 * Delete the matched global fixture rows inside ONE transaction, asserting that
 * the number of rows deleted equals the number previewed in the same transaction
 * (any drift rolls the whole thing back). Returns the previewed rows (for an
 * export bundle) plus the counts.
 */
export async function deleteFixtureRows(
  db: Db,
  allowlist: readonly string[] = FIXTURE_SUBJECT_ALLOWLIST,
): Promise<DeleteFixtureResult> {
  const filter = buildFixtureCleanupFilter(allowlist);
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(memoryEntries).where(filter);
    const previewed = rows.length;
    const deleted = await tx.delete(memoryEntries).where(filter).returning({ id: memoryEntries.id });
    if (deleted.length !== previewed) {
      // Should be impossible inside a single transaction, but if the counts ever
      // disagree we abort rather than delete an unverified set.
      throw new Error(
        `cleanup-global-fixtures: delete/preview mismatch (previewed=${previewed} deleted=${deleted.length}); rolled back`,
      );
    }
    return { previewed, deleted: deleted.length, rows };
  });
}

// ───────────────────────────── CLI ─────────────────────────────

const HELP = `cleanup-global-fixtures — reversibly remove leftover embedding-eval rows from the GLOBAL layer

Usage:
  DATABASE_URL=postgres://… node server/scripts/cleanup-global-fixtures.ts [flags]   # dry-run
  pnpm db:cleanup-global-fixtures -- --export bundle.json --apply                     # delete

Flags:
  --db <url>        Source connection string. Default: $COMBYNE_CONTEXT_DATABASE_URL ?? $DATABASE_URL.
  --dry-run         Preview only; write nothing. DEFAULT. (--apply overrides.)
  --apply           Actually delete the matched rows.
  --export <path>   Write the matched rows to a JSON file BEFORE deleting.
  --help, -h        Print this help and exit (no DB required).

DRY-RUN by default — prints the matched rows + count and writes nothing. The match
predicate uses declared columns only (companyId/layer/status/subject/source), never
embedding_vec. Only GLOBAL (companyId IS NULL, layer='global', status='active') rows
whose subject is in the imported fixture allowlist and that were NOT created by the
global-promotion pipeline are matched. select + delete run in one transaction and
deleted===previewed is asserted. --apply is refused if any matched subject is outside
the allowlist or the match count exceeds ${MAX_APPLY_ROWS}.

Rollback: --export <path> then  pnpm db:memory-import -- --in <path>`;

interface Args {
  db: string | null;
  apply: boolean;
  export: string | null;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { db: null, apply: false, export: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--db") args.db = argv[++i] ?? null;
    else if (flag === "--apply") args.apply = true;
    // --dry-run is the default; accept it explicitly as a documented no-op.
    else if (flag === "--dry-run") args.apply = false;
    else if (flag === "--export") args.export = argv[++i] ?? null;
    else if (flag === "--help" || flag === "-h") args.help = true;
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  // Defense in depth: assert the imported allowlist is exactly the fixtures.
  if (FIXTURE_SUBJECT_COUNT !== 30) {
    console.error(
      `cleanup-global-fixtures: allowlist size is ${FIXTURE_SUBJECT_COUNT}, expected 30 ` +
        `(EVAL_ENTRIES ∪ EVAL_CODE_SUBJECTS drifted). Refusing to run.`,
    );
    return 5;
  }

  // ETL-ROUTE-1 symmetry (matches memory-reembed/export): operate on the SHARED
  // context DB by default; explicit --db wins.
  const url = args.db ?? process.env.COMBYNE_CONTEXT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "cleanup-global-fixtures: no database URL. Set COMBYNE_CONTEXT_DATABASE_URL or DATABASE_URL, or pass --db <url>. (Run --help for usage.)",
    );
    return 2;
  }

  const db = createDb(url);
  const rows = await selectFixtureRows(db);
  const allowed = new Set(FIXTURE_SUBJECT_ALLOWLIST);

  console.error(`cleanup-global-fixtures: matched ${rows.length} global fixture row(s):`);
  for (const r of rows) {
    console.error(`  [${r.id}] layer=${r.layer} status=${r.status} source=${r.source ?? "∅"}  ${r.subject}`);
  }

  // Export BEFORE any delete so a rollback bundle exists even if --apply later refuses.
  if (args.export) {
    await writeFile(args.export, JSON.stringify(rows, null, 2), "utf8");
    console.error(`cleanup-global-fixtures: wrote ${rows.length} matched row(s) to ${args.export}`);
  }

  if (!args.apply) {
    console.error(
      `cleanup-global-fixtures: DRY-RUN — wrote nothing. Re-run with --apply (and --export <path> for a rollback bundle) to delete.`,
    );
    return 0;
  }

  // --apply safety gates.
  const offAllowlist = rows.filter((r) => !allowed.has(r.subject));
  if (offAllowlist.length > 0) {
    console.error(
      `cleanup-global-fixtures: refusing --apply — ${offAllowlist.length} matched row(s) have a subject outside the fixture allowlist.`,
    );
    return 4;
  }
  if (rows.length > MAX_APPLY_ROWS) {
    console.error(
      `cleanup-global-fixtures: refusing --apply — matched ${rows.length} rows exceeds the safety cap of ${MAX_APPLY_ROWS}.`,
    );
    return 4;
  }

  const result = await deleteFixtureRows(db);
  console.error(
    `cleanup-global-fixtures: done — deleted=${result.deleted} previewed=${result.previewed}` +
      (args.export ? ` (rollback bundle: ${args.export})` : ""),
  );
  return 0;
}

// Only run the CLI when executed directly; importing this module (the test +
// any future caller of the exported helpers) must be a no-op.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err) => {
      console.error("cleanup-global-fixtures failed:", err);
      process.exitCode = 1;
    });
}
