import { describe, expect, it } from "vitest";
import {
  buildPreambleSectionsFromContext,
  resolveContextBudgetTokens,
  runShadowComposer,
} from "../context-budget-telemetry.js";

describe("buildPreambleSectionsFromContext", () => {
  it("gathers every populated combyne* field into a typed section", () => {
    const context: Record<string, unknown> = {
      combyneBootstrapAnalysis: { preamble: "BOOTSTRAP", reason: "first-ceo-issue" },
      combyneHandoffBrief: { brief: "HANDOFF" },
      combyneMemoryPreamble: { body: "MEMORY", entryCount: 3, scope: "agent" },
      combyneHirePlaybook: { body: "HIRE" },
      combyneFocusDirective: { body: "FOCUS_BLOCK", directive: "stay on this" },
      combyneAssignedIssues: { digestBody: "DIGEST", body: "legacy" },
      combyneCompanyProjects: { items: [{ id: "p1", name: "Project One" }] },
    };
    const sections = buildPreambleSectionsFromContext(context);
    const names = sections.map((s) => s.name);
    expect(names).toContain("bootstrap");
    expect(names).toContain("handoff");
    expect(names).toContain("memory");
    expect(names).toContain("focus");
    expect(names).toContain("queue");
    expect(names).toContain("projects");
    // focus should be priority 0 and not cache-stable.
    const focus = sections.find((s) => s.name === "focus");
    expect(focus?.priority).toBe(0);
    expect(focus?.cacheStable).toBe(false);
    // memory is cache-stable (belongs in the prompt-cache prefix)
    const memory = sections.find((s) => s.name === "memory");
    expect(memory?.cacheStable).toBe(true);
  });

  it("returns an empty list when no combyne fields are set", () => {
    expect(buildPreambleSectionsFromContext({})).toEqual([]);
  });

  it("prefers digestBody over legacy body", () => {
    const sections = buildPreambleSectionsFromContext({
      combyneAssignedIssues: { digestBody: "NEW_DIGEST", body: "OLD" },
    });
    const queue = sections.find((s) => s.name === "queue");
    expect(queue?.content).toBe("NEW_DIGEST");
  });
});

describe("resolveContextBudgetTokens", () => {
  it("uses the adapter-default budget when no override is set", () => {
    expect(resolveContextBudgetTokens("claude-local", {})).toBe(160_000);
    expect(resolveContextBudgetTokens("codex-local", {})).toBe(320_000);
    expect(resolveContextBudgetTokens("pi-local", {})).toBe(24_000);
  });

  it("prefers adapterConfig.contextBudgetTokens when set", () => {
    expect(
      resolveContextBudgetTokens("claude-local", { contextBudgetTokens: 50_000 }),
    ).toBe(50_000);
  });

  it("reads COMBYNE_<ADAPTER>_CONTEXT_BUDGET_TOKENS from env as fallback", () => {
    const original = process.env.COMBYNE_GEMINI_LOCAL_CONTEXT_BUDGET_TOKENS;
    try {
      process.env.COMBYNE_GEMINI_LOCAL_CONTEXT_BUDGET_TOKENS = "12345";
      expect(resolveContextBudgetTokens("gemini-local", {})).toBe(12345);
    } finally {
      if (original === undefined) {
        delete process.env.COMBYNE_GEMINI_LOCAL_CONTEXT_BUDGET_TOKENS;
      } else {
        process.env.COMBYNE_GEMINI_LOCAL_CONTEXT_BUDGET_TOKENS = original;
      }
    }
  });

  it("falls back to a sane default for unknown adapters", () => {
    expect(resolveContextBudgetTokens("some-new-adapter", {})).toBeGreaterThan(0);
  });
});

describe("runShadowComposer", () => {
  it("returns null when the context has no sections", () => {
    const out = runShadowComposer({
      context: {},
      adapterType: "claude-local",
      adapterConfig: {},
      actualPrompt: "prompt",
      model: "claude-sonnet-4-6",
    });
    expect(out).toBeNull();
  });

  it("produces a composed preamble + delta metrics when sections exist", () => {
    const longMemory = "memory content. ".repeat(200);
    const actualPrompt = `${longMemory}\n\nFOCUS_BLOCK\nDIGEST`;
    const out = runShadowComposer({
      context: {
        combyneMemoryPreamble: { body: longMemory, entryCount: 1, scope: "agent" },
        combyneFocusDirective: { body: "FOCUS_BLOCK", directive: "stay" },
        combyneAssignedIssues: { digestBody: "DIGEST" },
      },
      adapterType: "claude-local",
      adapterConfig: { contextBudgetTokens: 5_000 },
      actualPrompt,
      model: "claude-sonnet-4-6",
    });
    expect(out).not.toBeNull();
    expect(out!.composed.totalTokens).toBeGreaterThan(0);
    expect(out!.actualPromptTokens).toBeGreaterThan(0);
    expect(out!.composed.body).toContain("FOCUS_BLOCK");
    expect(out!.composed.body).toContain("DIGEST");
    // cache prefix should include memory (cache-stable) but not focus/queue.
    expect(out!.composed.cachePrefix).toContain("memory content");
    expect(out!.composed.cachePrefix).not.toContain("FOCUS_BLOCK");
  });

  it("hashes to the same cache prefix across runs when stable content unchanged", () => {
    const ctx = (focus: string) => ({
      combyneMemoryPreamble: { body: "stable memory", entryCount: 1, scope: "agent" },
      combyneFocusDirective: { body: focus, directive: "x" },
    });
    const a = runShadowComposer({
      context: ctx("focus-1"),
      adapterType: "claude-local",
      adapterConfig: {},
      actualPrompt: "p1",
      model: "claude-sonnet-4-6",
    });
    const b = runShadowComposer({
      context: ctx("focus-2-entirely-different-text"),
      adapterType: "claude-local",
      adapterConfig: {},
      actualPrompt: "p2",
      model: "claude-sonnet-4-6",
    });
    expect(a?.composed.cachePrefixHash).toBe(b?.composed.cachePrefixHash);
  });
});
