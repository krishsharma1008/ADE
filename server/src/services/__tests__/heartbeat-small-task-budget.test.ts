import { afterEach, describe, expect, it } from "vitest";
import type { agents } from "@combyne/db";
import {
  DEFERRED_WAKE_CONTEXT_KEY,
  SMALL_TASK_MAX_TURNS_DEFAULT,
  computeSmallTaskTokenUsage,
  evaluateSmallTaskTokenBudget,
  smallTaskTokenPauseMode,
  smallTaskTokenPauseThreshold,
  withSmallCodingTaskControls,
} from "../heartbeat.js";

// Minimal agent fixture — withSmallCodingTaskControls only reads adapterType
// and adapterConfig. Cast keeps the test focused without standing up a row.
function smallTaskAgent(
  overrides: Partial<typeof agents.$inferSelect> = {},
): typeof agents.$inferSelect {
  return {
    adapterType: "claude_local",
    adapterConfig: {},
    ...overrides,
  } as typeof agents.$inferSelect;
}

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

  it("applies the token budget when scope is only in the nested deferred-wake form", () => {
    process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_THRESHOLD = "80000";
    process.env.COMBYNE_SMALL_TASK_TOKEN_PAUSE_MODE = "hard";

    const result = evaluateSmallTaskTokenBudget({
      adapterType: "claude_local",
      // No top-level issueId/taskId — scope lives under the deferred-wake key,
      // exactly as a promoted/coalesced assignment run carries it.
      context: { [DEFERRED_WAKE_CONTEXT_KEY]: { issueId: "issue-nested" } },
      usage: { inputTokens: 90_000, cachedInputTokens: 0, outputTokens: 20_000 },
    });

    expect(result.applies).toBe(true);
    expect(result.exceeded).toBe(true);
    expect(result.hardPause).toBe(true);
  });
});

describe("withSmallCodingTaskControls turn/timeout cap", () => {
  const originalMaxTurns = process.env.COMBYNE_SMALL_TASK_MAX_TURNS;

  afterEach(() => {
    if (originalMaxTurns === undefined) {
      delete process.env.COMBYNE_SMALL_TASK_MAX_TURNS;
    } else {
      process.env.COMBYNE_SMALL_TASK_MAX_TURNS = originalMaxTurns;
    }
  });

  it("caps an issue-scoped run to the small-task max turns (top-level scope)", () => {
    delete process.env.COMBYNE_SMALL_TASK_MAX_TURNS;

    const result = withSmallCodingTaskControls(
      smallTaskAgent(),
      { maxTurnsPerRun: 100 },
      { issueId: "issue-1", taskId: "issue-1" },
    );

    expect(result.maxTurnsPerRun).toBe(SMALL_TASK_MAX_TURNS_DEFAULT);
  });

  // Regression: assignment-triggered run PINB405-9 ran 63 turns because its
  // issue scope was carried ONLY under the deferred-wake key (promoted/coalesced
  // wake), so the top-level-only guard skipped the cap. The cap must now bind.
  it("caps an issue-scoped run whose scope is only in the nested deferred-wake form", () => {
    delete process.env.COMBYNE_SMALL_TASK_MAX_TURNS;

    const result = withSmallCodingTaskControls(
      smallTaskAgent(),
      { maxTurnsPerRun: 100 },
      { [DEFERRED_WAKE_CONTEXT_KEY]: { issueId: "issue-nested", taskId: "issue-nested" } },
    );

    expect(result.maxTurnsPerRun).toBe(SMALL_TASK_MAX_TURNS_DEFAULT);
  });

  it("does not cap a genuinely non-issue run (no scope anywhere)", () => {
    delete process.env.COMBYNE_SMALL_TASK_MAX_TURNS;

    const result = withSmallCodingTaskControls(
      smallTaskAgent(),
      { maxTurnsPerRun: 100 },
      { wakeReason: "timer" },
    );

    // Untouched: the agent's raw per-run turn budget is preserved.
    expect(result.maxTurnsPerRun).toBe(100);
  });

  it("does not cap an accepted-work run even when issue-scoped", () => {
    delete process.env.COMBYNE_SMALL_TASK_MAX_TURNS;

    const result = withSmallCodingTaskControls(
      smallTaskAgent(),
      { maxTurnsPerRun: 100 },
      { issueId: "issue-1", acceptedWorkEventId: "evt-1" },
    );

    expect(result.maxTurnsPerRun).toBe(100);
  });
});
