import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentTranscripts,
  companies,
  heartbeatRuns,
  issues,
  transcriptSummaries,
} from "@combyne/db";
import { appendTranscriptEntry } from "../agent-transcripts.js";
import {
  parseStructured,
  renderStandingSummary,
  renderWorkingSummary,
  stripMarkdownFence,
  summarizeAgentTranscript,
  type SummarizerDriver,
  type SummarizerDriverInput,
  type SummarizerDriverOutput,
} from "../transcript-summarizer.js";
import { getFailureRow } from "../summarizer-failures.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

function makeDriver(
  responses: string[] | ((input: SummarizerDriverInput, call: number) => string | Error),
  tokens: { input?: number; output?: number } = {},
): SummarizerDriver & { calls: SummarizerDriverInput[] } {
  const calls: SummarizerDriverInput[] = [];
  let counter = 0;
  return {
    calls,
    async invoke(input: SummarizerDriverInput): Promise<SummarizerDriverOutput> {
      calls.push(input);
      const idx = counter++;
      const next = Array.isArray(responses)
        ? responses[Math.min(idx, responses.length - 1)]
        : responses(input, idx);
      if (next instanceof Error) throw next;
      return { raw: next, inputTokens: tokens.input, outputTokens: tokens.output };
    },
  };
}

const STANDING_JSON = JSON.stringify({
  activeTickets: [{ ticketId: "BUK-23", title: "Login bug", status: "in_progress" }],
  userPreferences: ["prefer concise responses"],
  repoConventions: ["use conventional commits"],
  infraQuirks: [],
  skillsExercised: ["debugging"],
  recentFacts: ["deployed v1.2 on Tuesday"],
  narrative: "The agent has been working on login issues and tracking user prefs.",
});

const WORKING_JSON = JSON.stringify({
  ticketId: "BUK-23",
  title: "Login bug",
  currentStatus: "in_progress",
  attemptsMade: [{ approach: "clear cookies", outcome: "no change", reason: "not cookie-related" }],
  filesExamined: ["src/auth.ts"],
  filesModified: [],
  commandsRun: ["pnpm test"],
  decisionsMade: ["skip the cache layer"],
  blockers: [],
  openQuestions: ["does SSO path matter"],
  nextStepPlan: "reproduce with SSO flow",
  lastUserMessage: "please keep going",
  narrative: "Investigation ongoing; no repro yet.",
});

describe("transcript-summarizer (unit)", () => {
  it("stripMarkdownFence handles bare JSON, fenced JSON, and fenced with lang tag", () => {
    expect(stripMarkdownFence('{"a":1}')).toBe('{"a":1}');
    expect(stripMarkdownFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripMarkdownFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("parseStructured enforces required fields per scope", () => {
    const okStanding = parseStructured(STANDING_JSON, "standing");
    expect(okStanding.ok).toBe(true);
    const missing = parseStructured(JSON.stringify({ activeTickets: [] }), "standing");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/missing_required: narrative/);

    const okWorking = parseStructured(WORKING_JSON, "working");
    expect(okWorking.ok).toBe(true);
    const noStatus = parseStructured(
      JSON.stringify({ narrative: "x" }),
      "working",
    );
    expect(noStatus.ok).toBe(false);
  });

  it("parseStructured rejects non-object payloads", () => {
    expect(parseStructured("[]", "standing").ok).toBe(false);
    expect(parseStructured("nope", "working").ok).toBe(false);
    expect(parseStructured('"just a string"', "working").ok).toBe(false);
  });

  it("renderers are deterministic across identical inputs", () => {
    const parsed = parseStructured(STANDING_JSON, "standing");
    if (!parsed.ok) throw new Error("fixture bad");
    const a = renderStandingSummary(parsed.value);
    const b = renderStandingSummary(parsed.value);
    expect(a).toBe(b);
    expect(a).toContain("# Standing knowledge");
    expect(a).toContain("BUK-23");
    expect(a).toContain("User preferences");

    const pw = parseStructured(WORKING_JSON, "working");
    if (!pw.ok) throw new Error("fixture bad");
    const w = renderWorkingSummary(pw.value);
    expect(w).toContain("# Working summary");
    expect(w).toContain("Current status");
    expect(w).toContain("Next step plan");
  });

  it("renderers quietly skip absent sections", () => {
    const minimal = { narrative: "only narrative" };
    const s = renderStandingSummary(minimal);
    expect(s).toContain("only narrative");
    expect(s).not.toContain("User preferences");
  });
});

describe("summarizeAgentTranscript (integration)", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Summarizer Test Co" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  // Each case uses its own agent+issue so one test's summary cutoff doesn't
  // leak into the next case's "unsummarized range."
  async function seedScenario(opts: { turns: number; bodyLen: number; name: string }) {
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: opts.name, adapterType: "process" })
      .returning();
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: `${opts.name} issue` })
      .returning();
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: agent.id,
        status: "done",
        invocationSource: "on_demand",
        contextSnapshot: { issueId: issue.id },
      })
      .returning();
    for (let i = 0; i < opts.turns; i++) {
      await appendTranscriptEntry(handle.db, {
        companyId,
        agentId: agent.id,
        runId: run.id,
        issueId: issue.id,
        seq: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: { message: "a".repeat(opts.bodyLen) + ` turn-${i}` },
      });
    }
    return { agentId: agent.id, issueId: issue.id };
  }

  it("skips when unsummarized tokens fall below the trigger", async () => {
    const { agentId } = await seedScenario({ turns: 2, bodyLen: 10, name: "Agent-Trigger" });
    const driver = makeDriver([STANDING_JSON]);
    const result = await summarizeAgentTranscript(handle.db, driver, {
      companyId,
      agentId,
      scope: "standing",
      adapterModel: "claude-haiku-4-5",
      minTriggerTokens: 5_000,
    });
    expect(result.status).toBe("skipped_below_trigger");
    expect(driver.calls.length).toBe(0);
  });

  it("skips when cost estimate exceeds the cap", async () => {
    const { agentId } = await seedScenario({ turns: 50, bodyLen: 2_000, name: "Agent-CostGate" });
    const driver = makeDriver([STANDING_JSON]);
    const result = await summarizeAgentTranscript(handle.db, driver, {
      companyId,
      agentId,
      scope: "standing",
      adapterModel: "claude-haiku-4-5",
      minTriggerTokens: 10,
      maxCostUsd: 0.0000001,
    });
    expect(result.status).toBe("skipped_cost_gate");
    expect(driver.calls.length).toBe(0);
  });

  it("creates a summary row when driver returns valid JSON", async () => {
    const { agentId } = await seedScenario({ turns: 20, bodyLen: 500, name: "Agent-Created" });
    const driver = makeDriver([STANDING_JSON], { input: 5_000, output: 400 });
    const result = await summarizeAgentTranscript(handle.db, driver, {
      companyId,
      agentId,
      scope: "standing",
      adapterModel: "claude-haiku-4-5",
      summarizerModel: "claude-haiku-4-5",
      minTriggerTokens: 10,
      maxCostUsd: 10,
    });
    expect(result.status).toBe("created");
    expect(result.summaryId).toBeDefined();
    expect(result.cutoffSeq).toBeGreaterThan(0);
    expect(driver.calls.length).toBe(1);

    const rows = await handle.db
      .select()
      .from(transcriptSummaries)
      .where(eq(transcriptSummaries.agentId, agentId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[rows.length - 1];
    expect(row.scopeKind).toBe("standing");
    expect(row.summarizerModel).toBe("claude-haiku-4-5");
    expect(row.content).toContain("# Standing knowledge");
  });

  it("retries once when the first response isn't valid JSON", async () => {
    const { agentId, issueId } = await seedScenario({
      turns: 20,
      bodyLen: 500,
      name: "Agent-Retry",
    });
    const driver = makeDriver(["not json", WORKING_JSON], { input: 1_000, output: 300 });
    const result = await summarizeAgentTranscript(handle.db, driver, {
      companyId,
      agentId,
      scope: "working",
      issueId,
      adapterModel: "claude-haiku-4-5",
      summarizerModel: "claude-haiku-4-5",
      minTriggerTokens: 10,
      maxCostUsd: 10,
    });
    expect(result.status).toBe("created");
    expect(driver.calls.length).toBe(2);
    expect(driver.calls[1].userPrompt).toMatch(/not valid JSON/i);
  });

  it("gives up after two bad responses and records a failure", async () => {
    const { agentId } = await seedScenario({ turns: 20, bodyLen: 500, name: "Agent-Exhaust" });
    const driver = makeDriver(["still not json", "still not json"]);
    const result = await summarizeAgentTranscript(handle.db, driver, {
      companyId,
      agentId,
      scope: "standing",
      adapterModel: "claude-haiku-4-5",
      minTriggerTokens: 10,
      maxCostUsd: 10,
    });
    expect(result.status).toBe("skipped_parse_retry_exhausted");
    expect(driver.calls.length).toBe(2);
    const row = await getFailureRow(handle.db, {
      agentId,
      scopeKind: "standing",
      scopeId: null,
    });
    expect(row?.consecutiveFailures).toBeGreaterThanOrEqual(1);
  });

  it("working scope without issueId is rejected up-front", async () => {
    const { agentId } = await seedScenario({ turns: 2, bodyLen: 50, name: "Agent-NoIssue" });
    const driver = makeDriver([WORKING_JSON]);
    const result = await summarizeAgentTranscript(handle.db, driver, {
      companyId,
      agentId,
      scope: "working",
      adapterModel: "claude-haiku-4-5",
      minTriggerTokens: 10,
    });
    expect(result.status).toBe("skipped_invalid_input");
    expect(driver.calls.length).toBe(0);
  });

  it("does not count insert_error toward the quarantine counter", async () => {
    const { agentId } = await seedScenario({
      turns: 20,
      bodyLen: 500,
      name: "Agent-InsertErr",
    });
    const driver = makeDriver([STANDING_JSON], { input: 500, output: 200 });

    // Wrap the db in a Proxy that makes the first `insert(transcriptSummaries)`
    // call throw a synthetic transient DB error. Everything else passes through.
    let thrown = false;
    const dbProxy = new Proxy(handle.db, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (!thrown && table === transcriptSummaries) {
              thrown = true;
              return {
                values: () => ({
                  returning: () => Promise.reject(new Error("connection reset by peer")),
                }),
              };
            }
            return (target as typeof handle.db).insert(table as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof handle.db;

    const result = await summarizeAgentTranscript(dbProxy, driver, {
      companyId,
      agentId,
      scope: "standing",
      adapterModel: "claude-haiku-4-5",
      summarizerModel: "claude-haiku-4-5",
      minTriggerTokens: 10,
      maxCostUsd: 10,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/connection reset/);
    const row = await getFailureRow(handle.db, {
      agentId,
      scopeKind: "standing",
      scopeId: null,
    });
    expect(row).toBeNull();
  });

  it("returns skipped_quarantined after the 3rd failure", async () => {
    const { agentId, issueId } = await seedScenario({
      turns: 20,
      bodyLen: 500,
      name: "Agent-Quarantine",
    });
    const driver = makeDriver(["bad", "bad"]);
    for (let i = 0; i < 3; i++) {
      const r = await summarizeAgentTranscript(handle.db, driver, {
        companyId,
        agentId,
        scope: "working",
        issueId,
        adapterModel: "claude-haiku-4-5",
        minTriggerTokens: 10,
        maxCostUsd: 10,
      });
      expect(r.status).toBe("skipped_parse_retry_exhausted");
    }
    const driver2 = makeDriver([WORKING_JSON]);
    const next = await summarizeAgentTranscript(handle.db, driver2, {
      companyId,
      agentId,
      scope: "working",
      issueId,
      adapterModel: "claude-haiku-4-5",
      minTriggerTokens: 10,
      maxCostUsd: 10,
    });
    expect(next.status).toBe("skipped_quarantined");
    expect(driver2.calls.length).toBe(0);
  });
});
