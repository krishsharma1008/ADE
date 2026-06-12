#!/usr/bin/env node
// Ad-hoc read/query against the CENTRAL context DB (the shared memory rail).
//   node scripts/context-query.mjs "SELECT count(*) FROM memory_entries"
// Reads COMBYNE_CONTEXT_DATABASE_URL from the INSTANCE env file (the one the
// server actually loads — ~/.combyne/instances/default/.env), with process
// env taking precedence. Careful: this is the live shared team rail.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "packages/db/package.json"));
const postgres = require("postgres");

function resolveRailUrl() {
  if (process.env.COMBYNE_CONTEXT_DATABASE_URL) return process.env.COMBYNE_CONTEXT_DATABASE_URL;
  const instanceEnv = path.join(
    process.env.COMBYNE_HOME ?? path.join(os.homedir(), ".combyne"),
    "instances",
    process.env.COMBYNE_INSTANCE_ID ?? "default",
    ".env",
  );
  try {
    const line = readFileSync(instanceEnv, "utf8")
      .split("\n")
      .find((l) => l.startsWith("COMBYNE_CONTEXT_DATABASE_URL="));
    if (line) return line.split("=").slice(1).join("=").trim();
  } catch {
    // fall through
  }
  return "";
}

const url = resolveRailUrl();
if (!url) {
  console.error("ERR no COMBYNE_CONTEXT_DATABASE_URL in env or instance .env");
  process.exit(1);
}

const sql = postgres(url.replace(/[?&]sslmode=require/, ""), {
  // Self-signed cert on the self-hosted rail — encrypt but don't verify,
  // matching the server's own pool settings for this box.
  ssl: { rejectUnauthorized: false },
  connect_timeout: 10,
});

try {
  const rows = await sql.unsafe(process.argv[2] ?? "SELECT 1");
  console.log(JSON.stringify(rows, null, 1));
} catch (err) {
  console.error("ERR", err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
