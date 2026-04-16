import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, issues } from "@combyne/db";
import { upsertMemory, loadRecentMemory } from "../agent-memory.js";
import { createHandoff, getPendingHandoffBrief } from "../agent-handoff.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

/**
 * Integration test for the exact queries the heartbeat path at
 * heartbeat.ts:1133 (getPendingHandoffBrief) and heartbeat.ts:1172
 * (loadRecentMemory) rely on to assemble the preamble. A regression
 * here would mean the agent wakes up blind — no prior context, no
 * handoff brief.
 */
describe("heartbeat context injection (Phase C)", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentA: string;
  let agentB: string;
  let issueId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Context Injection Test Co" })
      .returning();
    companyId = company.id;

    const [a] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Ctx-A", adapterType: "process" })
      .returning();
    const [b] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Ctx-B", adapterType: "process" })
      .returning();
    agentA = a.id;
    agentB = b.id;

    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Carry this context forward" })
      .returning();
    issueId = issue.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("loadRecentMemory surfaces the prior agent's summary for the same issue", async () => {
    await upsertMemory(handle.db, {
      companyId,
      agentId: agentA,
      issueId,
      scope: "issue",
      kind: "summary",
      title: "Run summary (2026-04-17)",
      body: "Tried approach X — hit schema mismatch at column foo. Next: migrate foo to text.",
    });

    const rows = await loadRecentMemory(handle.db, {
      companyId,
      agentId: agentA,
      issueId,
      limit: 8,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].body).toMatch(/schema mismatch/);
    expect(rows[0].kind).toBe("summary");
    expect(rows[0].scope).toBe("issue");
  });

  it("getPendingHandoffBrief returns the brief for the incoming agent on handoff", async () => {
    const handoff = await createHandoff(handle.db, {
      companyId,
      issueId,
      fromAgentId: agentA,
      toAgentId: agentB,
    });
    expect(handoff).not.toBeNull();

    const pending = await getPendingHandoffBrief(handle.db, agentB, issueId);
    expect(pending).not.toBeNull();
    expect(pending!.id).toBe(handoff!.id);
    expect(pending!.brief).toMatch(/Handoff — Issue/);
    expect(pending!.brief).toMatch(/Carry this context forward/);
  });

  it("preamble assembly (memory + handoff) produces the expected shape for a wake", async () => {
    const memoryRows = await loadRecentMemory(handle.db, {
      companyId,
      agentId: agentB,
      issueId,
      limit: 8,
    });
    const handoff = await getPendingHandoffBrief(handle.db, agentB, issueId);

    const memoryPreamble =
      memoryRows.length > 0
        ? memoryRows
            .map((row) => {
              const header = row.title ? `## ${row.title}` : `## ${row.scope}/${row.kind}`;
              return `${header}\n${row.body}`;
            })
            .join("\n\n")
        : "";
    const handoffSection = handoff ? handoff.brief : "";

    const combined = [memoryPreamble, handoffSection].filter(Boolean).join("\n\n---\n\n");
    expect(combined).toMatch(/Handoff — Issue/);
  });
});
