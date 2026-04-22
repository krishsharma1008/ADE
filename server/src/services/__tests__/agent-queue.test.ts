import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, issues } from "@combyne/db";
import { loadAssignedIssueQueue } from "../agent-queue.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

/**
 * Regression coverage for Chris's "no tasks to run" feedback. The agent
 * queue helper drives context.combyneAssignedIssues at heartbeat wake;
 * if it silently drops assignments, the agent goes blind again.
 */
describe("agent-queue: loadAssignedIssueQueue", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let otherAgentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Queue Test Co" })
      .returning();
    companyId = company.id;
    const [a] = await handle.db
      .insert(agents)
      .values({ companyId, name: "queue-subject", adapterType: "process" })
      .returning();
    const [b] = await handle.db
      .insert(agents)
      .values({ companyId, name: "other-agent", adapterType: "process" })
      .returning();
    agentId = a.id;
    otherAgentId = b.id;

    // Seven issues: 5 assigned open covering every OPEN_ISSUE_STATUS
    // (backlog, todo, in_progress, in_review, awaiting_user), one done
    // (should NOT appear), one assigned to a different agent.
    // Round 3 adds todo + in_review coverage to catch the OPEN_STATUSES drift.
    await handle.db.insert(issues).values([
      {
        companyId,
        title: "open high-priority",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        companyId,
        title: "awaiting user input",
        status: "awaiting_user",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        companyId,
        title: "still in backlog",
        status: "backlog",
        priority: "low",
        assigneeAgentId: agentId,
      },
      {
        companyId,
        title: "todo item",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        companyId,
        title: "awaiting review",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        companyId,
        title: "already shipped",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        companyId,
        title: "someone else's",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: otherAgentId,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("returns only open issues assigned to this agent", async () => {
    const result = await loadAssignedIssueQueue(handle.db, { companyId, agentId });
    expect(result.items.map((i) => i.title).sort()).toEqual([
      "awaiting review",
      "awaiting user input",
      "open high-priority",
      "still in backlog",
      "todo item",
    ]);
    expect(result.awaitingCount).toBe(1);
    expect(result.body).toMatch(/open high-priority/);
    expect(result.body).toMatch(/awaiting user input/);
    expect(result.body).not.toMatch(/already shipped/);
    expect(result.body).not.toMatch(/someone else's/);
  });

  it("surfaces todo and in_review statuses (Round 3 OPEN_STATUSES fix)", async () => {
    const result = await loadAssignedIssueQueue(handle.db, { companyId, agentId });
    const statuses = result.items.map((i) => i.status).sort();
    expect(statuses).toContain("todo");
    expect(statuses).toContain("in_review");
    expect(result.body).toMatch(/todo item/);
    expect(result.body).toMatch(/awaiting review/);
  });

  it("marks the currently-woken issue and surfaces it first", async () => {
    const rows = await handle.db
      .select({ id: issues.id })
      .from(issues)
      .where(eqTitle("still in backlog"));
    const currentId = rows[0]?.id;
    expect(currentId).toBeDefined();

    const result = await loadAssignedIssueQueue(handle.db, {
      companyId,
      agentId,
      currentIssueId: currentId,
    });
    const current = result.items.find((i) => i.isCurrent);
    expect(current?.title).toBe("still in backlog");
    // current must sort first.
    expect(result.items[0]?.id).toBe(currentId);
  });

  it("renders a focus block with directive and excludes current issue from digest (Round 3 #2)", async () => {
    const rows = await handle.db
      .select({ id: issues.id })
      .from(issues)
      .where(eqTitle("open high-priority"));
    const currentId = rows[0]?.id;
    expect(currentId).toBeDefined();

    const result = await loadAssignedIssueQueue(handle.db, {
      companyId,
      agentId,
      currentIssueId: currentId,
      currentIssueBody: "Fix the thing that Anurag flagged.",
      focusMode: true,
    });

    // Focus block present and loud.
    expect(result.focusBody).toMatch(/🎯 Current focus/);
    expect(result.focusBody).toMatch(/open high-priority/);
    expect(result.directive).toMatch(/only to the current focus issue/i);

    // Digest block labels itself and lists OTHERS — never the focus issue.
    expect(result.digestBody).toMatch(/Other open issues/);
    expect(result.digestBody).toMatch(/awaiting user input/);
    expect(result.digestBody).toMatch(/todo item/);
    expect(result.digestBody).not.toMatch(/open high-priority/);

    // Combined body leads with the focus section so a consumer that only
    // reads `.body` still gets correct ordering.
    expect(result.body.indexOf("🎯 Current focus")).toBeLessThan(
      result.body.indexOf("Other open issues"),
    );

    // currentIssueMissing is false when we find it.
    expect(result.currentIssueMissing).toBe(false);
  });

  it("flags currentIssueMissing when the id does not resolve to an open row", async () => {
    const result = await loadAssignedIssueQueue(handle.db, {
      companyId,
      agentId,
      currentIssueId: "00000000-0000-0000-0000-000000000000",
      focusMode: true,
    });
    expect(result.currentIssueMissing).toBe(true);
    expect(result.focusBody).toBe("");
    expect(result.directive).toBeNull();
    // Digest still renders all open items.
    expect(result.digestBody).toMatch(/open high-priority/);
  });

  it("falls back to legacy body when focusMode is disabled", async () => {
    const rows = await handle.db
      .select({ id: issues.id })
      .from(issues)
      .where(eqTitle("open high-priority"));
    const currentId = rows[0]?.id;
    expect(currentId).toBeDefined();

    const result = await loadAssignedIssueQueue(handle.db, {
      companyId,
      agentId,
      currentIssueId: currentId,
      focusMode: false,
    });
    expect(result.focusBody).toBe("");
    expect(result.directive).toBeNull();
    // No "Other open issues" heading when focus is off.
    expect(result.digestBody).not.toMatch(/Other open issues/);
  });

  it("emits a helpful empty-queue body when the agent has nothing assigned", async () => {
    // Use the *other* agent which only has one in_progress issue owned by them.
    // Close that one manually so the queue is empty.
    await handle.db
      .update(issues)
      .set({ status: "done" })
      .where(eqAssignee(otherAgentId));
    const result = await loadAssignedIssueQueue(handle.db, {
      companyId,
      agentId: otherAgentId,
    });
    expect(result.items).toHaveLength(0);
    expect(result.body).toMatch(/No open issues assigned to you/i);
  });
});

// Small helpers so we don't re-import drizzle operators in the test body.
import { eq } from "drizzle-orm";
function eqTitle(title: string) {
  return eq(issues.title, title);
}
function eqAssignee(id: string) {
  return eq(issues.assigneeAgentId, id);
}
