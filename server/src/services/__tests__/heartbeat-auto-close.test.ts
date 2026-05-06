import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, heartbeatRuns, issueComments, issues } from "@combyne/db";
import {
  autoCloseIssueAfterSuccessfulRun,
  reopenIssuesAutoClosedAfterTokenPause,
} from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("heartbeat successful-run auto-close", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: `Auto Close ${suffix}`, issuePrefix: `AC${suffix}` })
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

  async function seedIssue(
    status: "todo" | "in_progress" | "awaiting_user" | "done" = "in_progress",
    opts: { originKind?: string | null } = {},
  ) {
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "on_demand",
      })
      .returning();
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: `Auto-close ${status}`,
        status,
        assigneeAgentId: agentId,
        executionRunId: run.id,
        originKind: opts.originKind ?? null,
      })
      .returning();
    return { issue, run };
  }

  it("does not close a manual implementation issue just because the run succeeded", async () => {
    const { issue, run } = await seedIssue("in_progress");

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
    });

    expect(result).toEqual({ closed: false, reason: "manual_auto_close_disabled" });
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("in_progress");
    expect(refreshed.completedAt).toBeNull();
  });

  it("still auto-closes operational routine issues when no user input is pending", async () => {
    const { issue, run } = await seedIssue("in_progress", { originKind: "routine_execution" });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
    });

    expect(result).toEqual({ closed: true, reason: "successful_run_without_questions" });
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("done");
    expect(refreshed.completedAt).toBeTruthy();
  });

  it("does not close when an open question exists", async () => {
    const { issue, run } = await seedIssue("in_progress");
    await handle.db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      authorAgentId: agentId,
      body: "Which repository should I use?",
      kind: "question",
    });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 1, statusTransitioned: false },
    });

    expect(result.closed).toBe(false);
    expect(result.reason).toBe("questions_extracted");
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("in_progress");
  });

  it("leaves explicit awaiting_user issues alone", async () => {
    const { issue, run } = await seedIssue("awaiting_user");

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
    });

    expect(result.closed).toBe(false);
    expect(result.reason).toBe("status_awaiting_user");
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("awaiting_user");
  });

  it("reopens issues that were auto-closed after an old token pause", async () => {
    const { issue, run } = await seedIssue("done");
    await handle.db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      authorUserId: null,
      body: "Run paused after crossing the small-task token threshold. Reported tokens: 151979; threshold: 80000.",
      createdAt: new Date(Date.now() - 60_000),
    });
    await handle.db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "issue.auto_closed",
      entityType: "issue",
      entityId: issue.id,
      agentId,
      runId: run.id,
      details: { reason: "successful_run_without_questions" },
      createdAt: new Date(),
    });

    const result = await reopenIssuesAutoClosedAfterTokenPause(handle.db);

    expect(result.reopened).toBeGreaterThanOrEqual(1);
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("in_progress");
    expect(refreshed.completedAt).toBeNull();
  });
});
