// PR-11 — Memory re-embed backfill (MEMORY_UI_AND_QUALITY_PLAN §1.8).
//
// Backfills `embedding_vec` + `embedding_version` for rows that are stale
// (embedding_version != the embedder's current version) or never embedded with
// the model (embedding_vec IS NULL). Runs the SAME redact-before-embed gate as
// the live write path, batches in pages of ~100 with exponential backoff, and
// is idempotent/resumable: re-running only touches rows still off the current
// version, so a crash mid-run resumes cleanly.
//
// TRIGGER POLICY: explicit operator action ONLY. This script is NEVER imported
// or invoked on server boot (cost/rate-limit safety) — it is a standalone CLI.
// All the load-bearing logic lives in reembedBackfill() so it is unit-testable
// against the embedded rig with a mocked/disabled embedder.
//
// ┌─ SAFE ENABLE ORDER (correctness-transition critique — READ THIS) ───────────┐
// │ The embedder's `enabled` flag (COMBYNE_VECTOR_SEARCH_ENABLED + a key) drives │
// │ BOTH this backfill AND the SERVER's live query egress. If you flip the flag  │
// │ on the running server BEFORE the corpus is re-embedded, the live query embeds│
// │ at the API version while every entry still carries 'hash-64:64' — the version│
// │ guard then scores semantic=0 for the whole corpus (jsonb path) or returns 0  │
// │ candidates (pgvector ANN path, now fixed to fall through). Recall silently   │
// │ collapses. So sequence the TWO flags independently:                          │
// │                                                                              │
// │   1. Apply migration 0052 (adds the columns; builds NO index).               │
// │   2. Run THIS script with the flag set IN THE CLI ENV ONLY, while the         │
// │      SERVER process keeps COMBYNE_VECTOR_SEARCH_ENABLED=false:                │
// │        COMBYNE_VECTOR_SEARCH_ENABLED=true COMBYNE_EMBEDDING_API_KEY=sk-… \    │
// │          DATABASE_URL=… pnpm db:memory-reembed                                │
// │   3. Confirm backlog == 0 via GET /companies/:id/memory/embedding-status      │
// │      (reembedBacklog: 0, versionCoveragePct: 1.0) for EVERY company.          │
// │   4. (pgvector only) Build the HNSW index CONCURRENTLY once coverage is 100%. │
// │   5. ONLY NOW flip COMBYNE_VECTOR_SEARCH_ENABLED=true on the SERVER and       │
// │      restart it, so the live query path turns on against a fully migrated     │
// │      corpus.                                                                  │
// └──────────────────────────────────────────────────────────────────────────────┘
//
// Usage:
//   DATABASE_URL=postgres://… COMBYNE_VECTOR_SEARCH_ENABLED=true \
//     COMBYNE_EMBEDDING_API_KEY=sk-… node server/scripts/memory-reembed.ts
//   pnpm db:memory-reembed -- --company <id> --batch 100 --max 5000

import { createDb } from "@combyne/db";
import { reembedBackfill } from "../src/services/memory-reembed.js";
import { getMemoryEmbedder } from "../src/services/memory-embedder.js";

const HELP = `memory-reembed — backfill embedding_vec/embedding_version for stale rows (PR-11)

Usage:
  DATABASE_URL=postgres://… node server/scripts/memory-reembed.ts [flags]
  pnpm db:memory-reembed -- --company <id> --batch 100

Flags:
  --db <url>        Source connection string. Default: $DATABASE_URL.
  --company <id>    Restrict the backfill to a single companyId. Default: all.
  --batch <n>       Rows per page (OpenAI batch limit ~2048; default 100).
  --max <n>         Stop after re-embedding at most <n> rows. Default: unlimited.
  --help, -h        Print this help and exit (no DB required).

Redact-before-embed runs on every row. Idempotent + resumable: only rows whose
embedding_version differs from the embedder's current version (or whose
embedding_vec IS NULL) are re-embedded. NEVER runs on boot — operator-triggered.

Requires the embedder to be ENABLED (COMBYNE_VECTOR_SEARCH_ENABLED=true + a key);
otherwise there is nothing to backfill (hash-64 rows are the local fallback).`;

interface Args {
  db: string | null;
  company: string | null;
  batch: number;
  max: number | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { db: null, company: null, batch: 100, max: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--db") args.db = argv[++i] ?? null;
    else if (flag === "--company") args.company = argv[++i] ?? null;
    else if (flag === "--batch") args.batch = Number(argv[++i]) || 100;
    else if (flag === "--max") args.max = Number(argv[++i]) || null;
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
  // ETL-ROUTE-1: re-embed the SHARED context corpus by default; explicit --db wins.
  const url = args.db ?? process.env.COMBYNE_CONTEXT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "memory-reembed: no database URL. Set COMBYNE_CONTEXT_DATABASE_URL or DATABASE_URL, or pass --db <url>. (Run --help for usage.)",
    );
    return 2;
  }
  const embedder = getMemoryEmbedder();
  if (!embedder.enabled) {
    console.error(
      "memory-reembed: embedder DISABLED (set COMBYNE_VECTOR_SEARCH_ENABLED=true and a key). Nothing to backfill.",
    );
    return 3;
  }
  const db = createDb(url);
  const result = await reembedBackfill(db, embedder, {
    companyId: args.company ?? undefined,
    batchSize: args.batch,
    maxRows: args.max ?? undefined,
    onBatch: (info) =>
      console.error(
        `memory-reembed: batch reembedded=${info.reembedded} skipped=${info.skipped} total=${info.totalReembedded}`,
      ),
  });
  console.error(
    `memory-reembed: done — reembedded=${result.reembedded} scanned=${result.scanned} version=${embedder.version}`,
  );
  return 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error("memory-reembed failed:", err);
    process.exitCode = 1;
  });
