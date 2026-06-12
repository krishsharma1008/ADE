#!/usr/bin/env node
// Ad-hoc read/query against the LOCAL ops DB (embedded Postgres).
//   node scripts/db-query.mjs "SELECT identifier, status FROM issues LIMIT 5"
// Defaults match the embedded-postgres bootstrap; override via env
// (COMBYNE_EMBEDDED_POSTGRES_PORT for second instances).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "packages/db/package.json"));
const postgres = require("postgres");

const sql = postgres({
  host: "127.0.0.1",
  port: Number(process.env.COMBYNE_EMBEDDED_POSTGRES_PORT ?? 54329),
  user: "combyne",
  password: "combyne",
  database: "combyne",
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
