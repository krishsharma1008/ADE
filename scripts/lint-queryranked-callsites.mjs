#!/usr/bin/env node
/**
 * lint-queryranked-callsites.mjs
 *
 * CI gate for the ONE canonical queryRanked signature
 * (CENTRAL_CONTEXT_DB_PLAN §3.2, MEMORY_UI_AND_QUALITY_PLAN §0.3).
 *
 * Every retrieval call site MUST pass the opts object as the 3rd argument so
 * the §3.2 trust filter (requireVerified / minConfidence / excludeSuperseded)
 * is threaded through on BOTH channels. A future fourth retrieval path that
 * forgets the opts object — leaving the unverified channel wide open — is the
 * critics' "governance is cosmetic" failure. This lint FAILS the build if any
 * queryRanked call site outside the approved allowlist omits the opts object.
 *
 * It does NOT execute or type-check; it does a lightweight balanced-paren scan
 * of the call's argument list and asserts a third argument exists.
 *
 * Allowlisted lines are call sites that are intentionally exempt (e.g. the
 * function definition itself, or a doc/spec reference). Add new legit call
 * sites here only with a reason.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

/**
 * Allowlist of "queryRanked(" occurrences that are NOT runtime call sites and
 * are therefore exempt from the 3-arg rule. Keyed by file path (repo-relative)
 * with a substring of the matched line and a reason. The DEFINITION of
 * queryRanked is not a call site; the interface/JSDoc mentions are prose.
 */
const ALLOWLIST = [
  {
    file: "server/src/services/memory.ts",
    contains: "async function queryRanked",
    reason: "function definition, not a call site",
  },
];

/**
 * Files to scan. By default: all PRODUCTION server TS sources (call sites live
 * in server/src). Test files are excluded — they legitimately exercise the opts
 * DEFAULTS (label-only) by calling queryRanked(companyId, query) with no opts,
 * which is valid usage and must not break CI. The gate is about runtime
 * retrieval paths that ship.
 *
 * A caller may pass explicit file paths as argv (used by the acceptance test to
 * point the lint at an omitted-opts fixture and assert it FAILS).
 */
function listSourceFiles() {
  const argvFiles = process.argv.slice(2).filter(Boolean);
  if (argvFiles.length > 0) {
    return argvFiles.map((f) =>
      f.startsWith("/") ? f : resolve(repoRoot, f),
    );
  }
  const out = execSync(
    "git ls-files -- 'server/src/**/*.ts'",
    { encoding: "utf8", cwd: repoRoot },
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !f.includes("/__tests__/"));
}

/**
 * Given source text and the index just after the "queryRanked(" opening paren,
 * count the number of top-level (comma-separated) arguments by walking forward
 * while tracking paren/brace/bracket depth, string literals, and template
 * literals. Returns the argument count.
 */
function countArgs(src, startIdx) {
  let depth = 0;
  let args = 0;
  let sawAny = false;
  let i = startIdx;
  let inString = null; // '"' | "'" | '`'
  for (; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      sawAny = true;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      sawAny = true;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      if (ch === ")" && depth === 0) break; // end of the call's arg list
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      args++;
      continue;
    }
    if (!/\s/.test(ch)) sawAny = true;
  }
  // args counts the top-level commas; the number of arguments is commas+1 when
  // any non-whitespace content was seen, else 0 (an empty call).
  return sawAny ? args + 1 : 0;
}

function isAllowlisted(file, line) {
  return ALLOWLIST.some(
    (a) => a.file === file && line.includes(a.contains),
  );
}

/**
 * Replace the contents of `//` line comments and `/* *​/` block comments with
 * spaces (newlines preserved) so a `queryRanked` mention in prose is not scanned
 * as a call. Strings/templates are tracked so a `//` inside a string literal is
 * not mistaken for a comment. Offsets and line counts are preserved exactly.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let inString = null; // '"' | "'" | '`'
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const CALL_RE = /\bqueryRanked\s*\(/g;
const violations = [];
let callSitesChecked = 0;

for (const entry of listSourceFiles()) {
  const abs = entry.startsWith("/") ? entry : resolve(repoRoot, entry);
  const file = relative(repoRoot, abs); // repo-relative for reporting + allowlist
  let src;
  try {
    src = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  if (!src.includes("queryRanked")) continue;
  // A `queryRanked` mention inside a `//` or `/* */` comment is prose (e.g. a
  // JSDoc "Ranked items from queryRanked"), not a runtime call site. Blank out
  // comment spans (preserving offsets + newlines so reported line numbers stay
  // correct) so the call-count scan never trips on documentation.
  src = stripComments(src);

  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src)) !== null) {
    const matchIdx = m.index;
    // Line for reporting + allowlist matching.
    const lineStart = src.lastIndexOf("\n", matchIdx) + 1;
    const lineEnd = src.indexOf("\n", matchIdx);
    const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd).trim();
    const lineNo = src.slice(0, matchIdx).split("\n").length;

    if (isAllowlisted(file, line)) continue;
    // Skip the interface/type signature mention "queryRanked(query: string..."
    // which is prose in §0.3-style JSDoc — it has no body to count and would
    // be a definition reference, not a runtime call. We detect a call by the
    // presence of a "." before it (svc.queryRanked / longTerm.queryRanked) or
    // an internal bare call followed by an identifier argument. The robust
    // signal is the 3-arg count below.

    const openParenIdx = matchIdx + m[0].length; // index just after "("
    const argc = countArgs(src, openParenIdx);

    // A real retrieval call is queryRanked(companyId, query, opts). Fewer than
    // 3 args means the opts object was omitted — the §3.2 trust filter is not
    // threaded. This is the failure we gate on.
    callSitesChecked++;
    if (argc < 3) {
      violations.push({
        file,
        lineNo,
        line,
        argc,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("\n✗ queryRanked call-site lint FAILED (§3.2 / §0.3 canonical opts):\n");
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.lineNo} — call has ${v.argc} arg(s), expected 3 (companyId, query, opts).`,
    );
    console.error(`      ${v.line}`);
  }
  console.error(
    "\n  Every queryRanked call MUST pass the canonical opts object as the 3rd argument",
  );
  console.error(
    "  so the trust filter (requireVerified / minConfidence / excludeSuperseded) is applied.",
  );
  console.error(
    "  If this call site is legitimately exempt, add it to ALLOWLIST with a reason.\n",
  );
  process.exit(1);
}

console.log(
  `✓ queryRanked call-site lint passed (${callSitesChecked} call site(s) checked, all thread the canonical opts).`,
);
process.exit(0);
