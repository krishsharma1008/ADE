import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  heartbeatRuns,
  issueComments,
  issuePullRequests,
  issues,
} from "@combyne/db";
import {
  autoCloseIssueAfterSuccessfulRun,
  enforceDelegationPolicyAfterSuccessfulRun,
  reopenIssuesAutoClosedAfterTokenPause,
} from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("heartbeat successful-run auto-close", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let emAgentId: string;

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
    const [em] = await handle.db
      .insert(agents)
      .values({ companyId, name: "EM", role: "em", adapterType: "process" })
      .returning();
    emAgentId = em.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  async function seedIssue(
    status: "todo" | "in_progress" | "awaiting_user" | "done" = "in_progress",
    opts: { originKind?: string | null; complexity?: string | null; assigneeAgentId?: string | null } = {},
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
        complexity: opts.complexity ?? null,
        assigneeAgentId: opts.assigneeAgentId ?? agentId,
        executionRunId: run.id,
        originKind: opts.originKind ?? null,
      })
      .returning();
    return { issue, run };
  }

  it("does not close old/manual medium fallback issues just because the run succeeded", async () => {
    const { issue, run } = await seedIssue("in_progress");

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
    });

    expect(result).toEqual({ closed: false, reason: "complexity_medium_requires_policy_close" });
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("in_progress");
    expect(refreshed.completedAt).toBeNull();
  });

  it("auto-closes clean small implementation issues and posts a system completion note", async () => {
    const { issue, run } = await seedIssue("in_progress", { complexity: "small" });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
      summary: "Updated the null-safe default.",
      changedFiles: ["src/example.ts"],
      checks: ["pnpm test"],
    });

    expect(result).toEqual({ closed: true, reason: "successful_run_without_questions" });
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("done");
    const comments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    expect(comments.some((comment) => /Run completed successfully/.test(comment.body))).toBe(true);
    expect(comments.some((comment) => /src\/example\.ts/.test(comment.body))).toBe(true);
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
    const { issue, run } = await seedIssue("in_progress", { complexity: "small" });
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

  it("does not close small issues with open internal manager questions", async () => {
    const { issue, run } = await seedIssue("in_progress", { complexity: "small" });
    await handle.db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      authorAgentId: agentId,
      body: "Need EM input on the default.",
      kind: "manager_question",
    });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
    });

    expect(result).toEqual({ closed: false, reason: "open_questions" });
  });

  it("does not close small issues while child issues are still open", async () => {
    const { issue, run } = await seedIssue("in_progress", { complexity: "small" });
    await handle.db.insert(issues).values({
      companyId,
      parentId: issue.id,
      title: "Open child",
      status: "in_progress",
      complexity: "small",
      assigneeAgentId: agentId,
    });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
    });

    expect(result).toEqual({ closed: false, reason: "open_child_issues" });
  });

  it("flags medium coordinator issues that finish without delegated children", async () => {
    const { issue, run } = await seedIssue("in_progress", {
      complexity: "medium",
      assigneeAgentId: emAgentId,
    });

    const result = await enforceDelegationPolicyAfterSuccessfulRun(handle.db, {
      companyId,
      agentId: emAgentId,
      runId: run.id,
      issueId: issue.id,
      wakeAssignee: false,
    });

    expect(result.enforced).toBe(true);
    expect(result.reason).toBe("delegation_required");
    const comments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    expect(comments.some((comment) => /Delegation required/.test(comment.body))).toBe(true);
    const secondResult = await enforceDelegationPolicyAfterSuccessfulRun(handle.db, {
      companyId,
      agentId: emAgentId,
      runId: run.id,
      issueId: issue.id,
      currentWakeReason: "delegation_required",
      wakeAssignee: false,
    });
    expect(secondResult.reason).toBe("delegation_required_already_pending");
    const commentsAfterSecondCheck = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(commentsAfterSecondCheck.filter((comment) => /Delegation required/.test(comment.body)).length).toBe(1);
    const [refreshedRun] = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect((refreshedRun.promptBudgetJson as Record<string, unknown> | null)?.orchestrationPolicy).toBeTruthy();
  });

  it("routes a code ticket with no artifact to awaiting_user instead of closing", async () => {
    const { issue, run } = await seedIssue("in_progress", { complexity: "small" });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
      requiresArtifact: true,
    });

    expect(result).toEqual({ closed: false, reason: "no_artifact" });
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("awaiting_user");
    expect(refreshed.completedAt).toBeNull();

    const comments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    const advisory = comments.find((comment) =>
      /no pull request|changed files|verifiable artifact/i.test(comment.body),
    );
    expect(advisory).toBeTruthy();
    expect(advisory?.kind).not.toBe("question");
    expect(advisory?.kind).toBe("system");
    expect(comments.some((comment) => /Run completed successfully/.test(comment.body))).toBe(false);

    const blockedActivity = await handle.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issue.id));
    expect(blockedActivity.some((row) => row.action === "issue.auto_close_blocked")).toBe(true);
  });

  it("closes a code ticket when changed files are reported", async () => {
    const { issue, run } = await seedIssue("in_progress", { complexity: "small" });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
      requiresArtifact: true,
      changedFiles: ["src/example.ts"],
    });

    expect(result).toEqual({ closed: true, reason: "successful_run_without_questions" });
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("done");
  });

  it("closes a code ticket when a tracked pull request exists", async () => {
    const { issue, run } = await seedIssue("in_progress", { complexity: "small" });
    await handle.db.insert(issuePullRequests).values({
      companyId,
      issueId: issue.id,
      repo: "acme/widgets",
      pullNumber: 42,
      pullUrl: "https://github.com/acme/widgets/pull/42",
      title: "Implement the widget",
      baseBranch: "main",
    });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
      requiresArtifact: true,
    });

    expect(result).toEqual({ closed: true, reason: "successful_run_without_questions" });
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("done");
  });

  it("closes a non-code ticket without requiring an artifact", async () => {
    const { issue, run } = await seedIssue("in_progress", { complexity: "small" });

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
  });

  it("closes a routine_execution ticket even when an artifact is required and absent", async () => {
    const { issue, run } = await seedIssue("in_progress", { originKind: "routine_execution" });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, {
      companyId,
      agentId,
      runId: run.id,
      issueId: issue.id,
      questionResult: { posted: 0, skippedDuplicates: 0, skippedExisting: 0, statusTransitioned: false },
      requiresArtifact: true,
    });

    expect(result).toEqual({ closed: true, reason: "successful_run_without_questions" });
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("done");
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
