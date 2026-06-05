// Phase 3 (c): reEvaluateStaleAgentSelfBlocks recovers a stale FREE-TEXT agent
// self-block once every gating condition is gone. A stale self-block WITH any of the
// four blocker probes (open question/manager_question, open child issue, unresolved
// PR feedback, unresolved QA feedback) must be left untouched, and a fresh self-block
// (younger than the threshold) must be left untouched.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  issueComments,
  issuePullRequests,
  issues,
  qaFeedbackEvents,
} from "@combyne/db";
import { issueService } from "../issues.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

const STALE_AFTER_MS = 30 * 60 * 1000;

describe("issueService.reEvaluateStaleAgentSelfBlocks", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let now: Date;
  let staleBlockedAt: Date;
  let freshBlockedAt: Date;

  beforeAll(async () => {
    handle = await startTestDb();
    now = new Date("2026-06-05T12:00:00.000Z");
    // 45 min ago -> older than the 30-min threshold.
    staleBlockedAt = new Date(now.getTime() - 45 * 60 * 1000);
    // 5 min ago -> still fresh.
    freshBlockedAt = new Date(now.getTime() - 5 * 60 * 1000);

    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Self Block Co", issuePrefix: "SBC" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", adapterType: "process" })
      .returning();
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  async function seedSelfBlocked(blockedAt: Date) {
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Self-blocked work",
        status: "blocked",
        blockedSource: "agent",
        blockedReason: "waiting on something I assumed I needed",
        blockedAt,
        assigneeAgentId: agentId,
        startedAt: new Date(blockedAt.getTime() - 60 * 60 * 1000),
      })
      .returning();
    return issue.id;
  }

  it("clears a stale self-block with no remaining blockers, posts a system comment, and reports recovery", async () => {
    const issueId = await seedSelfBlocked(staleBlockedAt);
    const svc = issueService(handle.db);

    const result = await svc.reEvaluateStaleAgentSelfBlocks(now, STALE_AFTER_MS);
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    // Assignee present -> in_progress, all block fields cleared.
    expect(issue.status).toBe("in_progress");
    expect(issue.blockedSource).toBeNull();
    expect(issue.blockedReason).toBeNull();
    expect(issue.blockedAt).toBeNull();
    expect(issue.awaitingUserSince).toBeNull();
    expect(issue.latestUserFacingAgentMessage).toBeNull();
    expect(issue.completedAt).toBeNull();
    expect(issue.cancelledAt).toBeNull();

    const comments = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const systemComment = comments.find((c) => c.kind === "system");
    expect(systemComment).toBeTruthy();
    expect(systemComment?.body).toContain("Self-block auto-cleared");
  });

  it("leaves a stale self-block untouched when an open manager_question remains", async () => {
    const issueId = await seedSelfBlocked(staleBlockedAt);
    await handle.db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Need a product decision before I continue.",
      kind: "manager_question",
    });
    const svc = issueService(handle.db);

    await svc.reEvaluateStaleAgentSelfBlocks(now, STALE_AFTER_MS);

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("blocked");
    expect(issue.blockedSource).toBe("agent");
  });

  it("leaves a stale self-block untouched when unresolved QA feedback remains", async () => {
    const issueId = await seedSelfBlocked(staleBlockedAt);
    await handle.db.insert(qaFeedbackEvents).values({
      companyId,
      issueId,
      status: "queued",
      severity: "high",
      title: "Login button broken",
      body: "Clicking login throws a 500.",
      dedupeHash: `qa-${issueId}`,
    });
    const svc = issueService(handle.db);

    await svc.reEvaluateStaleAgentSelfBlocks(now, STALE_AFTER_MS);

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("blocked");
    expect(issue.blockedSource).toBe("agent");
  });

  it("leaves a stale self-block untouched when unresolved PR feedback remains", async () => {
    const issueId = await seedSelfBlocked(staleBlockedAt);
    await handle.db.insert(issuePullRequests).values({
      companyId,
      issueId,
      requestedByAgentId: agentId,
      repo: "combyne/ade",
      pullNumber: 9001,
      pullUrl: "https://github.com/combyne/ade/pull/9001",
      title: "wip",
      baseBranch: "development",
      headBranch: "wip",
      headSha: "deadbeef",
      state: "open",
      reviewStatus: "changes_requested",
    });
    const svc = issueService(handle.db);

    await svc.reEvaluateStaleAgentSelfBlocks(now, STALE_AFTER_MS);

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("blocked");
    expect(issue.blockedSource).toBe("agent");
  });

  it("leaves a fresh self-block (younger than the threshold) untouched", async () => {
    const issueId = await seedSelfBlocked(freshBlockedAt);
    const svc = issueService(handle.db);

    await svc.reEvaluateStaleAgentSelfBlocks(now, STALE_AFTER_MS);

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("blocked");
    expect(issue.blockedSource).toBe("agent");
  });
});
