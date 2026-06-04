// Central Context DB — PR-7 cutover ETL: memory IMPORT (thin CLI).
//
// Reads a bundle produced by memory-export.ts and inserts the durable memory
// rows under a TARGET companyId in the destination DB (the self-hosted central
// store). The §6.5 cutover ETL, second half. All the load-bearing logic
// (idempotency, owner remap, byte-for-byte embedding preservation, and the
// refuse-on-empty gate) lives in ../src/services/memory-etl.ts; this file is
// just argv + file IO + exit-code mapping.
//
// HARD SAFETY GATE: the import REFUSES TO PROCEED — non-zero exit, clear
// message — when the bundle is empty or has zero memory_entries. Switching
// DATABASE_URL must never silently boot an empty central DB and quietly discard
// a team's curated knowledge.
//
// Usage:
//   DATABASE_URL=postgres://… node server/scripts/memory-import.ts \
//     --in memory-export.json --company <targetCompanyId> \
//     --owner-remap local-board=<userId>
//   pnpm db:memory-import -- --in memory-export.json --company <id>
//
// Flags:
//   --in <path>            Bundle to import. Required (unless --help).
//   --company <id>         Target companyId. Required (unless --help).
//   --db <url>             Destination connection string. Default: $DATABASE_URL.
//   --owner-remap <a=b>    Rewrite personal owner_id `a` → `b`. Repeatable.
//   --dry-run              Report what would be inserted; write nothing.
//   --help, -h             Print usage and exit 0 (works WITHOUT a DB).

import { readFile } from "node:fs/promises";
import { createDb } from "@combyne/db";
import { EmptyExportError, importBundle, type ImportBundle } from "../src/services/memory-etl.js";

const HELP = `memory-import — load a memory-export bundle into a target company (PR-7 cutover ETL)

Usage:
  DATABASE_URL=postgres://… node server/scripts/memory-import.ts \\
    --in memory-export.json --company <targetCompanyId> [--owner-remap local-board=<userId>]
  pnpm db:memory-import -- --in memory-export.json --company <id>

Flags:
  --in <path>            Bundle to import. Required.
  --company <id>         Target companyId. Required.
  --db <url>             Destination connection string. Default: $DATABASE_URL.
  --owner-remap <a=b>    Rewrite personal owner_id 'a' → 'b'. Repeatable.
  --dry-run              Report what would be inserted; write nothing.
  --help, -h             Print this help and exit (no DB required).

REFUSES TO PROCEED with a non-zero exit when the bundle is empty or has zero
memory_entries — the hard cutover safety gate. Idempotent on re-run
(memory_entries deduped on companyId, layer, subject, source).`;

interface Args {
  in: string | null;
  company: string | null;
  db: string | null;
  ownerRemap: Map<string, string>;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    in: null,
    company: null,
    db: null,
    ownerRemap: new Map(),
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--in") args.in = argv[++i] ?? null;
    else if (flag === "--company") args.company = argv[++i] ?? null;
    else if (flag === "--db") args.db = argv[++i] ?? null;
    else if (flag === "--owner-remap") {
      const pair = argv[++i] ?? "";
      const eqAt = pair.indexOf("=");
      if (eqAt > 0) args.ownerRemap.set(pair.slice(0, eqAt), pair.slice(eqAt + 1));
    } else if (flag === "--dry-run") args.dryRun = true;
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
  if (!args.in) {
    console.error("memory-import: --in <bundle> is required. (Run --help for usage.)");
    return 2;
  }
  if (!args.company) {
    console.error("memory-import: --company <targetCompanyId> is required. (Run --help for usage.)");
    return 2;
  }
  const url = args.db ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "memory-import: no database URL. Set DATABASE_URL or pass --db <url>. (Run --help for usage.)",
    );
    return 2;
  }

  let bundle: ImportBundle;
  try {
    bundle = JSON.parse(await readFile(args.in, "utf8")) as ImportBundle;
  } catch (err) {
    console.error(`memory-import: failed to read/parse ${args.in}: ${(err as Error).message}`);
    return 2;
  }

  const db = createDb(url);
  try {
    const res = await importBundle(db, bundle, {
      companyId: args.company,
      ownerRemap: args.ownerRemap,
      dryRun: args.dryRun,
    });
    console.error(
      `memory-import: ${args.dryRun ? "(dry-run) " : ""}` +
        `entries +${res.insertedEntries} (skipped ${res.skippedEntries}) ` +
        `promotions +${res.insertedPromotions} usage +${res.insertedUsage} ` +
        `agent_memory +${res.insertedAgentMemory}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof EmptyExportError) {
      console.error(`memory-import: ${err.message}`);
      return 3;
    }
    throw err;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error("memory-import failed:", err);
    process.exitCode = 1;
  });
