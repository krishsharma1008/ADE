#!/usr/bin/env node
/**
 * lint-embedding-driver-imports.mjs
 *
 * CI gate for the redact-before-embed boundary (MEMORY_UI_AND_QUALITY_PLAN
 * §1.4.2 fact #1): `embedding-driver.ts` (the raw provider HTTP call) must be
 * reachable ONLY through `memory-embedder.ts`, which runs scanBody() on every
 * text BEFORE the driver sees it. If a second module imported the driver
 * directly it could egress an un-redacted body, silently bypassing the secret
 * scanner. This gate FAILS the build if anything other than the approved caller
 * imports embedding-driver.
 *
 * It is a lightweight grep (no type-check): it scans server/src for import
 * specifiers ending in `embedding-driver` and asserts the importing file is on
 * the allowlist.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

/**
 * The ONLY files allowed to import embedding-driver. memory-embedder.ts is the
 * redact-before-embed chokepoint; the driver's own tests exercise it directly.
 */
const ALLOWLIST = [
  "server/src/services/memory-embedder.ts",
  // Tests legitimately import the EmbeddingDriver TYPE to build mock drivers;
  // they never call the real provider. The runtime egress chokepoint is the
  // single non-test importer above.
  "server/src/services/__tests__/embedding-driver.test.ts",
  "server/src/services/__tests__/embedding-version.test.ts",
  "server/src/services/__tests__/memory-reembed.test.ts",
];

function listSourceFiles() {
  const argvFiles = process.argv.slice(2).filter(Boolean);
  if (argvFiles.length > 0) {
    return argvFiles.map((f) => (f.startsWith("/") ? f : resolve(repoRoot, f)));
  }
  const out = execSync("git ls-files -- 'server/src/**/*.ts'", {
    encoding: "utf8",
    cwd: repoRoot,
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Matches: import … from "…/embedding-driver(.js)?"  and  import("…/embedding-driver")
const IMPORT_RE = /\bfrom\s+["'][^"']*\/embedding-driver(?:\.js)?["']|\bimport\(\s*["'][^"']*\/embedding-driver(?:\.js)?["']/g;

const violations = [];
let importsChecked = 0;

for (const entry of listSourceFiles()) {
  const abs = entry.startsWith("/") ? entry : resolve(repoRoot, entry);
  const file = relative(repoRoot, abs);
  let src;
  try {
    src = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  if (!src.includes("embedding-driver")) continue;

  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    importsChecked++;
    if (!ALLOWLIST.includes(file)) {
      const lineNo = src.slice(0, m.index).split("\n").length;
      violations.push({ file, lineNo, snippet: m[0] });
    }
  }
}

if (violations.length > 0) {
  console.error("\n✗ embedding-driver import lint FAILED (redact-before-embed boundary §1.4.2):\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.lineNo} — imports embedding-driver directly.`);
    console.error(`      ${v.snippet}`);
  }
  console.error(
    "\n  embedding-driver.ts must be reached ONLY through memory-embedder.ts, which runs",
  );
  console.error(
    "  scanBody() (redact-before-embed) before any provider call. A direct import could",
  );
  console.error("  egress an un-redacted body. If this is legitimate, add it to ALLOWLIST.\n");
  process.exit(1);
}

console.log(
  `✓ embedding-driver import lint passed (${importsChecked} import(s) checked, all via memory-embedder).`,
);
process.exit(0);
