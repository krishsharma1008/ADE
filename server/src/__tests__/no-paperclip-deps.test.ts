import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * Critical test: ensures no external dependencies on the upstream project remain
 * after merge. Combyne must be fully self-contained.
 */
describe("No upstream external dependencies", () => {
  it("has no @paperclipai/ imports in server source", () => {
    const result = execSync(
      `grep -r "@paperclipai/" "${ROOT}/server/src/" --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ -l 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });

  it("has no @paperclipai/ imports in packages source", () => {
    const result = execSync(
      `grep -r "@paperclipai/" "${ROOT}/packages/" --include="*.ts" --include="*.tsx" -l --exclude-dir=node_modules 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });

  it("has no @paperclipai/ imports in UI source", () => {
    const result = execSync(
      `grep -r "@paperclipai/" "${ROOT}/ui/src/" --include="*.ts" --include="*.tsx" -l 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });

  it("has no PAPERCLIP_ env var references in server source", () => {
    const result = execSync(
      `grep -r "PAPERCLIP_" "${ROOT}/server/src/" --include="*.ts" --exclude-dir=__tests__ -l 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });

  it("has no PAPERCLIP_ env var references in packages source", () => {
    const result = execSync(
      `grep -r "PAPERCLIP_" "${ROOT}/packages/" --include="*.ts" -l --exclude-dir=node_modules 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });

  it("has no hermes-paperclip-adapter dependency in package.json files", () => {
    const serverPkg = execSync(
      `grep -l "hermes-paperclip-adapter" "${ROOT}/server/package.json" "${ROOT}/ui/package.json" "${ROOT}/package.json" 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(serverPkg).toBe("");
  });

  it('has no pcp_ token prefix in server source (should be comb_)', () => {
    const result = execSync(
      `grep -rn '"pcp_' "${ROOT}/server/src/" --include="*.ts" --exclude-dir=__tests__ 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });

  it("has no pcp_ token prefix in packages source", () => {
    const result = execSync(
      `grep -rn '"pcp_' "${ROOT}/packages/" --include="*.ts" --exclude-dir=node_modules 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });

  it("has no upstream path references in source", () => {
    const result = execSync(
      `grep -rn "~/\\.paperclip/" "${ROOT}/server/src/" "${ROOT}/packages/" --include="*.ts" --exclude-dir=node_modules --exclude-dir=__tests__ 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });

  it("has no upstream domain URL references in source", () => {
    const result = execSync(
      `grep -rn "paperclip\\.ai\\|paperclip\\.com" "${ROOT}/server/src/" "${ROOT}/packages/" "${ROOT}/ui/src/" --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=__tests__ 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    expect(result).toBe("");
  });
});
