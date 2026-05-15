import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { agentTaskSessions, agents, companies, heartbeatRuns, issueComments, issues } from "@combyne/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "../services/__tests__/_test-db.js";

function createStorageStub() {
  return {
    putObject: async () => {
      throw new Error("unused");
    },
    getObject: async () => {
      throw new Error("unused");
    },
    deleteObject: async () => undefined,
  };
}

function createApp(handle: TestDbHandle) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const agentId = req.header("x-test-agent-id");
    const companyId = req.header("x-test-company-id");
    if (agentId && companyId) {
      (req as any).actor = {
        type: "agent",
        agentId,
        companyId,
        source: "agent_key",
        runId: req.header("x-combyne-run-id") ?? null,
      };
    } else {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        isInstanceAdmin: true,
        source: "local_implicit",
      };
    }
    next();
  });
  app.use("/api", issueRoutes(handle.db, createStorageStub() as any));
  app.use(errorHandler);
  return app;
}

describe("issue internal question routes", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  let companyId: string;
  let emId: string;
  let devId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    app = createApp(handle);

    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Internal Question Route Co", issuePrefix: "IQR" })
      .returning();
    companyId = company.id;

    const [em] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "Buku EM",
        role: "em",
        adapterType: "process",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
        permissions: { canAssignTasks: true, taskAssignmentScope: "company" },
      })
      .returning();
    emId = em.id;

    const [dev] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "BNPL Engineer",
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

  async function createParentAndChild(title: string) {
    const [parent] = await handle.db
      .insert(issues)
      .values({ companyId, title, status: "in_progress", assigneeAgentId: emId })
      .returning();
    const [child] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: `${title} child`,
        status: "in_progress",
        parentId: parent.id,
        assigneeAgentId: devId,
      })
      .returning();
    return { parent, child };
  }

  it("routes sub-agent /ask-user to an internal manager question", async () => {
    const { parent, child } = await createParentAndChild("Route ask-user");
    const [otherEmIssue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Other EM route work", status: "in_progress", assigneeAgentId: emId })
      .returning();
    await handle.db.insert(heartbeatRuns).values({
      companyId,
      agentId: emId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: { issueId: otherEmIssue.id, taskId: otherEmIssue.id },
    });

    const res = await request(app)
      .post(`/api/issues/${child.id}/ask-user`)
      .set("x-test-agent-id", devId)
      .set("x-test-company-id", companyId)
      .send({ question: "Should missing spouse income default to zero?" });

    expect(res.status).toBe(202);
    expect(res.body.routedToManager).toBe(true);
    expect(res.body.routedToAgentId).toBe(emId);
    expect(res.body.routedCommentId).toBeTruthy();
    expect(res.body.issue.status).toBe("blocked");
    expect(res.body.issue.awaitingUserSince).toBeNull();
    expect(res.body.issue.latestUserFacingAgentMessage).toBeNull();

    const managerQuestions = await handle.db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, child.id), eq(issueComments.kind, "manager_question"), isNull(issueComments.answeredAt)));
    expect(managerQuestions).toHaveLength(1);
    expect(managerQuestions[0]!.body).toContain("spouse income");

    const userQuestions = await handle.db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, child.id), eq(issueComments.kind, "question"), isNull(issueComments.answeredAt)));
    expect(userQuestions).toHaveLength(0);

    const emRuns = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, emId));
    expect(emRuns.some((run) => {
      const context = run.contextSnapshot as Record<string, unknown> | null;
      return context?.wakeReason === "internal_question_routed_to_manager" &&
        context?.issueId === parent.id &&
        context?.childIssueId === child.id &&
        context?.wakeCommentId === managerQuestions[0]!.id &&
        String(context?.recommendedNextAction ?? "").includes("Escalate to the human only");
    })).toBe(true);
  });

  it("answers an internal manager question and wakes the child with task session context", async () => {
    const { child } = await createParentAndChild("Answer internal question");
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
      sessionParamsJson: { sessionId: "route-session-child", cwd: "/tmp/buku-audit" },
      sessionDisplayId: "route-session-child",
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

    const res = await request(app)
      .post(`/api/issues/${child.id}/internal-questions/${question.id}/answer`)
      .set("x-test-agent-id", emId)
      .set("x-test-company-id", companyId)
      .send({
        answer: "Use zero for missing spouse income and cover it with a regression test.",
        assumption: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.issue.status).toBe("in_progress");
    expect(res.body.remainingOpenQuestions).toBe(0);
    expect(res.body.answerComment.kind).toBe("manager_answer");
    expect(res.body.answerComment.body).toContain("Assumption:");

    const childRuns = await handle.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, devId));
    expect(childRuns.some((run) => {
      const context = run.contextSnapshot as Record<string, unknown> | null;
      return context?.wakeReason === "manager_question_answered" &&
        context?.wakeCommentId === res.body.answerComment.id &&
        context?.managerAnswerBody &&
        run.sessionIdBefore === "route-session-child";
    })).toBe(true);
  });
});
