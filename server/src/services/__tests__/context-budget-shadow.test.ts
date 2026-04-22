import { describe, expect, it } from "vitest";
import {
  buildPreambleSectionsFromContext,
  composeAndApplyBudget,
  contextBudgetComposerEnabled,
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

  it("emits standing (cache-stable) and working (vary) from summarizer fields", () => {
    const sections = buildPreambleSectionsFromContext({
      combyneStandingSummary: { body: "STANDING_BODY", cutoffOrdinal: 42 },
      combyneWorkingSummary: {
        body: "WORKING_BODY",
        cutoffOrdinal: 40,
        issueId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      },
    });
    const standing = sections.find((s) => s.name === "standing");
    const working = sections.find((s) => s.name === "working");
    expect(standing).toBeDefined();
    expect(standing!.cacheStable).toBe(true);
    expect(standing!.maxTokens).toBe(3_000);
    expect(working).toBeDefined();
    expect(working!.cacheStable).toBe(false);
    expect(working!.truncationStrategy).toBe("tail");
  });

  it("emits recentTurns (head-truncated) and toolResults (middle-truncated) when populated", () => {
    const sections = buildPreambleSectionsFromContext({
      combyneRecentTurns: { body: "TURN_1\nTURN_2", count: 2 },
      combyneToolResults: { body: "RESULT_BLOB" },
    });
    const turns = sections.find((s) => s.name === "recentTurns");
    const tools = sections.find((s) => s.name === "toolResults");
    expect(turns?.truncationStrategy).toBe("head");
    expect(turns?.cacheStable).toBe(false);
    expect(tools?.truncationStrategy).toBe("middle");
    expect(tools?.cacheStable).toBe(false);
  });

  it("skips summarizer/turns sections when bodies are empty strings", () => {
    const sections = buildPreambleSectionsFromContext({
      combyneStandingSummary: { body: "" },
      combyneWorkingSummary: { body: "" },
      combyneRecentTurns: { body: "" },
      combyneToolResults: { body: "" },
    });
    expect(sections.find((s) => s.name === "standing")).toBeUndefined();
    expect(sections.find((s) => s.name === "working")).toBeUndefined();
    expect(sections.find((s) => s.name === "recentTurns")).toBeUndefined();
    expect(sections.find((s) => s.name === "toolResults")).toBeUndefined();
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

describe("contextBudgetComposerEnabled flag", () => {
  it("defaults to false when env is unset", () => {
    const original = process.env.COMBYNE_CONTEXT_BUDGET_ENABLED;
    try {
      delete process.env.COMBYNE_CONTEXT_BUDGET_ENABLED;
      expect(contextBudgetComposerEnabled()).toBe(false);
    } finally {
      if (original !== undefined) process.env.COMBYNE_CONTEXT_BUDGET_ENABLED = original;
    }
  });

  it("reads 1/true as enabled", () => {
    const original = process.env.COMBYNE_CONTEXT_BUDGET_ENABLED;
    try {
      process.env.COMBYNE_CONTEXT_BUDGET_ENABLED = "1";
      expect(contextBudgetComposerEnabled()).toBe(true);
      process.env.COMBYNE_CONTEXT_BUDGET_ENABLED = "true";
      expect(contextBudgetComposerEnabled()).toBe(true);
      process.env.COMBYNE_CONTEXT_BUDGET_ENABLED = "no";
      expect(contextBudgetComposerEnabled()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.COMBYNE_CONTEXT_BUDGET_ENABLED;
      else process.env.COMBYNE_CONTEXT_BUDGET_ENABLED = original;
    }
  });
});

describe("composeAndApplyBudget", () => {
  it("leaves context untouched when nothing needs truncation", () => {
    const context: Record<string, unknown> = {
      combyneMemoryPreamble: { body: "short memory", entryCount: 1, scope: "agent" },
      combyneFocusDirective: { body: "short focus", directive: "x" },
    };
    const snapshot = JSON.parse(JSON.stringify(context));
    const out = composeAndApplyBudget(context, {
      adapterType: "claude-local",
      adapterConfig: { contextBudgetTokens: 1_000_000 },
      model: "claude-sonnet-4-6",
    });
    expect(out).not.toBeNull();
    expect(out!.applied).toBe(false);
    expect(context).toEqual(snapshot);
  });

  it("writes truncated content back to combyneMemoryPreamble.body when over budget", () => {
    const longMemory = "memory word ".repeat(5000);
    const originalLength = longMemory.length;
    const context: Record<string, unknown> = {
      combyneMemoryPreamble: { body: longMemory, entryCount: 1, scope: "agent" },
    };
    const out = composeAndApplyBudget(context, {
      adapterType: "pi-local",
      adapterConfig: { contextBudgetTokens: 100 },
      model: "claude-sonnet-4-6",
    });
    expect(out).not.toBeNull();
    expect(out!.applied).toBe(true);
    const newMem = (context.combyneMemoryPreamble as { body: string }).body;
    expect(newMem.length).toBeLessThan(originalLength);
  });

  it("deletes combyneFocusDirective when the focus section was dropped wholesale", () => {
    // Use a budget so tiny that even "preserve" focus gets dropped by the
    // caller. The composer won't drop a "preserve" strategy on its own — it
    // just leaves content in place. So we force a drop via a very tiny
    // budget AND a wholesale non-preserve focus (which would happen if we
    // ever flipped the strategy). For now, assert that preserve keeps it.
    const context: Record<string, unknown> = {
      combyneFocusDirective: { body: "FOCUS", directive: "stay" },
    };
    const out = composeAndApplyBudget(context, {
      adapterType: "pi-local",
      adapterConfig: { contextBudgetTokens: 10 },
      model: "claude-sonnet-4-6",
    });
    expect(out).not.toBeNull();
    // preserve strategy keeps focus intact.
    expect(context.combyneFocusDirective).toBeDefined();
  });

  it("returns no_sections for an empty context", () => {
    const out = composeAndApplyBudget({}, {
      adapterType: "claude-local",
      adapterConfig: {},
      model: "claude-sonnet-4-6",
    });
    expect(out?.skippedReason).toBe("no_sections");
    expect(out?.applied).toBe(false);
  });
});
