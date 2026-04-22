import { describe, expect, it } from "vitest";
import { estimateCostUsd, isKnownModel, priceFor } from "../cost-table.js";

describe("cost-table", () => {
  it("returns exact prices for listed models", () => {
    expect(priceFor("claude-haiku-4-5")).toEqual({ input: 0.8, output: 4.0 });
    expect(priceFor("gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
    expect(priceFor("gemini-2.5-flash")).toEqual({ input: 0.075, output: 0.3 });
  });

  it("resolves model aliases via prefix match", () => {
    expect(priceFor("claude-haiku-4-5@latest")).toEqual({ input: 0.8, output: 4.0 });
    expect(priceFor("claude-opus-4-7-20261001")).toEqual({ input: 15.0, output: 75.0 });
  });

  it("falls back to the unknown-model price for unrecognised models", () => {
    const p = priceFor("made-up-model");
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThan(0);
    expect(p).not.toEqual(priceFor("claude-haiku-4-5"));
  });

  it("falls back to unknown for empty model", () => {
    expect(priceFor("")).toEqual(priceFor("does-not-exist-model"));
  });

  it("estimateCostUsd is linear in tokens per price", () => {
    const cost = estimateCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.8 + 4.0, 5);
    const half = estimateCostUsd("claude-haiku-4-5", 500_000, 500_000);
    expect(half).toBeCloseTo(cost / 2, 5);
  });

  it("isKnownModel is true for listed + prefix match, false otherwise", () => {
    expect(isKnownModel("gpt-4o-mini")).toBe(true);
    expect(isKnownModel("gpt-4o-mini@2024-07-18")).toBe(true);
    expect(isKnownModel("mistral-large")).toBe(false);
    expect(isKnownModel("")).toBe(false);
  });
});
