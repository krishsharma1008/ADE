import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { agentTaskSessions, agents, companies, heartbeatRuns, issueComments, issues } from "@combyne/db";
import { extractAndPostQuestions } from "../agent-question-extract.js";
import {
  answerInternalManagerQuestion,
  routeAgentQuestionsToManager,
} from "../agent-question-routing.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("agent question routing", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let emId: string;
  let devId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Question Routing Co", issuePrefix: "QR" })
      .returning();
    companyId = company.id;
    const [em] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "EM",
        role: "em",
        adapterType: "process",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      })
      .returning();
    emId = em.id;
    const [dev] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "Engineer",
        role: "engineer",
        reportsTo: em.id,
        adapterType: "process",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      })
      .returning();
    devId = dev.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  async function createParentAndChild(title = "Implement lender change") {
    const [parent] = await handle.db
      .insert(issues)
      .values({ companyId, title, status: "in_progress", assigneeAgentId: emId })
      .returning();
    const [child] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: `${title} - child`,
        status: "in_progress",
        parentId: parent.id,
        assigneeAgentId: devId,
      })
      .returning();
    return { parent, child };
  }

  it("routes a delegated sub-agent question to the EM instead of the user", async () => {
    const { parent, child } = await createParentAndChild("Route direct ask-user");
    const [otherEmIssue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Other EM work", status: "in_progress", assigneeAgentId: emId })
      .returning();
    await handle.db.insert(heartbeatRuns).values({
      companyId,
      agentId: emId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: { issueId: otherEmIssue.id, taskId: otherEmIssue.id },
    });

    const result = await routeAgentQuestionsToManager(handle.db, {
      companyId,
      issueId: child.id,
      askingAgentId: devId,
      questions: ["Which nullable payload default should I use?"],
      actor: { actorType: "agent", actorId: devId },
    });

    expect(result.routedToManager).toBe(true);
    expect(result.routedToAgentId).toBe(emId);

    const managerQuestions = await handle.db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, child.id), eq(issueComments.kind, "manager_question")));
    expect(managerQuestions).toHaveLength(1);
    expect(managerQuestions[0]!.authorAgentId).toBe(devId);

    const userQuestions = await handle.db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, child.id), eq(issueComments.kind, "question"), isNull(issueComments.answeredAt)));
    expect(userQuestions).toHaveLength(0);

    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, child.id));
    expect(refreshed.status).toBe("blocked");
    expect(refreshed.blockedSource).toBe("agent");
    expect(refreshed.blockedReason).toContain("Waiting on EM/manager");
    expect(refreshed.awaitingUserSince).toBeNull();
    expect(refreshed.latestUserFacingAgentMessage).toBeNull();

    const emRuns = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, emId));
    expect(emRuns.some((run) => {
      const context = run.contextSnapshot as Record<string, unknown> | null;
      return context?.wakeReason === "internal_question_routed_to_manager" &&
        context?.issueId === parent.id &&
        context?.childIssueId === child.id &&
        context?.wakeCommentId === managerQuestions[0]!.id &&
        String(context?.managerQuestionBody ?? "").includes("nullable payload");
    })).toBe(true);
  });

  it("routes auto-extracted stdout questions internally and does not await the user", async () => {
    const { child } = await createParentAndChild("Route extracted question");
    const [otherEmIssue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Other EM work for extract", status: "in_progress", assigneeAgentId: emId })
      .returning();
    await handle.db.insert(heartbeatRuns).values({
      companyId,
      agentId: emId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: { issueId: otherEmIssue.id, taskId: otherEmIssue.id },
    });

    const result = await extractAndPostQuestions(handle.db, {
      companyId,
      agentId: devId,
      issueId: child.id,
      sourceText: `
## Open questions
- Should I treat missing spouse income as zero?
      `,
    });

    expect(result.routedToManager).toBe(true);
    expect(result.routedToAgentId).toBe(emId);

    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, child.id));
    expect(refreshed.status).toBe("blocked");
    expect(refreshed.awaitingUserSince).toBeNull();

    const humanQuestions = await handle.db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, child.id), eq(issueComments.kind, "question")));
    expect(humanQuestions).toHaveLength(0);
  });

  it("lets the EM answer internally and wakes the child assignee with the existing task session", async () => {
    const { child } = await createParentAndChild("Answer internal blocker");
    const [otherIssue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Other active dev work", status: "in_progress", assigneeAgentId: devId })
      .returning();
    await handle.db.insert(heartbeatRuns).values({
      companyId,
      agentId: devId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: { issueId: otherIssue.id, taskId: otherIssue.id },
    });
    await handle.db.insert(agentTaskSessions).values({
      companyId,
      agentId: devId,
      adapterType: "process",
      taskKey: child.identifier ?? child.id,
      sessionParamsJson: { sessionId: "session-child", cwd: "/tmp/project" },
      sessionDisplayId: "session-child",
    });
    const [question] = await handle.db
      .insert(issueComments)
      .values({
        companyId,
        issueId: child.id,
        authorAgentId: devId,
        body: "Should missing spouse income be zero?",
        kind: "manager_question",
      })
      .returning();
    await handle.db
      .update(issues)
      .set({
        status: "blocked",
        blockedSource: "agent",
        blockedReason: "Waiting on EM/manager: Should missing spouse income be zero?",
        blockedAt: new Date(),
      })
      .where(eq(issues.id, child.id));

    const result = await answerInternalManagerQuestion(handle.db, {
      companyId,
      issueId: child.id,
      questionCommentId: question.id,
      answer: "Use zero and document that this is a defensive default.",
      assumption: true,
      actor: { actorType: "agent", actorId: emId, agentId: emId },
    });

    expect(result.remainingOpen).toBe(0);
    expect(result.issue.status).toBe("in_progress");
    expect(result.answerComment.kind).toBe("manager_answer");
    expect(result.answerComment.body).toContain("Assumption:");

    const [answeredQuestion] = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, question.id));
    expect(answeredQuestion.answeredCommentId).toBe(result.answerComment.id);

    const childRuns = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, devId), eq(heartbeatRuns.status, "queued")));
    expect(childRuns.some((run) => {
      const context = run.contextSnapshot as Record<string, unknown> | null;
      return context?.wakeReason === "manager_question_answered" &&
        context?.wakeCommentId === result.answerComment.id &&
        context?.managerAnswerBody &&
        run.sessionIdBefore === "session-child";
    })).toBe(true);
  });

  it("falls back to a user-facing question when no manager or coordinator exists", async () => {
    const [soloCompany] = await handle.db
      .insert(companies)
      .values({ name: "Solo Question Co", issuePrefix: "SQ" })
      .returning();
    const [solo] = await handle.db
      .insert(agents)
      .values({ companyId: soloCompany.id, name: "Solo IC", role: "engineer", adapterType: "process" })
      .returning();
    const [soloIssue] = await handle.db
      .insert(issues)
      .values({ companyId: soloCompany.id, title: "No manager issue", status: "in_progress", assigneeAgentId: solo.id })
      .returning();

    const result = await routeAgentQuestionsToManager(handle.db, {
      companyId: soloCompany.id,
      issueId: soloIssue.id,
      askingAgentId: solo.id,
      questions: ["Can anyone approve this missing credential?"],
      actor: { actorType: "agent", actorId: solo.id },
    });

    expect(result.routedToManager).toBe(false);
    expect(result.fallbackToUser).toBe(true);
    if (!result.routedToManager) {
      expect(result.reason).toBe("no_manager_target");
    }
  });
});
