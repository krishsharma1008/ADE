// WS-B: capability-driven command-guard shim. Default flags must reproduce the
// historical guard exactly (merge blocked, push/PR-create allowed); explicit
// flags add/remove the corresponding blocks.

import { describe, expect, it } from "vitest";
import {
  readCommandGuardCapabilitiesFromEnv,
  renderCommandGuardScript,
} from "@combyne/adapter-utils/command-guard";

describe("readCommandGuardCapabilitiesFromEnv", () => {
  it("defaults preserve current policy: push/raise allowed, merge blocked", () => {
    expect(readCommandGuardCapabilitiesFromEnv({})).toEqual({
      canPush: true,
      canRaisePr: true,
      canMergePr: false,
    });
  });

  it("explicit flags override in both directions", () => {
    expect(
      readCommandGuardCapabilitiesFromEnv({
        COMBYNE_GH_CAN_PUSH: "false",
        COMBYNE_GH_CAN_RAISE_PR: "false",
        COMBYNE_GH_CAN_MERGE_PR: "true",
      }),
    ).toEqual({ canPush: false, canRaisePr: false, canMergePr: true });
  });

  it("garbage values fall back to defaults", () => {
    expect(
      readCommandGuardCapabilitiesFromEnv({ COMBYNE_GH_CAN_MERGE_PR: "yes please" }),
    ).toEqual({ canPush: true, canRaisePr: true, canMergePr: false });
  });
});

describe("renderCommandGuardScript", () => {
  const defaults = { canPush: true, canRaisePr: true, canMergePr: false };

  it("default gh script blocks pr merge and the merge API, not pr create", () => {
    const script = renderCommandGuardScript("gh", "/tmp/guard", defaults);
    expect(script).toContain("Blocked gh pr merge");
    expect(script).toContain("Blocked direct GitHub pull merge API call");
    expect(script).not.toContain("Blocked gh pr create");
  });

  it("default git script blocks protected-base merges, not push", () => {
    const script = renderCommandGuardScript("git", "/tmp/guard", defaults);
    expect(script).toContain("Blocked direct git merge into a protected base branch");
    expect(script).not.toContain("Blocked git push");
  });

  it("canPush=false adds the git push block", () => {
    const script = renderCommandGuardScript("git", "/tmp/guard", { ...defaults, canPush: false });
    expect(script).toContain("Blocked git push");
  });

  it("canRaisePr=false adds the gh pr create block", () => {
    const script = renderCommandGuardScript("gh", "/tmp/guard", { ...defaults, canRaisePr: false });
    expect(script).toContain("Blocked gh pr create");
  });

  it("explicit canMergePr=true removes the merge blocks (the ONLY way to relax them)", () => {
    const gh = renderCommandGuardScript("gh", "/tmp/guard", { ...defaults, canMergePr: true });
    expect(gh).not.toContain("Blocked gh pr merge");
    const git = renderCommandGuardScript("git", "/tmp/guard", { ...defaults, canMergePr: true });
    expect(git).not.toContain("Blocked direct git merge");
  });

  it("every script strips the guard dir from PATH before delegating", () => {
    for (const tool of ["gh", "git"] as const) {
      const script = renderCommandGuardScript(tool, "/tmp/guard", defaults);
      expect(script).toContain('export PATH="${PATH#$COMBYNE_GUARD_DIR:}"');
      expect(script).toContain('command "$tool" "$@"');
    }
  });
});
