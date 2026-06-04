import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * PR-3 acceptance: the queryRanked call-site lint passes for current (shipping)
 * call sites and FAILS when a call omits the canonical opts object. This guards
 * the §3.2 two-sided rule — a future fourth retrieval path that forgets the
 * trust filter must break CI.
 */
describe("queryRanked call-site lint gate", () => {
  const repoRoot = execSync("git rev-parse --show-toplevel", {
    encoding: "utf8",
  }).trim();
  const script = join(repoRoot, "scripts", "lint-queryranked-callsites.mjs");
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "qr-lint-"));
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

  it("passes for the current shipping call sites (no args = scan server/src)", () => {
    const { code, stdout } = runLint([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/lint passed/i);
  });

  it("FAILS when a call site omits the opts object (2-arg call)", () => {
    const bad = join(tmp, "omits-opts.ts");
    writeFileSync(
      bad,
      'const r = await svc.queryRanked(companyId, "query text");\n',
      "utf8",
    );
    const { code, stderr } = runLint([bad]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/expected 3/i);
  });

  it("passes when the same call site DOES pass the opts object", () => {
    const good = join(tmp, "with-opts.ts");
    writeFileSync(
      good,
      'const r = await svc.queryRanked(companyId, "query text", { requireVerified: false, excludeSuperseded: true });\n',
      "utf8",
    );
    const { code } = runLint([good]);
    expect(code).toBe(0);
  });
});
