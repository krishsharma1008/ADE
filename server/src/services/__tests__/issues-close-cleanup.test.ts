import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { agents, companies, issueComments, issues } from "@combyne/db";
import { issueService } from "../issues.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

// Covers the close-cleanup path that fixes the "ticket stuck in
// awaiting_user with leftover question cards" bug. When an issue
// transitions to done/cancelled, any open `kind="question"` comments
// must be stamped with answeredAt so the QuestionAnswerCard doesn't
// linger in the UI on next load.
describe("issueService.update — close-cleanup", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Close Cleanup Co" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "close-cleanup-agent", adapterType: "claude_local" })
      .returning();
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  async function seedIssueWithOpenQuestions(status: string) {
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Close cleanup test",
        status,
        priority: "medium",
        assigneeAgentId: agentId,
        awaitingUserSince: status === "awaiting_user" ? new Date() : null,
      })
      .returning();
    await handle.db.insert(issueComments).values([
      {
        companyId,
        issueId: issue.id,
        authorAgentId: agentId,
        body: "Should I add tests for the new endpoint?",
        kind: "question",
      },
      {
        companyId,
        issueId: issue.id,
        authorAgentId: agentId,
        body: "Use auth method A or B?",
        kind: "question",
      },
    ]);
    return issue;
  }

  it("dismisses unanswered question comments when status flips to done", async () => {
    const issue = await seedIssueWithOpenQuestions("awaiting_user");
    const svc = issueService(handle.db);

    const updated = await svc.update(issue.id, { status: "done" });
    expect(updated?.status).toBe("done");

    const lingering = await handle.db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue.id),
          eq(issueComments.kind, "question"),
          isNull(issueComments.answeredAt),
        ),
      );
    expect(lingering).toHaveLength(0);

    const allQuestions = await handle.db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue.id),
          eq(issueComments.kind, "question"),
        ),
      );
    expect(allQuestions).toHaveLength(2);
    for (const row of allQuestions) {
      expect(row.answeredAt).not.toBeNull();
    }
  });

  it("dismisses unanswered question comments when status flips to cancelled", async () => {
    const issue = await seedIssueWithOpenQuestions("awaiting_user");
    const svc = issueService(handle.db);

    const updated = await svc.update(issue.id, { status: "cancelled" });
    expect(updated?.status).toBe("cancelled");

    const lingering = await handle.db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue.id),
          eq(issueComments.kind, "question"),
          isNull(issueComments.answeredAt),
        ),
      );
    expect(lingering).toHaveLength(0);
  });

  it("does NOT touch question comments when transitioning between non-terminal statuses", async () => {
    const issue = await seedIssueWithOpenQuestions("in_progress");
    const svc = issueService(handle.db);

    await svc.update(issue.id, { status: "blocked" });
    const stillOpen = await handle.db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue.id),
          eq(issueComments.kind, "question"),
          isNull(issueComments.answeredAt),
        ),
      );
    expect(stillOpen).toHaveLength(2);
  });

  it("clears awaitingUserSince and completedAt is stamped on close from awaiting_user", async () => {
    const issue = await seedIssueWithOpenQuestions("awaiting_user");
    const svc = issueService(handle.db);

    await svc.update(issue.id, { status: "done" });
    const [refreshed] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("done");
    expect(refreshed.awaitingUserSince).toBeNull();
    expect(refreshed.completedAt).not.toBeNull();
  });
});

describe("issueService.autoCloseStaleAwaitingUserIssues — backstop sweeper", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Stale Sweeper Co" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "stale-sweeper-agent", adapterType: "claude_local" })
      .returning();
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("closes stale awaiting_user issues past the threshold", async () => {
    const stale = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const fresh = new Date();

    const [staleIssue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Stale waiting issue",
        status: "awaiting_user",
        priority: "low",
        assigneeAgentId: agentId,
        awaitingUserSince: stale,
      })
      .returning();
    const [freshIssue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Recent waiting issue",
        status: "awaiting_user",
        priority: "low",
        assigneeAgentId: agentId,
        awaitingUserSince: fresh,
      })
      .returning();
    // Plant an unanswered question on the stale issue so we can verify
    // it gets dismissed by the sweeper.
    await handle.db.insert(issueComments).values({
      companyId,
      issueId: staleIssue.id,
      authorAgentId: agentId,
      body: "Lingering open question?",
      kind: "question",
    });

    const svc = issueService(handle.db);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const result = await svc.autoCloseStaleAwaitingUserIssues(new Date(), sevenDays);
    expect(result.closed).toBeGreaterThanOrEqual(1);

    const [refreshedStale] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, staleIssue.id));
    expect(refreshedStale.status).toBe("done");
    expect(refreshedStale.awaitingUserSince).toBeNull();

    const [refreshedFresh] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, freshIssue.id));
    expect(refreshedFresh.status).toBe("awaiting_user");

    const lingering = await handle.db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, staleIssue.id),
          eq(issueComments.kind, "question"),
          isNull(issueComments.answeredAt),
        ),
      );
    expect(lingering).toHaveLength(0);
  });

  it("excludes terminal_session and routine_execution origins", async () => {
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [terminal] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Terminal session ticket",
        status: "awaiting_user",
        priority: "low",
        assigneeAgentId: agentId,
        awaitingUserSince: stale,
        originKind: "terminal_session",
      })
      .returning();
    const [routine] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Routine ticket",
        status: "awaiting_user",
        priority: "low",
        assigneeAgentId: agentId,
        awaitingUserSince: stale,
        originKind: "routine_execution",
      })
      .returning();

    const svc = issueService(handle.db);
    await svc.autoCloseStaleAwaitingUserIssues(
      new Date(),
      7 * 24 * 60 * 60 * 1000,
    );

    const [refreshedTerminal] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, terminal.id));
    expect(refreshedTerminal.status).toBe("awaiting_user");

    const [refreshedRoutine] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, routine.id));
    expect(refreshedRoutine.status).toBe("awaiting_user");
  });
});
