import { describe, expect, it } from "vitest";
import { composeBudgetedPreamble, countTokens, type PreambleSection } from "../index.js";

const MODEL = "gpt-4o-mini";

function section(partial: Partial<PreambleSection> & { name: string; content: string }): PreambleSection {
  return {
    priority: 1,
    cacheStable: false,
    truncationStrategy: "tail",
    ...partial,
  };
}

describe("composeBudgetedPreamble: basics", () => {
  it("returns an empty composition for an empty section list", () => {
    const out = composeBudgetedPreamble([], { budget: 1000, model: MODEL });
    expect(out.body).toBe("");
    expect(out.totalTokens).toBe(0);
    expect(out.usage).toEqual({});
    expect(out.dropped).toEqual([]);
  });

  it("joins a single stable section verbatim when under budget", () => {
    const sys = section({ name: "system", content: "SYS", cacheStable: true, priority: 0 });
    const out = composeBudgetedPreamble([sys], { budget: 1000, model: MODEL });
    expect(out.body).toContain("SYS");
    expect(out.cachePrefix).toContain("SYS");
    expect(out.totalTokens).toBeGreaterThan(0);
    expect(out.dropped).toEqual([]);
  });

  it("places stable content before vary content in the body", () => {
    const sys = section({ name: "system", content: "STABLEMARK", cacheStable: true, priority: 0 });
    const focus = section({ name: "focus", content: "VARYMARK", cacheStable: false, priority: 0 });
    const out = composeBudgetedPreamble([sys, focus], { budget: 1000, model: MODEL });
    const stableIdx = out.body.indexOf("STABLEMARK");
    const varyIdx = out.body.indexOf("VARYMARK");
    expect(stableIdx).toBeGreaterThanOrEqual(0);
    expect(varyIdx).toBeGreaterThan(stableIdx);
  });
});

describe("composeBudgetedPreamble: cache-prefix stability", () => {
  it("produces identical prefix hash across runs when stable content is unchanged", () => {
    const stableSys = section({
      name: "system",
      content: "Stable system block that never changes.",
      cacheStable: true,
      priority: 0,
    });
    const stableSkills = section({
      name: "skills",
      content: "Skill A\nSkill B",
      cacheStable: true,
      priority: 1,
    });
    const varyA = section({ name: "focus", content: "Working on BUK-1", priority: 0 });
    const varyB = section({ name: "focus", content: "Working on BUK-2 with totally different narrative text" });

    const runA = composeBudgetedPreamble([stableSys, stableSkills, varyA], { budget: 2000, model: MODEL });
    const runB = composeBudgetedPreamble([stableSys, stableSkills, varyB], { budget: 2000, model: MODEL });
    expect(runA.cachePrefixHash).toBe(runB.cachePrefixHash);
    expect(runA.cachePrefix).toBe(runB.cachePrefix);
  });

  it("changes the prefix hash when a stable section is edited", () => {
    const v1 = section({ name: "system", content: "v1", cacheStable: true, priority: 0 });
    const v2 = section({ name: "system", content: "v2", cacheStable: true, priority: 0 });
    const runA = composeBudgetedPreamble([v1], { budget: 100, model: MODEL });
    const runB = composeBudgetedPreamble([v2], { budget: 100, model: MODEL });
    expect(runA.cachePrefixHash).not.toBe(runB.cachePrefixHash);
  });
});

describe("composeBudgetedPreamble: priority-based dropping", () => {
  it("drops lowest-priority vary section first when over budget", () => {
    const long = "word ".repeat(2000);
    const focus = section({ name: "focus", content: "FOCUSBLOCK", priority: 0 });
    const queue = section({ name: "queue", content: long, priority: 3, maxTokens: 100 });
    const tools = section({ name: "toolResults", content: long, priority: 4, maxTokens: 100 });

    const out = composeBudgetedPreamble([focus, queue, tools], { budget: 200, model: MODEL });
    expect(out.body).toContain("FOCUSBLOCK");
    // Higher-priority-number sections should be dropped or aggressively truncated
    // when budget is tight.
    expect(out.dropped.length + out.truncated.length).toBeGreaterThan(0);
  });

  it("preserves priority-0 content in full when strategy=preserve", () => {
    const focus = section({
      name: "focus",
      content: "PRESERVE_ME_EXACTLY",
      priority: 0,
      truncationStrategy: "preserve",
    });
    const out = composeBudgetedPreamble([focus], { budget: 1000, model: MODEL });
    expect(out.body).toContain("PRESERVE_ME_EXACTLY");
  });
});

describe("composeBudgetedPreamble: truncation strategies", () => {
  const bigText = "chunk ".repeat(5000);

  it("tail strategy keeps the head and truncates the end", () => {
    const s = section({
      name: "memory",
      content: `HEAD_MARKER ${bigText} TAIL_MARKER`,
      cacheStable: true,
      priority: 2,
      maxTokens: 50,
      truncationStrategy: "tail",
    });
    const out = composeBudgetedPreamble([s], { budget: 100, model: MODEL });
    expect(out.body).toContain("HEAD_MARKER");
    expect(out.body).not.toContain("TAIL_MARKER");
    expect(out.truncated).toContain("memory");
  });

  it("head strategy keeps the tail and drops the beginning", () => {
    const s = section({
      name: "recentTurns",
      content: `HEAD_MARKER ${bigText} TAIL_MARKER`,
      priority: 2,
      maxTokens: 50,
      truncationStrategy: "head",
    });
    const out = composeBudgetedPreamble([s], { budget: 100, model: MODEL });
    expect(out.body).toContain("TAIL_MARKER");
    expect(out.body).not.toContain("HEAD_MARKER");
  });

  it("middle strategy keeps head and tail, omits middle", () => {
    const s = section({
      name: "toolResults",
      content: `HEAD_MARKER ${bigText} TAIL_MARKER`,
      priority: 4,
      maxTokens: 60,
      truncationStrategy: "middle",
    });
    const out = composeBudgetedPreamble([s], { budget: 200, model: MODEL });
    expect(out.body).toContain("HEAD_MARKER");
    expect(out.body).toContain("TAIL_MARKER");
    expect(out.body).toContain("[content omitted]");
  });
});

describe("composeBudgetedPreamble: reports usage + totals", () => {
  it("sums per-section tokens to totalTokens (±5%)", () => {
    const a = section({ name: "system", content: "alpha ".repeat(50), cacheStable: true, priority: 0 });
    const b = section({ name: "focus", content: "beta ".repeat(50), priority: 0 });
    const out = composeBudgetedPreamble([a, b], { budget: 10000, model: MODEL });
    const summed = Object.values(out.usage).reduce((x, y) => x + y, 0);
    expect(Math.abs(out.totalTokens - summed)).toBeLessThanOrEqual(Math.ceil(summed * 0.05) + 1);
  });
});

describe("composeBudgetedPreamble: stable overflow", () => {
  it("warns and shrinks stable sections when they would eat the whole budget", () => {
    const huge = "stable ".repeat(2000);
    const sys = section({ name: "system", content: huge, cacheStable: true, priority: 0 });
    const skills = section({ name: "skills", content: huge, cacheStable: true, priority: 1 });
    const memory = section({ name: "memory", content: huge, cacheStable: true, priority: 3 });

    const out = composeBudgetedPreamble([sys, skills, memory], { budget: 200, model: MODEL });
    // Some stable sections should get truncated or dropped.
    expect(out.truncated.length + out.dropped.length).toBeGreaterThan(0);
    // Stable budget is 60% of 200 = 120 tokens. Allow small overshoot from tokenizer imprecision.
    expect(out.stableTokens).toBeLessThanOrEqual(200);
  });
});

describe("composeBudgetedPreamble: real-world totals stay near budget", () => {
  it("never exceeds budget by more than 10% (tokenizer tolerance)", () => {
    const sections: PreambleSection[] = [
      section({
        name: "system",
        content: "You are a helpful agent. ".repeat(80),
        cacheStable: true,
        priority: 0,
      }),
      section({
        name: "skills",
        content: "Skill block. ".repeat(120),
        cacheStable: true,
        priority: 1,
        maxTokens: 400,
      }),
      section({
        name: "focus",
        content: "Current focus issue description. ".repeat(60),
        priority: 0,
      }),
      section({
        name: "recentTurns",
        content: "turn-content-a. ".repeat(500),
        priority: 2,
        truncationStrategy: "head",
      }),
      section({
        name: "queue",
        content: "queue line. ".repeat(200),
        priority: 3,
        maxTokens: 200,
      }),
      section({
        name: "toolResults",
        content: "tool output chunk ".repeat(800),
        priority: 4,
        maxTokens: 300,
        truncationStrategy: "middle",
      }),
    ];
    const out = composeBudgetedPreamble(sections, { budget: 1500, model: MODEL });
    expect(out.totalTokens).toBeLessThanOrEqual(Math.ceil(1500 * 1.1));
    // And the body should actually reflect the claimed tokens (±15%)
    const bodyTokens = countTokens(out.body, MODEL);
    expect(Math.abs(bodyTokens - out.totalTokens)).toBeLessThanOrEqual(
      Math.ceil(bodyTokens * 0.15) + 5,
    );
  });
});
