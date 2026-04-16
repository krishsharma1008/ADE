import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentHandoffs, companies, issues } from "@combyne/db";
import { createHandoff, getPendingHandoffBrief, markHandoffConsumed } from "../agent-handoff.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("agent-handoff (Phase C)", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentA: string;
  let agentB: string;
  let issueId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Handoff Test Co" })
      .returning();
    companyId = company.id;

    const [a] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-A", adapterType: "process" })
      .returning();
    const [b] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-B", adapterType: "process" })
      .returning();
    agentA = a.id;
    agentB = b.id;

    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Handoff test issue",
        description: "Investigate the X regression and propose a fix.",
      })
      .returning();
    issueId = issue.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("createHandoff writes a row with non-empty brief and default empty arrays", async () => {
    const row = await createHandoff(handle.db, {
      companyId,
      issueId,
      fromAgentId: agentA,
      toAgentId: agentB,
    });
    expect(row).not.toBeNull();
    expect(row!.brief.length).toBeGreaterThan(0);
    expect(row!.brief).toMatch(/Handoff — Issue/);
    expect(row!.brief).toMatch(/Investigate the X regression/);
    expect(row!.toAgentId).toBe(agentB);
    expect(row!.fromAgentId).toBe(agentA);
    expect(row!.artifactRefs).toEqual([]);
    expect(Array.isArray(row!.openQuestions)).toBe(true);
  });

  it("getPendingHandoffBrief returns the unconsumed handoff, markHandoffConsumed retires it", async () => {
    const pending = await getPendingHandoffBrief(handle.db, agentB, issueId);
    expect(pending).not.toBeNull();
    expect(pending!.consumedAt).toBeNull();

    await markHandoffConsumed(handle.db, pending!.id);

    const after = await getPendingHandoffBrief(handle.db, agentB, issueId);
    expect(after).toBeNull();

    const rows = await handle.db
      .select()
      .from(agentHandoffs)
      .where(eq(agentHandoffs.id, pending!.id));
    expect(rows[0]?.consumedAt).not.toBeNull();
  });
});
