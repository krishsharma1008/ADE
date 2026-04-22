import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  renderRecentTurns,
  unsummarizedTokensFor,
} from "../summarizer-triggers.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("summarizer-triggers", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Triggers Test Co" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  async function seed(label: string, turns: number, perTurnChars = 400) {
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: `Agent-${label}`, adapterType: "process" })
      .returning();
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: `Issue ${label}` })
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
    for (let i = 0; i < turns; i++) {
      await appendTranscriptEntry(handle.db, {
        companyId,
        agentId: agent.id,
        runId: run.id,
        issueId: issue.id,
        seq: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: { message: "x".repeat(perTurnChars) + ` turn-${i}` },
      });
    }
    return { agentId: agent.id, issueId: issue.id, runId: run.id };
  }

  it("counts un-summarized tokens and entries", async () => {
    const { agentId, issueId } = await seed("count", 10);
    const working = await unsummarizedTokensFor(handle.db, {
      companyId,
      agentId,
      scope: "working",
      issueId,
      model: "claude-haiku-4-5",
    });
    expect(working.turnCount).toBe(10);
    expect(working.tokens).toBeGreaterThan(0);
    expect(working.cutoffOrdinal).toBeNull();
  });

  it("respects the cutoff from a prior summary row", async () => {
    const { agentId, issueId } = await seed("cutoff", 6);
    // Fake a prior summary whose cutoff covers the first 4 turns.
    const rows = await handle.db
      .select()
      .from(agentTranscripts)
      .where(eqBothSides(agentTranscripts, { agentId, issueId }))
      .orderBy(agentTranscripts.ordinal)
      .limit(4);
    const cutoff = Number(rows[rows.length - 1].ordinal);
    await handle.db.insert(transcriptSummaries).values({
      companyId,
      agentId,
      scopeKind: "working",
      scopeId: issueId,
      cutoffSeq: cutoff,
      content: "stub",
      structuredJson: { narrative: "n", currentStatus: "ok" },
      sourceInputTokens: 100,
      sourceTurnCount: 4,
      summarizerModel: "claude-haiku-4-5",
    });
    const after = await unsummarizedTokensFor(handle.db, {
      companyId,
      agentId,
      scope: "working",
      issueId,
      model: "claude-haiku-4-5",
    });
    expect(after.turnCount).toBe(2);
    expect(after.cutoffOrdinal).toBe(cutoff);
  });

  it("pruningMode=additive includes ALL turns even when a summary covers them", async () => {
    const { agentId, issueId } = await seed("additive", 6);
    const rows = await handle.db
      .select()
      .from(agentTranscripts)
      .where(eqBothSides(agentTranscripts, { agentId, issueId }))
      .orderBy(agentTranscripts.ordinal)
      .limit(4);
    const cutoff = Number(rows[rows.length - 1].ordinal);
    await handle.db.insert(transcriptSummaries).values({
      companyId,
      agentId,
      scopeKind: "working",
      scopeId: issueId,
      cutoffSeq: cutoff,
      content: "stub",
      structuredJson: { narrative: "n", currentStatus: "ok" },
      sourceInputTokens: 100,
      sourceTurnCount: 4,
      summarizerModel: "claude-haiku-4-5",
    });
    const aggressive = await unsummarizedTokensFor(handle.db, {
      companyId,
      agentId,
      scope: "working",
      issueId,
      model: "claude-haiku-4-5",
      pruningMode: "aggressive",
    });
    const additive = await unsummarizedTokensFor(handle.db, {
      companyId,
      agentId,
      scope: "working",
      issueId,
      model: "claude-haiku-4-5",
      pruningMode: "additive",
    });
    expect(aggressive.turnCount).toBe(2);
    expect(additive.turnCount).toBe(6);
    // The cutoffOrdinal is informational (from the summary row) and
    // shouldn't change with pruning mode.
    expect(additive.cutoffOrdinal).toBe(cutoff);
  });

  it("renderRecentTurns keeps tail within token cap and includes role headers", async () => {
    const { agentId, issueId } = await seed("render", 6);
    const state = await unsummarizedTokensFor(handle.db, {
      companyId,
      agentId,
      scope: "working",
      issueId,
      model: "claude-haiku-4-5",
    });
    const rendered = renderRecentTurns(state.entries, "claude-haiku-4-5", {
      maxTokens: 200,
    });
    expect(rendered.turnCount).toBeGreaterThan(0);
    expect(rendered.turnCount).toBeLessThanOrEqual(6);
    // The block should always end with the newest turn (turn-5).
    expect(rendered.body).toContain("turn-5");
    expect(rendered.body).toMatch(/### (user|assistant) · ord=/);
    // Approximate token cap respected.
    expect(rendered.tokens).toBeLessThanOrEqual(260);
  });

  it("scope=standing ignores issue filter", async () => {
    const { agentId, issueId } = await seed("standing", 3);
    // Second issue under same agent.
    const [other] = await handle.db
      .insert(issues)
      .values({ companyId, title: "other" })
      .returning();
    const [otherRun] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "done",
        invocationSource: "on_demand",
        contextSnapshot: { issueId: other.id },
      })
      .returning();
    for (let i = 0; i < 3; i++) {
      await appendTranscriptEntry(handle.db, {
        companyId,
        agentId,
        runId: otherRun.id,
        issueId: other.id,
        seq: i,
        role: "user",
        content: { message: "y".repeat(300) + ` ${i}` },
      });
    }
    const standing = await unsummarizedTokensFor(handle.db, {
      companyId,
      agentId,
      scope: "standing",
      model: "claude-haiku-4-5",
    });
    expect(standing.turnCount).toBe(6);
    void issueId;
  });
});

import { and, eq } from "drizzle-orm";

function eqBothSides(table: typeof agentTranscripts, opts: { agentId: string; issueId: string }) {
  return and(eq(table.agentId, opts.agentId), eq(table.issueId, opts.issueId))!;
}
