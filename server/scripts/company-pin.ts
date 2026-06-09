// Central Context DB — Phase B (company-pin adoption glue).
//
// `companies.id` is `defaultRandom()`, so every teammate who boots a local ops DB
// gets a DIFFERENT company UUID. The shared context rail, however, is addressed by
// ONE canonical company id (the team's `COMBYNE_CONTEXT_COMPANY_ID` pin). Without a
// way to adopt that id locally, each machine's `:companyId` diverges and the
// pin-enforcement fence (routes/memory.ts → assertPinnedCompany) would 403 every
// local request — or, worse, address the wrong tenant.
//
// This script ensures the local `companies` row exists at an EXPLICIT id so the
// local company id equals the shared pinned UUID. Run it once per machine after the
// team agrees on the canonical UUID:
//
//   pnpm db:company-pin --id <uuid> --name "<company name>"
//
// The company row lives in the OPS DB (DATABASE_URL), not the context DB — only
// the memory/context tables live remotely. So this targets DATABASE_URL, and when
// DATABASE_URL is unset it targets the DEFAULT EMBEDDED ops Postgres (the standard
// local-first setup). NOTE: the embedded DB's lifecycle is owned by the app, not this
// script — have `pnpm dev` (or `pnpm start`) running so it is up, or pass --db <url>.
// If it isn't reachable, the script exits with an actionable message (not a raw error).
//
// Flags:
//   --id <uuid>       The canonical company UUID to adopt (the shared pin). Required.
//   --name <name>     Company name. Used on INSERT ONLY. Required.
//   --db <url>        Ops connection string. Default: $DATABASE_URL, else embedded.
//   --force-rename    Overwrite an existing pinned row's name with --name (logged).
//   --help, -h        Print usage and exit 0 (works WITHOUT a DB).

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@combyne/db";
import { adoptPinnedCompany, type AdoptResult } from "../src/services/company-pin-adopt.js";

// The idempotent, prefix-safe, no-clobber upsert lives under `src` so it can be
// shared with server runtime code (the onboarding "join an existing team" route);
// re-exported here so existing importers (tests, CLI) keep their import path.
export { adoptPinnedCompany, type AdoptResult };

const HELP = `company-pin — adopt the team's canonical company UUID locally (Phase B)

Usage:
  DATABASE_URL=postgres://… node server/scripts/company-pin.ts --id <uuid> --name "<name>"
  pnpm db:company-pin -- --id <uuid> --name "Acme"

Flags:
  --id <uuid>       The canonical company UUID to adopt (the shared pin). Required.
  --name <name>     Company name. Used on INSERT only. Required.
  --db <url>        Ops connection string. Default: $DATABASE_URL, else the embedded
                    local Postgres (postgres://combyne:combyne@127.0.0.1:<port>/combyne).
                    NOTE: the embedded DB is started by the app, not this script — have
                    \`pnpm dev\` running (or pass --db <url>) so it is reachable.
  --force-rename    Overwrite an EXISTING pinned row's name with --name (logged old->new).
                    Without it, a re-run with a different --name is a no-op (never
                    silently renames a live tenant).
  --help, -h        Print this help and exit (no DB required).

Ensures the local companies row exists at id=<uuid> so this machine's company id
matches the shared pinned UUID (COMBYNE_CONTEXT_COMPANY_ID). Targets the OPS DB,
where the company row lives — the memory/context tables live in the context DB.`;

interface Args {
  id: string | null;
  name: string | null;
  db: string | null;
  forceRename: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { id: null, name: null, db: null, forceRename: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--id") args.id = argv[++i] ?? null;
    else if (flag === "--name") args.name = argv[++i] ?? null;
    else if (flag === "--db") args.db = argv[++i] ?? null;
    else if (flag === "--force-rename") args.forceRename = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
  }
  return args;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Embedded-ops-DB connection resolution (mirrors packages/db/backup.ts) ----
// So the script works in the DEFAULT local-first setup (DATABASE_URL unset): env
// wins, then a config.json postgres connectionString, then the embedded default.

type PartialConfig = {
  database?: { mode?: string; connectionString?: string; embeddedPostgresPort?: number };
};

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function resolveConfigPath(): string {
  const envHome = process.env.COMBYNE_HOME?.trim();
  const home = envHome ? path.resolve(expandHomePrefix(envHome)) : path.resolve(os.homedir(), ".combyne");
  const instance = process.env.COMBYNE_INSTANCE_ID?.trim() || "default";
  return path.resolve(home, "instances", instance, "config.json");
}

function readPartialConfig(): PartialConfig | null {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof parsed === "object" && parsed ? (parsed as PartialConfig) : null;
  } catch {
    return null;
  }
}

function resolveEmbeddedPort(config: PartialConfig | null): number {
  const envPort = Number(process.env.COMBYNE_EMBEDDED_POSTGRES_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return Math.trunc(envPort);
  const cfgPort = config?.database?.embeddedPostgresPort;
  if (typeof cfgPort === "number" && Number.isFinite(cfgPort) && cfgPort > 0) return Math.trunc(cfgPort);
  return 54329;
}

/** Resolve the OPS connection string: --db > $DATABASE_URL > config.json pg > embedded. */
export function resolveOpsConnectionString(explicit?: string | null): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return envUrl;
  const config = readPartialConfig();
  if (config?.database?.mode === "postgres" && typeof config.database.connectionString === "string") {
    const trimmed = config.database.connectionString.trim();
    if (trimmed) return trimmed;
  }
  return `postgres://combyne:combyne@127.0.0.1:${resolveEmbeddedPort(config)}/combyne`;
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (!args.id || !UUID_RE.test(args.id)) {
    console.error("company-pin: --id <uuid> is required and must be a valid UUID. (Run --help for usage.)");
    return 2;
  }
  if (!args.name) {
    console.error("company-pin: --name <name> is required. (Run --help for usage.)");
    return 2;
  }

  // The company row lives in the OPS DB. Default to the embedded local Postgres when
  // DATABASE_URL is unset so the standard local-first setup works with no env var.
  const url = resolveOpsConnectionString(args.db);
  const usingEmbeddedDefault = !args.db && !process.env.DATABASE_URL?.trim();
  const db = createDb(url);

  let result;
  try {
    result = await adoptPinnedCompany(db, {
      id: args.id,
      name: args.name,
      forceRename: args.forceRename,
    });
  } catch (err) {
    // The script connects to the embedded DB but does NOT manage its lifecycle (that
    // belongs to `pnpm dev`'s boot). If the embedded Postgres isn't running yet, give
    // an actionable message instead of a raw ECONNREFUSED.
    const msg = err instanceof Error ? err.message : String(err);
    const looksLikeConnRefused = /ECONNREFUSED|ENOTFOUND|connect|getaddrinfo|terminat/i.test(msg);
    if (usingEmbeddedDefault && looksLikeConnRefused) {
      console.error(
        `company-pin: could not reach the embedded ops Postgres at ${url}. The embedded DB is\n` +
          `started by the app, not this script — run \`pnpm dev\` (or \`pnpm start\`) in another\n` +
          `terminal so it is up, then re-run this command. Or point at a running DB with --db <url>.\n` +
          `(underlying error: ${msg})`,
      );
      return 1;
    }
    throw err;
  }

  if (result.action === "renamed") {
    console.error(`company-pin: renamed companies.id=${result.id} -> name="${result.name}" (--force-rename)`);
  } else if (result.action === "kept" && result.name !== args.name) {
    console.error(
      `company-pin: companies.id=${result.id} already exists as "${result.name}"; ` +
        `keeping it (ignoring --name "${args.name}"). Pass --force-rename to overwrite.`,
    );
  }

  console.error(
    `company-pin: pinned companies.id=${result.id} name="${result.name}" ` +
      `status=${result.status} issuePrefix=${result.issuePrefix}`,
  );
  process.stdout.write(JSON.stringify({ id: result.id, name: result.name }) + "\n");
  return 0;
}

// Only run as a CLI when invoked directly (not when imported by a test).
const invokedDirectly =
  typeof process.argv[1] === "string" && /company-pin(\.ts|\.js)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err) => {
      console.error("company-pin failed:", err);
      process.exitCode = 1;
    });
}
