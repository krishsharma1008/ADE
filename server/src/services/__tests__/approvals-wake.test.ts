// Phase 3 (b1): granting an approval wakes a blocked-on-agent issue. When an agent
// self-blocks an issue (status='blocked', blockedSource='agent') pending an approval,
// approving it must clear the block with the same field set used when answering a
// manager_question AND wake the assignee. When the issue's assignee IS the approval
// requester, the existing requester-wake already fired — the block still clears but
// the assignee is woken exactly once (no duplicate).

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, issues } from "@combyne/db";
import { approvalRoutes } from "../../routes/approvals.js";
import { errorHandler } from "../../middleware/index.js";
import { approvalService, issueApprovalService } from "../index.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

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
  app.use("/api", approvalRoutes(handle.db));
  app.use(errorHandler);
  return app;
}

// Count EVERY wakeup-request row for an agent regardless of final reason/status. A
// wake that targets an issue can be re-tagged (deferred / coalesced) by the issue
// execution lock when another run already holds that issue — so the de-dupe invariant
// is "how many wake ATTEMPTS were enqueued", which is one row per enqueueWakeup call.
async function countWakeRows(handle: TestDbHandle, agentId: string) {
  const rows = await handle.db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.agentId, agentId));
  return rows.length;
}

describe("approval-grant wake for agent self-blocked issues", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  let companyId: string;
  let requesterId: string;
  let assigneeId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    app = createApp(handle);
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Approval Wake Co", issuePrefix: "AWC" })
      .returning();
    companyId = company.id;
    const [requester] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Requester", adapterType: "process" })
      .returning();
    requesterId = requester.id;
    const [assignee] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Assignee", adapterType: "process" })
      .returning();
    assigneeId = assignee.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  async function seedBlockedIssue(assigneeAgentId: string) {
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Self-blocked pending approval",
        status: "blocked",
        blockedSource: "agent",
        blockedReason: "waiting on the approval",
        blockedAt: new Date(),
        assigneeAgentId,
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning();
    return issue.id;
  }

  async function seedApproval(requestedByAgentId: string, issueId: string) {
    const approval = await approvalService(handle.db).create(companyId, {
      type: "generic",
      requestedByAgentId,
      requestedByUserId: null,
      status: "pending",
      payload: {},
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    await issueApprovalService(handle.db).linkManyForApproval(approval.id, [issueId]);
    return approval.id;
  }

  it("unblocks the linked issue and wakes the assignee when requester !== assignee", async () => {
    const issueId = await seedBlockedIssue(assigneeId);
    const approvalId = await seedApproval(requesterId, issueId);
    const requesterBefore = await countWakeRows(handle, requesterId);
    const assigneeBefore = await countWakeRows(handle, assigneeId);

    const res = await request(app).post(`/api/approvals/${approvalId}/approve`).send({});
    expect(res.status).toBe(200);

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_progress");
    expect(issue.blockedSource).toBeNull();
    expect(issue.blockedReason).toBeNull();
    expect(issue.blockedAt).toBeNull();
    expect(issue.awaitingUserSince).toBeNull();
    expect(issue.latestUserFacingAgentMessage).toBeNull();

    // Requester gets the existing requester-wake; the distinct assignee gets b1's
    // self-block wake → one fresh wake attempt enqueued per agent.
    expect((await countWakeRows(handle, requesterId)) - requesterBefore).toBe(1);
    expect((await countWakeRows(handle, assigneeId)) - assigneeBefore).toBe(1);
  });

  it("clears the block but wakes only once when assignee === requester", async () => {
    const issueId = await seedBlockedIssue(requesterId);
    const approvalId = await seedApproval(requesterId, issueId);
    const before = await countWakeRows(handle, requesterId);

    const res = await request(app).post(`/api/approvals/${approvalId}/approve`).send({});
    expect(res.status).toBe(200);

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_progress");
    expect(issue.blockedSource).toBeNull();

    // Only the requester-wake fires; the self-block branch must SKIP its own wake when
    // the assignee IS the requester, avoiding a duplicate run for the same agent.
    const after = await countWakeRows(handle, requesterId);
    expect(after - before).toBe(1);
  });
});
