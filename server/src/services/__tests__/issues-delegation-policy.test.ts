import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, issueComments, issues } from "@combyne/db";
import { issueService } from "../issues.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("issue medium/large delegation policy", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let emAgentId: string;
  let engineerId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Delegation Policy", issuePrefix: "DP" })
      .returning();
    companyId = company.id;
    const [em] = await handle.db
      .insert(agents)
      .values({ companyId, name: "EM", role: "em", adapterType: "process" })
      .returning();
    const [engineer] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", role: "engineer", adapterType: "process" })
      .returning();
    emAgentId = em.id;
    engineerId = engineer.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("rejects medium coordinator completion until child work and verification exist", async () => {
    const svc = issueService(handle.db);
    const [parent] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Medium coordinator issue",
        status: "in_progress",
        complexity: "medium",
        assigneeAgentId: emAgentId,
      })
      .returning();

    await expect(svc.update(parent.id, { status: "done" })).rejects.toThrow(/delegated child issues/i);

    await handle.db.insert(issues).values({
      companyId,
      parentId: parent.id,
      title: "Child implementation",
      status: "done",
      complexity: "small",
      assigneeAgentId: engineerId,
    });

    await expect(svc.update(parent.id, { status: "done" })).rejects.toThrow(/verification comment/i);

    await handle.db.insert(issueComments).values({
      companyId,
      issueId: parent.id,
      authorAgentId: emAgentId,
      body: "Verification: child issue completed and tests passed.",
      kind: "comment",
    });

    const updated = await svc.update(parent.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("round-trips the additive service_scope column through create/read (PR-8)", async () => {
    const svc = issueService(handle.db);

    // Created without a service scope: column is nullable/additive, defaults to null.
    const created = await svc.create(companyId, {
      title: "Issue without service scope",
      assigneeAgentId: engineerId,
    });
    expect(created?.serviceScope ?? null).toBeNull();

    // Created with an explicit service scope: value is persisted and surfaced.
    const scoped = await svc.create(companyId, {
      title: "Issue scoped to a service",
      assigneeAgentId: engineerId,
      serviceScope: "payments-api",
    });
    expect(scoped?.serviceScope).toBe("payments-api");

    // Re-reading the row exposes serviceScope on the typed Issue (retrieval target).
    const reread = await svc.getById(scoped!.id);
    expect(reread?.serviceScope).toBe("payments-api");
  });
});

