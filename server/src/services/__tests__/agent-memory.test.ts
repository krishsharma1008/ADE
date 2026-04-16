import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentMemory, companies, heartbeatRuns, issues } from "@combyne/db";
import { appendTranscriptEntry } from "../agent-transcripts.js";
import { loadRecentMemory, summarizeRunAndPersist } from "../agent-memory.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("agent-memory (Phase C)", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  async function createRun(): Promise<string> {
    const [row] = await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "done", invocationSource: "on_demand" })
      .returning();
    return row.id;
  }

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Memory Test Co" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-Mem", adapterType: "process" })
      .returning();
    agentId = agent.id;
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Memory test issue" })
      .returning();
    issueId = issue.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("summarizeRunAndPersist lands a summary row at scope='issue' and scope='agent'", async () => {
    const runId = await createRun();
    for (let i = 0; i < 10; i++) {
      await appendTranscriptEntry(handle.db, {
        companyId,
        agentId,
        runId,
        issueId,
        seq: i,
        role: i % 2 === 0 ? "assistant" : "tool_call",
        content: { message: `entry ${i}` },
      });
    }

    await summarizeRunAndPersist(handle.db, { runId, companyId, agentId, issueId });

    const rows = await handle.db
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.sourceRunId, runId));
    const scopes = rows.map((r) => r.scope).sort();
    expect(scopes).toContain("issue");
    expect(scopes).toContain("agent");
    const issueSummary = rows.find((r) => r.scope === "issue");
    expect(issueSummary?.kind).toBe("summary");
    expect(issueSummary?.body).toMatch(/transcript entries/);
  });

  it("loadRecentMemory returns the summary scoped by agent+issue", async () => {
    const rows = await loadRecentMemory(handle.db, {
      companyId,
      agentId,
      issueId,
      scope: "issue",
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].body).toMatch(/transcript entries/);
  });

  it("skips summarization when transcript has fewer than minEntries", async () => {
    const runId = await createRun();
    for (let i = 0; i < 2; i++) {
      await appendTranscriptEntry(handle.db, {
        companyId,
        agentId,
        runId,
        issueId,
        seq: i,
        role: "assistant",
        content: { message: `short ${i}` },
      });
    }
    await summarizeRunAndPersist(handle.db, { runId, companyId, agentId, issueId, minEntries: 3 });
    const rows = await handle.db
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.sourceRunId, runId));
    expect(rows).toHaveLength(0);
  });
});
