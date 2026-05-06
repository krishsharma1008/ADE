import { afterEach, describe, expect, it } from "vitest";
import {
  computeSmallTaskTokenUsage,
  evaluateSmallTaskTokenBudget,
  smallTaskTokenPauseMode,
  smallTaskTokenPauseThreshold,
} from "../heartbeat.js";

describe("heartbeat small-task token budget", () => {
  const originalThreshold = process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_THRESHOLD;
  const originalMode = process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_MODE;

  afterEach(() => {
    if (originalThreshold === undefined) {
      delete process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_THRESHOLD;
    } else {
      process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_THRESHOLD = originalThreshold;
    }
    if (originalMode === undefined) {
      delete process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_MODE;
    } else {
      process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_MODE = originalMode;
    }
  });

  it("defaults to a high soft limit so autonomous tasks are not repeatedly parked", () => {
    delete process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_THRESHOLD;
    delete process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_MODE;

    expect(smallTaskTokenPauseThreshold()).toBe(1_000_000);
    expect(smallTaskTokenPauseMode()).toBe("soft");
  });

  it("does not count cached input tokens as active threshold spend", () => {
    const usage = computeSmallTaskTokenUsage({
      inputTokens: 54,
      cachedInputTokens: 2_801_302,
      outputTokens: 12_700,
    });

    expect(usage.totalTokens).toBe(2_814_056);
    expect(usage.activeTokens).toBe(12_754);
  });

  it("does not pause a cache-heavy small task below the active-token threshold", () => {
    process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_THRESHOLD = "80000";
    process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_MODE = "hard";

    const result = evaluateSmallTaskTokenBudget({
      adapterType: "claude_local",
      context: { issueId: "issue-1" },
      usage: {
        inputTokens: 54,
        cachedInputTokens: 2_801_302,
        outputTokens: 12_700,
      },
    });

    expect(result.usage.totalTokens).toBeGreaterThan(80_000);
    expect(result.usage.activeTokens).toBeLessThan(80_000);
    expect(result.exceeded).toBe(false);
    expect(result.hardPause).toBe(false);
  });

  it("soft mode records an overage without forcing awaiting_user", () => {
    process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_THRESHOLD = "80000";
    process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_MODE = "soft";

    const result = evaluateSmallTaskTokenBudget({
      adapterType: "claude_local",
      context: { issueId: "issue-1" },
      usage: {
        inputTokens: 90_000,
        cachedInputTokens: 2_000_000,
        outputTokens: 20_000,
      },
    });

    expect(result.exceeded).toBe(true);
    expect(result.softNotice).toBe(true);
    expect(result.hardPause).toBe(false);
  });

  it("hard mode remains available as an explicit opt-in", () => {
    process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_THRESHOLD = "80000";
    process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_MODE = "hard";

    const result = evaluateSmallTaskTokenBudget({
      adapterType: "claude_local",
      context: { issueId: "issue-1" },
      usage: {
        inputTokens: 90_000,
        cachedInputTokens: 0,
        outputTokens: 20_000,
      },
    });

    expect(result.exceeded).toBe(true);
    expect(result.softNotice).toBe(false);
    expect(result.hardPause).toBe(true);
  });
});
