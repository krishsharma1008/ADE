import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, issues } from "@combyne/db";
import { buildTerminalContextPreamble } from "../terminal-sessions.js";
import { upsertMemory } from "../agent-memory.js";
import { createHandoff } from "../agent-handoff.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("terminal-sessions: buildTerminalContextPreamble", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentAId: string;
  let agentBId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Terminal Context Co" })
      .returning();
    companyId = company.id;
    const [a] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-Terminal-A", adapterType: "claude_local" })
      .returning();
    const [b] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-Terminal-B", adapterType: "claude_local" })
      .returning();
    agentAId = a.id;
    agentBId = b.id;

    // Assign an open issue and a done one to Agent-A.
    await handle.db.insert(issues).values([
      {
        companyId,
        title: "Dashboards should load without 500s",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentAId,
      },
      {
        companyId,
        title: "Old completed task",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentAId,
      },
    ]);
    await upsertMemory(handle.db, {
      companyId,
      agentId: agentAId,
      scope: "agent",
      kind: "summary",
      title: "Agent summary",
      body: "Previously investigated the 500s — narrowed down to the onboarding query.",
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("includes company, task queue, and memory in the preamble", async () => {
    const preamble = await buildTerminalContextPreamble(handle.db, {
      id: agentAId,
      companyId,
      name: "Agent-Terminal-A",
      adapterType: "claude_local",
    });
    expect(preamble).not.toBeNull();
    expect(preamble!.body).toMatch(/Terminal Context Co/);
    expect(preamble!.body).toMatch(/Your current task queue/);
    expect(preamble!.body).toMatch(/Dashboards should load without 500s/);
    expect(preamble!.body).not.toMatch(/Old completed task/);
    expect(preamble!.body).toMatch(/Recent memory/);
    expect(preamble!.body).toMatch(/onboarding query/);
  });

  it("includes pending handoff brief when one exists for the target agent", async () => {
    // Create a shared issue for handoff.
    const [shared] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Needs handoff analysis",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentBId,
      })
      .returning();

    const handoff = await createHandoff(handle.db, {
      companyId,
      issueId: shared.id,
      fromAgentId: agentAId,
      toAgentId: agentBId,
    });
    expect(handoff).not.toBeNull();

    const preamble = await buildTerminalContextPreamble(handle.db, {
      id: agentBId,
      companyId,
      name: "Agent-Terminal-B",
      adapterType: "claude_local",
    });
    expect(preamble).not.toBeNull();
    expect(preamble!.body).toMatch(/Pending handoff brief/);
    expect(preamble!.body).toMatch(/Handoff — Issue/);
  });
});
