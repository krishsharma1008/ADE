import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { agents, agentTranscripts, companies, heartbeatRuns, issues } from "@combyne/db";
import { appendTranscriptEntry, loadRecentTranscript, loadRunTranscript } from "../agent-transcripts.js";
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
});
