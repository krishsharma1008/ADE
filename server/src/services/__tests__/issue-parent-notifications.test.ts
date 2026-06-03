import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issueComments, issues } from "@combyne/db";
import { issueService } from "../issues.js";
import { markIssueBlockedAfterFailedRun } from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("issue parent notifications", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let parentAgentId: string;
  let reviewerAgentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Parent Notify Co", issuePrefix: "PN" })
      .returning();
    companyId = company.id;
    const [parentAgent] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "EM",
        role: "em",
        adapterType: "process",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      })
      .returning();
    parentAgentId = parentAgent.id;
    await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: parentAgentId, status: "running", invocationSource: "on_demand" });
    const [reviewer] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Reviewer", role: "engineer", adapterType: "process" })
      .returning();
    reviewerAgentId = reviewer.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("posts on the parent and wakes the parent assignee with wakeCommentId", async () => {
    const [parent] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Parent implementation", status: "in_progress", assigneeAgentId: parentAgentId })
      .returning();
    const [child] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Code review",
        status: "in_review",
        complexity: "small",
        parentId: parent.id,
        assigneeAgentId: reviewerAgentId,
      })
      .returning();
    await handle.db.insert(issueComments).values({
      companyId,
      issueId: child.id,
      authorAgentId: reviewerAgentId,
      body: "Review complete. Fix null payload handling before merge.",
      kind: "comment",
    });

    await issueService(handle.db).update(child.id, { status: "done" });

    const comments = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, parent.id));
    expect(comments.some((comment) => comment.body.includes("Child issue"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("### Recommended next action"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("Fix null payload handling"))).toBe(true);

    const runs = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, parentAgentId));
    expect(runs.some((run) => {
      const context = run.contextSnapshot as Record<string, unknown> | null;
      const digest = context?.childDigest as Record<string, unknown> | undefined;
      const latestComments = digest?.latestComments as Array<Record<string, unknown>> | undefined;
      return context?.childIssueId === child.id &&
        context?.wakeCommentId &&
        typeof context?.recommendedNextAction === "string" &&
        latestComments?.some((item) => String(item.excerpt ?? "").includes("Fix null payload handling"));
    })).toBe(true);
  });

  it("wakes the parent when a child becomes awaiting_user with an open question", async () => {
    const [parent] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Parent routing user blocker", status: "in_progress", assigneeAgentId: parentAgentId })
      .returning();
    const [child] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Clarify review blocker",
        status: "in_progress",
        complexity: "small",
        parentId: parent.id,
        assigneeAgentId: reviewerAgentId,
      })
      .returning();
    await handle.db.insert(issueComments).values({
      companyId,
      issueId: child.id,
      authorAgentId: reviewerAgentId,
      body: "Which field should be used as the fallback customer identifier?",
      kind: "question",
    });

    await issueService(handle.db).update(child.id, { status: "awaiting_user" });

    const parentComments = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, parent.id));
    expect(parentComments.some((comment) => comment.body.includes("Resolve or route the open question"))).toBe(true);
    expect(parentComments.some((comment) => comment.body.includes("fallback customer identifier"))).toBe(true);

    const parentRuns = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, parentAgentId));
    expect(parentRuns.some((parentRun) => {
      const context = parentRun.contextSnapshot as Record<string, unknown> | null;
      const digest = context?.childDigest as Record<string, unknown> | undefined;
      const openQuestions = digest?.openQuestions as string[] | undefined;
      return context?.childIssueId === child.id &&
        context?.childIssueStatus === "awaiting_user" &&
        context?.wakeReason === "child_issue_awaiting_user" &&
        context?.wakeCommentId &&
        openQuestions?.some((question) => question.includes("fallback customer identifier"));
    })).toBe(true);
  });

  it("blocks failed child runs and wakes the parent with the failure digest", async () => {
    const [parent] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Parent after child failure", status: "in_progress", assigneeAgentId: parentAgentId })
      .returning();
    const [child] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Brick nullable defaults child",
        status: "in_progress",
        complexity: "small",
        parentId: parent.id,
        assigneeAgentId: reviewerAgentId,
      })
      .returning();
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: reviewerAgentId,
        status: "failed",
        invocationSource: "on_demand",
        contextSnapshot: { issueId: child.id, taskId: child.id, wakeReason: "issue_assigned" },
      })
      .returning();
    const [reviewer] = await handle.db.select().from(agents).where(eq(agents.id, reviewerAgentId));

    const result = await markIssueBlockedAfterFailedRun(handle.db, {
      run,
      agent: reviewer!,
      message: "Claude run failed: subtype=error_max_turns: Reached maximum number of turns (30)",
      errorCode: "error_max_turns",
    });

    expect(result.blocked).toBe(true);
    const [updatedChild] = await handle.db.select().from(issues).where(eq(issues.id, child.id));
    expect(updatedChild?.status).toBe("blocked");
    expect(updatedChild?.blockedSource).toBe("agent");
    expect(updatedChild?.blockedReason).toContain(run.id);

    const childComments = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, child.id));
    expect(childComments.some((comment) => comment.kind === "system" && comment.body.includes("Agent run failed"))).toBe(true);

    const parentComments = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, parent.id));
    expect(parentComments.some((comment) => comment.body.includes("is blocked"))).toBe(true);
    expect(parentComments.some((comment) => comment.body.includes("Agent run failed"))).toBe(true);

    const parentRuns = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, parentAgentId));
    expect(parentRuns.some((parentRun) => {
      const context = parentRun.contextSnapshot as Record<string, unknown> | null;
      const digest = context?.childDigest as Record<string, unknown> | undefined;
      const latestComments = digest?.latestComments as Array<Record<string, unknown>> | undefined;
      return context?.childIssueId === child.id &&
        context?.childIssueStatus === "blocked" &&
        context?.wakeReason === "child_issue_blocked" &&
        latestComments?.some((item) => String(item.excerpt ?? "").includes("Agent run failed"));
    })).toBe(true);
  });
});
