import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePruningMode } from "../context-budget-telemetry.js";

describe("resolvePruningMode", () => {
  const original = process.env.COMBYNE_CONTEXT_BUDGET_AGGRESSIVE_PRUNING;

  beforeEach(() => {
    delete process.env.COMBYNE_CONTEXT_BUDGET_AGGRESSIVE_PRUNING;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.COMBYNE_CONTEXT_BUDGET_AGGRESSIVE_PRUNING;
    } else {
      process.env.COMBYNE_CONTEXT_BUDGET_AGGRESSIVE_PRUNING = original;
    }
  });

  it("defaults to additive when env flag unset", () => {
    expect(resolvePruningMode()).toBe("additive");
  });

  it("defaults to additive when env flag is empty", () => {
    process.env.COMBYNE_CONTEXT_BUDGET_AGGRESSIVE_PRUNING = "";
    expect(resolvePruningMode()).toBe("additive");
  });

  it("returns aggressive for '1'", () => {
    process.env.COMBYNE_CONTEXT_BUDGET_AGGRESSIVE_PRUNING = "1";
    expect(resolvePruningMode()).toBe("aggressive");
  });

  it("returns aggressive for 'true'", () => {
    process.env.COMBYNE_CONTEXT_BUDGET_AGGRESSIVE_PRUNING = "true";
    expect(resolvePruningMode()).toBe("aggressive");
  });

  it("returns additive for arbitrary other values", () => {
    process.env.COMBYNE_CONTEXT_BUDGET_AGGRESSIVE_PRUNING = "yes";
    expect(resolvePruningMode()).toBe("additive");
  });
});
