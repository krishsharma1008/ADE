// Phase 3 (b2): answering a board question on a blocked-on-agent issue clears the
// self-block and wakes the assignee — a sibling branch to the existing
// remaining===0 && awaiting_user path. The negative case (an awaiting_user issue with
// the same Q&A) must still take the OLD branch (svc.update → in_progress, no block
// fields to clear because it was never blocked).

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, issueComments, issues } from "@combyne/db";
import { issueRoutes } from "../issues.js";
import { errorHandler } from "../../middleware/index.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "../../services/__tests__/_test-db.js";

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
    (req as unknown as { actor: Record<string, unknown> }).actor = {
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", issueRoutes(handle.db, createStorageStub() as never));
  app.use(errorHandler);
  return app;
}

describe("answer-question wake for blocked-on-agent issues (b2)", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    app = createApp(handle);
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Answer Wake Co", issuePrefix: "ANS" })
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

  async function seedQuestion(issueId: string) {
    const [question] = await handle.db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorAgentId: agentId,
        body: "Should I ship behind a flag or hard-cut?",
        kind: "question",
      })
      .returning();
    return question.id;
  }

  // Count user_responded wake attempts for the assignee. Both the new self-block
  // branch and the old awaiting_user branch wake with reason=user_responded; the b2
  // test snapshots this before/after its own call to isolate the single new wake.
  async function countUserRespondedWakes() {
    const rows = await handle.db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "user_responded"),
        ),
      );
    return rows.length;
  }

  it("clears the block and wakes the assignee when a blocked+agent issue's question is answered", async () => {
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Blocked on a board decision",
        status: "blocked",
        blockedSource: "agent",
        blockedReason: "need a product call",
        blockedAt: new Date(),
        latestUserFacingAgentMessage: "Waiting on a decision",
        assigneeAgentId: agentId,
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning();
    const questionId = await seedQuestion(issue.id);
    const before = await countUserRespondedWakes();

    const res = await request(app)
      .post(`/api/issues/${issue.id}/answer-question`)
      .send({ questionCommentId: questionId, answer: "Ship behind a flag." });
    expect(res.status).toBe(201);

    const [updated] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(updated.status).toBe("in_progress");
    expect(updated.blockedSource).toBeNull();
    expect(updated.blockedReason).toBeNull();
    expect(updated.blockedAt).toBeNull();
    expect(updated.awaitingUserSince).toBeNull();
    expect(updated.latestUserFacingAgentMessage).toBeNull();

    const after = await countUserRespondedWakes();
    expect(after - before).toBe(1);
  });

  it("still takes the old awaiting_user branch when the issue is awaiting_user (not blocked)", async () => {
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Awaiting a user answer",
        status: "awaiting_user",
        awaitingUserSince: new Date(),
        assigneeAgentId: agentId,
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning();
    const questionId = await seedQuestion(issue.id);

    const res = await request(app)
      .post(`/api/issues/${issue.id}/answer-question`)
      .send({ questionCommentId: questionId, answer: "Go with option A." });
    expect(res.status).toBe(201);

    const [updated] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    // Old branch: svc.update flips awaiting_user -> in_progress (assignee present).
    expect(updated.status).toBe("in_progress");
    // It was never blocked, so no block fields were ever set; blockedSource stays null.
    expect(updated.blockedSource).toBeNull();
  });
});
