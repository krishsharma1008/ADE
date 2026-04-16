import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldResetTaskSessionForWake } from "../heartbeat.js";

describe("shouldResetTaskSessionForWake (Phase C4 rollback lever)", () => {
  const originalEnv = process.env.COMBYNE_RESET_SESSION_ON_ASSIGN;

  beforeEach(() => {
    delete process.env.COMBYNE_RESET_SESSION_ON_ASSIGN;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COMBYNE_RESET_SESSION_ON_ASSIGN;
    } else {
      process.env.COMBYNE_RESET_SESSION_ON_ASSIGN = originalEnv;
    }
  });

  it("does NOT reset session when wakeReason=issue_assigned and env flag is unset", () => {
    expect(
      shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" }),
    ).toBe(false);
  });

  it("does NOT reset when env flag is explicitly false", () => {
    process.env.COMBYNE_RESET_SESSION_ON_ASSIGN = "false";
    expect(
      shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" }),
    ).toBe(false);
  });

  it("resets when env flag is true (opt-in rollback)", () => {
    process.env.COMBYNE_RESET_SESSION_ON_ASSIGN = "true";
    expect(
      shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" }),
    ).toBe(true);
  });

  it("always resets for timer wakes (cold scheduled run)", () => {
    expect(shouldResetTaskSessionForWake({ wakeSource: "timer" })).toBe(true);
  });

  it("resets for manual on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      }),
    ).toBe(true);
  });

  it("does not reset for non-manual on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "issue_comment",
      }),
    ).toBe(false);
  });

  it("does not reset when contextSnapshot is null/undefined", () => {
    expect(shouldResetTaskSessionForWake(null)).toBe(false);
    expect(shouldResetTaskSessionForWake(undefined)).toBe(false);
  });
});
