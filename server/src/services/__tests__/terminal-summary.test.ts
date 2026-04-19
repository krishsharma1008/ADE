import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentMemory,
  agentTerminalSessions,
  agentTranscripts,
  agents,
  companies,
  issues,
} from "@combyne/db";
import { appendTranscriptEntry } from "../agent-transcripts.js";
import { summarizeTerminalSessionAndPersist } from "../agent-memory.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

/**
 * Regression for the switchover gap: a long terminal session would write
 * transcripts but never surface in agent_memory, so the next heartbeat wake
 * started with no idea what the user had just discussed. closeSession now
 * calls summarizeTerminalSessionAndPersist — this test exercises the
 * summarizer directly + asserts both agent-scope and issue-scope rows land.
 */
describe("agent-memory: summarizeTerminalSessionAndPersist", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let terminalSessionId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Terminal Summary Co" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "terminal-summary-agent", adapterType: "claude_local" })
      .returning();
    agentId = agent.id;
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Terminal session target issue",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        originKind: "terminal_session",
      })
      .returning();
    issueId = issue.id;
    const [session] = await handle.db
      .insert(agentTerminalSessions)
      .values({
        companyId,
        agentId,
        mode: "cli",
        command: "claude --dangerously-skip-permissions",
        cwd: "/tmp/test-workspace",
        status: "running",
      })
      .returning();
    terminalSessionId = session.id;

    // Seed a realistic multi-turn transcript: user prompts + assistant output.
    const turns: Array<{ role: "user" | "assistant"; message: string; kind: string }> = [
      { role: "user", message: "investigate the failing onboarding query", kind: "terminal.prompt" },
      {
        role: "assistant",
        message: "Read /opt/project/src/onboarding.ts; the JOIN on company_memberships is missing a status filter.",
        kind: "terminal.output",
      },
      { role: "user", message: "add the status filter and rerun the test", kind: "terminal.prompt" },
      {
        role: "assistant",
        message: "Patched, test passes. ready for a commit?",
        kind: "terminal.output",
      },
      { role: "user", message: "commit as 'fix: scope onboarding to active memberships'", kind: "terminal.prompt" },
    ];
    for (const [idx, turn] of turns.entries()) {
      await appendTranscriptEntry(handle.db, {
        companyId,
        agentId,
        terminalSessionId,
        issueId,
        seq: idx,
        role: turn.role,
        contentKind: turn.kind,
        content: { message: turn.message },
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("writes an issue-scoped summary row containing the conversation highlights", async () => {
    await summarizeTerminalSessionAndPersist(handle.db, {
      terminalSessionId,
      companyId,
      agentId,
      issueId,
    });

    const issueMemory = await handle.db
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.issueId, issueId)));
    expect(issueMemory.length).toBeGreaterThan(0);
    const body = issueMemory.map((row) => row.body).join("\n");
    expect(body).toMatch(/onboarding query/);
    expect(body).toMatch(/status filter/);
    expect(body).toMatch(/user/);
    expect(body).toMatch(/assistant/);
  });

  it("writes an agent-scoped summary row so the summary surfaces cross-issue", async () => {
    const agentMemoryRows = await handle.db
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.scope, "agent")));
    expect(agentMemoryRows.length).toBeGreaterThan(0);
    expect(agentMemoryRows[0].title).toMatch(/Agent terminal session summary/);
  });

  it("skips summarization for trivial transcripts (minEntries gate)", async () => {
    const [emptyIssue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Empty session issue",
        status: "backlog",
        assigneeAgentId: agentId,
      })
      .returning();
    const [emptySession] = await handle.db
      .insert(agentTerminalSessions)
      .values({
        companyId,
        agentId,
        mode: "cli",
        command: "claude",
        cwd: "/tmp/test-workspace",
        status: "running",
      })
      .returning();

    // Only 1 turn — below the min-entries threshold.
    await appendTranscriptEntry(handle.db, {
      companyId,
      agentId,
      terminalSessionId: emptySession.id,
      issueId: emptyIssue.id,
      seq: 0,
      role: "user",
      contentKind: "terminal.prompt",
      content: { message: "hi" },
    });

    await summarizeTerminalSessionAndPersist(handle.db, {
      terminalSessionId: emptySession.id,
      companyId,
      agentId,
      issueId: emptyIssue.id,
    });

    const rows = await handle.db
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.issueId, emptyIssue.id));
    expect(rows.length).toBe(0);

    // Clean up so other tests don't count these rows.
    await handle.db.delete(agentTranscripts).where(eq(agentTranscripts.terminalSessionId, emptySession.id));
  });
});
