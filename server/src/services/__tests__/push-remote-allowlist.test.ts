import { describe, expect, it } from "vitest";
import {
  deriveDefaultAllowedPatterns,
  isRemoteAllowed,
  parseAllowedRemotePatterns,
  parseRemoteSlug,
  resolveAllowedRemotePatterns,
} from "../push-remote-allowlist.js";

describe("push-remote allowlist", () => {
  describe("parseRemoteSlug", () => {
    it("normalizes https, ssh, scp, and bare slugs to host/owner/repo", () => {
      expect(parseRemoteSlug("https://github.com/acme/widget-test.git")?.slug).toBe(
        "github.com/acme/widget-test",
      );
      expect(parseRemoteSlug("git@github.com:acme/widget-test.git")?.slug).toBe(
        "github.com/acme/widget-test",
      );
      expect(parseRemoteSlug("ssh://git@github.com/acme/widget-test")?.slug).toBe(
        "github.com/acme/widget-test",
      );
      // Bare owner/repo defaults the host.
      expect(parseRemoteSlug("acme/widget-test")?.slug).toBe("github.com/acme/widget-test");
      // Credentials and ports are stripped from the host.
      expect(parseRemoteSlug("https://user:pw@github.com:443/acme/widget")?.slug).toBe(
        "github.com/acme/widget",
      );
      // Deeper paths (PR/compare URLs) normalize to the repo identity.
      expect(parseRemoteSlug("https://github.com/acme/widget/pull/42")?.slug).toBe(
        "github.com/acme/widget",
      );
    });

    it("returns null for unparseable values", () => {
      expect(parseRemoteSlug("")).toBeNull();
      expect(parseRemoteSlug(null)).toBeNull();
      expect(parseRemoteSlug("not-a-remote")).toBeNull();
      expect(parseRemoteSlug("github.com")).toBeNull();
    });
  });

  describe("isRemoteAllowed (STRICT)", () => {
    const patterns = deriveDefaultAllowedPatterns(["https://github.com/acme/widget"]);

    it("allows the configured repo and its *-test fork convention", () => {
      // Allowed test repo passes.
      expect(isRemoteAllowed("git@github.com:acme/widget.git", patterns)).toBe(true);
      expect(isRemoteAllowed("https://github.com/acme/widget-test.git", patterns)).toBe(true);
      expect(isRemoteAllowed("acme/widget-feature-test", patterns)).toBe(true);
    });

    it("blocks bukuwarung/* production and other unknown remotes", () => {
      // bukuwarung/* production blocked.
      expect(isRemoteAllowed("git@github.com:bukuwarung/fs-bnpl-service.git", patterns)).toBe(false);
      expect(isRemoteAllowed("https://github.com/bukuwarung/fs-bnpl-service", patterns)).toBe(false);
      // Different owner, unrelated repo, and other hosts all blocked.
      expect(isRemoteAllowed("https://github.com/acme/other-prod", patterns)).toBe(false);
      expect(isRemoteAllowed("https://gitlab.com/acme/widget", patterns)).toBe(false);
    });

    it("blocks everything when the allowlist is empty", () => {
      expect(isRemoteAllowed("https://github.com/acme/widget", [])).toBe(false);
    });

    it("blocks unparseable remotes even with a permissive allowlist", () => {
      expect(isRemoteAllowed("not-a-remote", ["**"])).toBe(false);
    });

    it("supports explicit owner globs and regex patterns", () => {
      expect(isRemoteAllowed("https://github.com/acme/anything", ["acme/*"])).toBe(true);
      expect(isRemoteAllowed("https://github.com/acme/anything", ["bukuwarung/*"])).toBe(false);
      // *-test single-token glob matches the repo segment under any owner.
      expect(isRemoteAllowed("https://github.com/acme/sandbox-test", ["*-test"])).toBe(true);
      expect(isRemoteAllowed("https://github.com/acme/prod", ["*-test"])).toBe(false);
      // Regex form.
      expect(isRemoteAllowed("https://github.com/acme/widget", ["/acme\\/widget$/"])).toBe(true);
      expect(isRemoteAllowed("https://github.com/bukuwarung/x", ["/acme\\/widget$/"])).toBe(false);
    });
  });

  describe("parse + resolve", () => {
    it("parses comma-separated env patterns and trims blanks", () => {
      expect(parseAllowedRemotePatterns(" acme/*-test , , bukuwarung/x ")).toEqual([
        "acme/*-test",
        "bukuwarung/x",
      ]);
      expect(parseAllowedRemotePatterns(null)).toEqual([]);
    });

    it("prefers env patterns, else falls back to repo-derived defaults", () => {
      expect(
        resolveAllowedRemotePatterns({ envValue: "acme/*-test", repoUrls: ["github.com/x/y"] }),
      ).toEqual(["acme/*-test"]);
      const derived = resolveAllowedRemotePatterns({
        envValue: null,
        repoUrls: ["https://github.com/acme/widget"],
      });
      expect(derived).toContain("github.com/acme/widget");
      expect(derived).toContain("github.com/acme/*-test");
    });
  });
});
