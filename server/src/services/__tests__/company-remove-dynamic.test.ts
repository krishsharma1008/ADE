// Company deletion (found live 2026-06-11): the hand-maintained dependency-
// ordered delete list in companyService.remove() rotted whenever a new
// company-scoped table shipped — agent_transcripts and issue_read_states both
// 500'd a live DELETE /companies/:id. remove() now discovers every public
// table with a company_id column and deletes multi-pass (savepoint per
// attempt), so new tables are covered automatically. This test seeds exactly
// the tables that broke live, plus the usual core rows.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentTranscripts,
  companies,
  heartbeatRuns,
  issueComments,
  issueReadStates,
  issues,
} from "@combyne/db";
import { companyService } from "../companies.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("companyService.remove — dynamic multi-pass delete", () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("deletes a company whose issues have read states and whose agents have transcripts", async () => {
    const db = handle.db;
    const [company] = await db
      .insert(companies)
      .values({ name: "Doomed Co", issuePrefix: "DOOM" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Engineer", adapterType: "process" })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Read ticket", status: "todo" })
      .returning();
    // The two tables that broke the live delete:
    await db.insert(issueReadStates).values({
      companyId: company.id,
      issueId: issue.id,
      userId: "local-board",
    });
    await db.insert(agentTranscripts).values({
      companyId: company.id,
      agentId: agent.id,
      seq: 1,
      ordinal: 1,
      role: "assistant",
      content: { text: "hello" },
    });
    // Plus ordinary dependents to exercise multi-pass ordering.
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: agent.id, status: "succeeded", invocationSource: "on_demand" })
      .returning();
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      body: "a comment",
      kind: "comment",
    });

    const removed = await companyService(db).remove(company.id);
    expect(removed?.id).toBe(company.id);

    const [companyGone] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(companyGone).toBeUndefined();
    const leftoverIssues = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(leftoverIssues).toHaveLength(0);
    const leftoverTranscripts = await db
      .select()
      .from(agentTranscripts)
      .where(eq(agentTranscripts.companyId, company.id));
    expect(leftoverTranscripts).toHaveLength(0);
    const leftoverReadStates = await db
      .select()
      .from(issueReadStates)
      .where(eq(issueReadStates.companyId, company.id));
    expect(leftoverReadStates).toHaveLength(0);
    const leftoverRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(leftoverRuns).toHaveLength(0);
  });

  it("leaves an unrelated company untouched", async () => {
    const db = handle.db;
    const [keeper] = await db
      .insert(companies)
      .values({ name: "Keeper Co", issuePrefix: "KEEP" })
      .returning();
    const [victim] = await db
      .insert(companies)
      .values({ name: "Victim Co", issuePrefix: "VIC" })
      .returning();
    await db.insert(issues).values({ companyId: keeper.id, title: "Keeper ticket", status: "todo" });

    await companyService(db).remove(victim.id);

    const keeperIssues = await db.select().from(issues).where(eq(issues.companyId, keeper.id));
    expect(keeperIssues).toHaveLength(1);
    const [keeperRow] = await db.select().from(companies).where(eq(companies.id, keeper.id));
    expect(keeperRow).toBeTruthy();
  });
});
