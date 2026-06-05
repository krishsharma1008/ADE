// Central Context DB — PR-7 cutover ETL: memory EXPORT (thin CLI).
//
// Dumps the durable memory tables to a single JSON bundle so a team's
// dogfooded knowledge can be carried from the embedded Postgres into the
// self-hosted central DB (CENTRAL_CONTEXT_DB_PLAN §6.5). Switching
// DATABASE_URL today silently boots an EMPTY central DB and loses every
// human-gated entry — this script (paired with memory-import.ts) closes that
// gap. All the load-bearing logic lives in ../src/services/memory-etl.ts; this
// file is just argv + file IO.
//
// Tables dumped: memory_entries, memory_promotions, memory_usage, agent_memory.
// Explicitly NOT dumped: transcript_summaries (an unverified summarizer channel
// excluded from the trust spine and the ETL). The stored jsonb embedding is
// preserved byte-for-byte and all 0049 trust columns + embedding_version carry.
//
// Usage:
//   DATABASE_URL=postgres://… node server/scripts/memory-export.ts --out memory-export.json
//   pnpm db:memory-export -- --out memory-export.json
//
// Flags:
//   --out <path>      Write the bundle to <path>. Default: stdout.
//   --db <url>        Source connection string. Default: $DATABASE_URL.
//   --company <id>    Restrict the dump to a single companyId. Default: all.
//   --help, -h        Print usage and exit 0 (works WITHOUT a DB).

import { writeFile } from "node:fs/promises";
import { buildExportBundle } from "../src/services/memory-etl.js";

const HELP = `memory-export — dump durable memory tables to a JSON bundle (PR-7 cutover ETL)

Usage:
  DATABASE_URL=postgres://… node server/scripts/memory-export.ts [--out <path>]
  pnpm db:memory-export -- --out memory-export.json

Flags:
  --out <path>      Write the bundle to <path>. Default: stdout.
  --db <url>        Source connection string. Default: $DATABASE_URL.
  --company <id>    Restrict the dump to a single companyId. Default: all.
  --help, -h        Print this help and exit (no DB required).

Dumps memory_entries, memory_promotions, memory_usage, agent_memory.
Explicitly EXCLUDES transcript_summaries. The stored jsonb embedding is
preserved byte-for-byte and all 0049 trust columns are carried.`;

interface Args {
  out: string | null;
  db: string | null;
  company: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: null, db: null, company: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--out") args.out = argv[++i] ?? null;
    else if (flag === "--db") args.db = argv[++i] ?? null;
    else if (flag === "--company") args.company = argv[++i] ?? null;
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
  // ETL-ROUTE-1 symmetry: read from the SHARED context DB by default (where the
  // corpus lives), then ops; explicit --db overrides.
  const url = args.db ?? process.env.COMBYNE_CONTEXT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "memory-export: no database URL. Set COMBYNE_CONTEXT_DATABASE_URL or DATABASE_URL, or pass --db <url>. (Run --help for usage.)",
    );
    return 2;
  }
  const bundle = await buildExportBundle(url, args.company);
  const json = JSON.stringify(bundle, null, 2);
  if (args.out) {
    await writeFile(args.out, json, "utf8");
    console.error(
      `memory-export: wrote ${args.out} — entries=${bundle.counts.memory_entries} ` +
        `promotions=${bundle.counts.memory_promotions} usage=${bundle.counts.memory_usage} ` +
        `agent_memory=${bundle.counts.agent_memory}`,
    );
  } else {
    process.stdout.write(json + "\n");
  }
  return 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error("memory-export failed:", err);
    process.exitCode = 1;
  });
