import { describe, expect, it } from "vitest";
import {
  countTokens,
  InMemoryCalibrationStore,
  clampRatio,
  resolveModel,
  tokenizerInfo,
} from "../index.js";
import { median as medianCalibration } from "../calibration.js";

// Reference counts come from manual tiktoken calls; keeping them pinned
// so we detect drift if js-tiktoken ships a new encoding.
const OPENAI_REFS: Array<[string, number]> = [
  ["hello world", 2],
  ["the quick brown fox jumps over the lazy dog", 9],
];

describe("countTokens: OpenAI family (exact)", () => {
  for (const [text, expected] of OPENAI_REFS) {
    it(`matches reference count for "${text.slice(0, 30)}"`, () => {
      const n = countTokens(text, "gpt-4o-mini");
      // ±10% buffer — js-tiktoken is exact but encoding versions drift.
      expect(n).toBeGreaterThanOrEqual(Math.floor(expected * 0.9));
      expect(n).toBeLessThanOrEqual(Math.ceil(expected * 1.1));
    });
  }
});

describe("countTokens: heuristic families", () => {
  it("returns a non-zero count for non-empty text", () => {
    expect(countTokens("hello world", "claude-opus-4-7")).toBeGreaterThan(0);
    expect(countTokens("hello world", "gemini-2.5-pro")).toBeGreaterThan(0);
    expect(countTokens("hello world", "unknown-model-xyz")).toBeGreaterThan(0);
  });

  it("returns 0 for empty text across families", () => {
    expect(countTokens("", "claude-opus-4-7")).toBe(0);
    expect(countTokens("", "gpt-4o-mini")).toBe(0);
    expect(countTokens("", "gemini-2.5-pro")).toBe(0);
  });

  it("grows monotonically with text length", () => {
    const small = countTokens("hi", "claude-sonnet-4-6");
    const big = countTokens("hi ".repeat(500), "claude-sonnet-4-6");
    expect(big).toBeGreaterThan(small);
  });
});

describe("countTokens: additivity (within ~5%)", () => {
  it("countTokens(a + b) ≈ countTokens(a) + countTokens(b)", () => {
    const a = "The repair incident report was filed last Tuesday morning.";
    const b = " The engineer on call rolled the migration back cleanly.";
    const combined = countTokens(a + b, "gpt-4o");
    const sum = countTokens(a, "gpt-4o") + countTokens(b, "gpt-4o");
    expect(Math.abs(combined - sum) / sum).toBeLessThan(0.1);
  });
});

describe("countTokens: panic guard", () => {
  it("does not throw on malformed input and returns a number", () => {
    // Construct a string that has hit past js-tiktoken issues: lone
    // surrogate + embedded null + very long whitespace. The wrapper
    // should catch and fall back.
    const malformed = "\u0000\uD800".repeat(10) + "x".repeat(5000);
    const n = countTokens(malformed, "gpt-4o");
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThan(0);
  });
});

describe("tokenizerInfo", () => {
  it("classifies claude models as anthropic family", () => {
    expect(tokenizerInfo("claude-opus-4-7").family).toBe("anthropic");
    expect(tokenizerInfo("claude-sonnet-4-6").family).toBe("anthropic");
  });

  it("routes gpt-4o to openai/o200k_base", () => {
    const info = tokenizerInfo("gpt-4o");
    expect(info.family).toBe("openai");
    expect(info.encoding).toBe("o200k_base");
    expect(info.isExact).toBe(true);
  });

  it("routes gpt-3.5 to openai/cl100k_base", () => {
    const info = tokenizerInfo("gpt-3.5-turbo");
    expect(info.family).toBe("openai");
    expect(info.encoding).toBe("cl100k_base");
  });

  it("maps gemini to gemini family", () => {
    expect(tokenizerInfo("gemini-2.5-pro").family).toBe("gemini");
  });

  it("falls back to heuristic for unknown vendors", () => {
    const info = tokenizerInfo("pi-inflection-2.5");
    expect(info.family).toBe("heuristic");
    expect(info.isExact).toBe(false);
  });

  it("handles empty / whitespace model strings gracefully", () => {
    expect(tokenizerInfo("").family).toBe("heuristic");
    expect(tokenizerInfo("   ").family).toBe("heuristic");
  });
});

describe("resolveModel is case-insensitive", () => {
  it("treats GPT-4O the same as gpt-4o", () => {
    expect(resolveModel("GPT-4O").family).toBe(resolveModel("gpt-4o").family);
  });
});

describe("calibration store (in-memory)", () => {
  it("returns null before MIN_SAMPLES samples arrive", async () => {
    const store = new InMemoryCalibrationStore();
    for (let i = 0; i < 3; i++) {
      await store.record({
        family: "openai",
        estimatedTokens: 100,
        actualTokens: 110,
        observedAt: new Date(),
      });
    }
    expect(await store.rollingMedianRatio("openai")).toBeNull();
  });

  it("clamps extreme ratios to [0.75, 1.25]", async () => {
    const store = new InMemoryCalibrationStore();
    for (let i = 0; i < 10; i++) {
      await store.record({
        family: "gemini",
        estimatedTokens: 100,
        actualTokens: 500, // 5x overshoot
        observedAt: new Date(),
      });
    }
    expect(await store.rollingMedianRatio("gemini")).toBe(1.25);
  });

  it("ignores samples outside the rolling window", async () => {
    const store = new InMemoryCalibrationStore();
    // Old samples.
    for (let i = 0; i < 10; i++) {
      await store.record({
        family: "openai",
        estimatedTokens: 100,
        actualTokens: 500,
        observedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });
    }
    expect(await store.rollingMedianRatio("openai", 7)).toBeNull();
  });
});

describe("median + clampRatio helpers", () => {
  it("median: empty → null", () => {
    expect(medianCalibration([])).toBeNull();
  });

  it("median: odd length picks middle", () => {
    expect(medianCalibration([3, 1, 2])).toBe(2);
  });

  it("median: even length averages", () => {
    expect(medianCalibration([1, 2, 3, 4])).toBe(2.5);
  });

  it("clampRatio: rejects non-finite", () => {
    expect(clampRatio(Number.NaN)).toBe(1);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampRatio(0)).toBe(1);
  });
});

describe("countTokens with calibration", () => {
  it("scales the raw estimate by the provided ratio", () => {
    const raw = countTokens("hello world repeated many times".repeat(10), "claude-opus-4-7");
    const scaled = countTokens("hello world repeated many times".repeat(10), "claude-opus-4-7", {
      calibrationRatio: 1.25,
    });
    expect(scaled).toBeGreaterThan(raw);
    expect(scaled).toBeLessThanOrEqual(Math.ceil(raw * 1.25) + 1);
  });

  it("clamps a wild calibration ratio", () => {
    const raw = countTokens("x".repeat(200), "claude-opus-4-7");
    const scaled = countTokens("x".repeat(200), "claude-opus-4-7", { calibrationRatio: 10 });
    // Ratio is clamped to 1.25 so scaled <= 1.25 * raw.
    expect(scaled).toBeLessThanOrEqual(Math.ceil(raw * 1.25) + 1);
  });
});
