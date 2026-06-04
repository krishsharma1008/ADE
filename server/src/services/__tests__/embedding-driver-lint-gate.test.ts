import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * PR-12 CI gate (correctness-transition critique): the redact-before-embed
 * boundary depends on `embedding-driver.ts` being importable ONLY from the
 * approved allowlist (memory-embedder.ts + the driver's own tests). Previously
 * the lint was defined as a script but invoked NOWHERE in CI, and — when run
 * with no args — enumerated only `git ls-files`, so a NEW untracked
 * direct-importer was invisible and the lint passed vacuously.
 *
 * This test makes the lint a real merge gate that runs in `pnpm test:run`:
 *   1) it runs the lint over the REAL working tree (incl. untracked files) and
 *      asserts it passes and actually CHECKED imports (non-vacuous — proves the
 *      single legitimate importer is seen, not zero files);
 *   2) it plants a direct-importer file and asserts the lint FAILS, so the gate
 *      cannot rot into an always-green no-op.
 */
describe("embedding-driver import lint gate", () => {
  const repoRoot = execSync("git rev-parse --show-toplevel", {
    encoding: "utf8",
  }).trim();
  const script = join(repoRoot, "scripts", "lint-embedding-driver-imports.mjs");
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "ed-lint-"));
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function runLint(args: string[]): { code: number; stderr: string; stdout: string } {
    const r = spawnSync("node", [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { code: r.status ?? 1, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
  }

  it("passes over the real working tree AND actually checks imports (non-vacuous)", () => {
    const { code, stdout } = runLint([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/lint passed/i);
    // Prove the gate is not vacuous: the legitimate importer (memory-embedder.ts)
    // MUST have been seen, so at least one import was checked.
    const m = stdout.match(/\((\d+)\s+import/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1] ?? 0)).toBeGreaterThan(0);
  });

  it("FAILS when a non-allowlisted file imports embedding-driver directly", () => {
    const bad = join(tmp, "bypass.ts");
    // Build the import specifier by concatenation so THIS test file's source does
    // not itself contain a literal `…/embedding-driver.js` import — otherwise the
    // real-tree lint run (and the gate above) would flag this very test.
    const spec = "../services/embedding-" + "driver.js";
    writeFileSync(
      bad,
      `import { makeEmbeddingDriver } from "${spec}";\nmakeEmbeddingDriver({ model: "m", dim: 1 });\n`,
      "utf8",
    );
    const { code, stderr } = runLint([bad]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/imports embedding-driver directly/i);
  });

  it("passes for an allowlisted importer path (the approved chokepoint)", () => {
    // The script keys the allowlist on the repo-relative path, so re-run it
    // against the REAL memory-embedder.ts and confirm it is accepted.
    const ok = join(repoRoot, "server", "src", "services", "memory-embedder.ts");
    const { code } = runLint([ok]);
    expect(code).toBe(0);
  });
});
