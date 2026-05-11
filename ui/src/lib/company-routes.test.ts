import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  toCompanyRelativePath,
} from "./company-routes";

describe("company route helpers", () => {
  it("treats every static sidebar target as a company board route", () => {
    const sidebarTargets = [
      "/dashboard",
      "/inbox",
      "/issues",
      "/qa",
      "/goals",
      "/routines",
      "/org",
      "/costs",
      "/activity",
      "/memory",
      "/skills",
      "/plugins",
      "/company/settings",
      "/settings/instance",
      "/integrations",
      "/company/export",
      "/company/import",
    ];

    for (const target of sidebarTargets) {
      expect(isBoardPathWithoutPrefix(target), target).toBe(true);
      expect(extractCompanyPrefixFromPath(target), target).toBeNull();
      expect(applyCompanyPrefix(target, "TES"), target).toBe(`/TES${target}`);
      expect(toCompanyRelativePath(`/TES${target}`), target).toBe(target);
    }
  });

  it("normalizes stale company-prefixed memory and QA paths for page memory", () => {
    expect(toCompanyRelativePath("/TES/memory")).toBe("/memory");
    expect(toCompanyRelativePath("/TES/qa")).toBe("/qa");
    expect(toCompanyRelativePath("/TES/memory?layer=shared#active")).toBe("/memory?layer=shared#active");
  });

  it("leaves global documentation paths unprefixed", () => {
    expect(applyCompanyPrefix("/docs", "TES")).toBe("/docs");
    expect(extractCompanyPrefixFromPath("/docs")).toBeNull();
  });
});
