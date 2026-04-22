import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { agents, agentTranscripts, companies, heartbeatRuns, issues } from "@combyne/db";
import {
  appendTranscriptEntry,
  extractCountableText,
  loadRecentTranscript,
  loadRunTranscript,
  loadTranscriptSince,
} from "../agent-transcripts.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("agent-transcripts (Phase C)", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let runId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Transcripts Test Co" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-Tx", adapterType: "process" })
      .returning();
    agentId = agent.id;
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Tx test issue" })
      .returning();
    issueId = issue.id;
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "done", invocationSource: "on_demand" })
      .returning();
    runId = run.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("persists every TranscriptRole with monotonic seq", async () => {
    const roles = ["system", "user", "assistant", "tool_call", "tool_result", "stderr", "lifecycle"] as const;
    for (const [idx, role] of roles.entries()) {
      await appendTranscriptEntry(handle.db, {
        companyId,
        agentId,
        runId,
        issueId,
        seq: idx,
        role,
        content: { message: `message ${idx} for ${role}` },
      });
    }

    const rows = await handle.db
      .select()
      .from(agentTranscripts)
      .where(eq(agentTranscripts.runId, runId))
      .orderBy(asc(agentTranscripts.seq));

    expect(rows).toHaveLength(roles.length);
    expect(rows.map((r) => r.role)).toEqual([...roles]);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i));
    for (const row of rows) {
      expect(row.companyId).toBe(companyId);
      expect(row.agentId).toBe(agentId);
      expect(row.issueId).toBe(issueId);
      expect((row.content as { message: string }).message).toMatch(/message \d+ for/);
    }
  });

  it("loadRunTranscript returns entries ordered by seq", async () => {
    const rows = await loadRunTranscript(handle.db, runId);
    expect(rows.length).toBeGreaterThan(0);
    const seqs = rows.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("loadRecentTranscript scopes by agent + issue", async () => {
    const rows = await loadRecentTranscript(handle.db, {
      companyId,
      agentId,
      issueId,
      limit: 50,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.companyId).toBe(companyId);
      expect(row.agentId).toBe(agentId);
    }
  });

  it("assigns a monotonic global ordinal even when seq resets per run", async () => {
    const [secondRun] = await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "done", invocationSource: "on_demand" })
      .returning();
    await appendTranscriptEntry(handle.db, {
      companyId,
      agentId,
      runId: secondRun.id,
      issueId,
      seq: 0,
      role: "user",
      content: { message: "second-run turn 1" },
    });
    await appendTranscriptEntry(handle.db, {
      companyId,
      agentId,
      runId: secondRun.id,
      issueId,
      seq: 1,
      role: "assistant",
      content: { message: "second-run turn 2" },
    });
    const rows = await handle.db
      .select()
      .from(agentTranscripts)
      .orderBy(asc(agentTranscripts.ordinal));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const ordinals = rows.map((r) => Number(r.ordinal));
    const sorted = [...ordinals].sort((a, b) => a - b);
    expect(ordinals).toEqual(sorted);
    // Ordinals are unique — nothing collapses when seq resets.
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it("loadTranscriptSince returns rows strictly greater than sinceOrdinal", async () => {
    const before = await loadTranscriptSince(handle.db, { companyId, agentId });
    expect(before.entries.length).toBeGreaterThan(0);
    const middle = before.entries[Math.floor(before.entries.length / 2)];
    const since = await loadTranscriptSince(handle.db, {
      companyId,
      agentId,
      sinceOrdinal: middle.ordinal,
    });
    expect(since.entries.length).toBeGreaterThan(0);
    for (const entry of since.entries) {
      expect(entry.ordinal).toBeGreaterThan(middle.ordinal);
    }
  });

  it("loadTranscriptSince with issueId includes null-issue rows from runs bound to that issue", async () => {
    // Create an isolated agent + issue so we can control the fixture.
    const [localAgent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-Tx-Scope", adapterType: "process" })
      .returning();
    const [localIssue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Scope test issue" })
      .returning();
    const [boundRun] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: localAgent.id,
        status: "done",
        invocationSource: "on_demand",
        contextSnapshot: { issueId: localIssue.id },
      })
      .returning();
    // Tagged row — the direct match.
    await appendTranscriptEntry(handle.db, {
      companyId,
      agentId: localAgent.id,
      runId: boundRun.id,
      issueId: localIssue.id,
      seq: 0,
      role: "user",
      content: { message: "tagged row" },
    });
    // Untagged row from the same bound run — should still be included.
    await appendTranscriptEntry(handle.db, {
      companyId,
      agentId: localAgent.id,
      runId: boundRun.id,
      issueId: null,
      seq: 1,
      role: "assistant",
      content: { message: "untagged row from bound run" },
    });
    // Completely untagged row from an unrelated run — should NOT be included.
    const [otherRun] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: localAgent.id,
        status: "done",
        invocationSource: "on_demand",
      })
      .returning();
    await appendTranscriptEntry(handle.db, {
      companyId,
      agentId: localAgent.id,
      runId: otherRun.id,
      issueId: null,
      seq: 0,
      role: "user",
      content: { message: "unrelated untagged row" },
    });

    const scoped = await loadTranscriptSince(handle.db, {
      companyId,
      agentId: localAgent.id,
      issueId: localIssue.id,
    });
    const messages = scoped.entries.map((e) => (e.content as { message: string }).message);
    expect(messages).toContain("tagged row");
    expect(messages).toContain("untagged row from bound run");
    expect(messages).not.toContain("unrelated untagged row");
  });

  it("extractCountableText excludes adapter.invoke/result heavy payloads", () => {
    const invokeEntry = {
      id: "a",
      ordinal: 1,
      seq: 0,
      runId: null,
      issueId: null,
      terminalSessionId: null,
      role: "assistant",
      contentKind: "adapter.invoke",
      content: { prompt: "x".repeat(10_000) },
      createdAt: new Date(),
    };
    const userEntry = {
      ...invokeEntry,
      role: "user",
      contentKind: null,
      content: { message: "hello" },
    };
    expect(extractCountableText(invokeEntry)).toBe("");
    expect(extractCountableText(userEntry)).toBe(JSON.stringify({ message: "hello" }));
  });
});
