import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { agents, companies, issueComments, issues } from "@combyne/db";
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

function createApp(handle: TestDbHandle, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(handle.db, createStorageStub() as never));
  app.use(errorHandler);
  return app;
}

describe("agent comment question extraction", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let app: express.Express;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Agent Comment Question Co", issuePrefix: "ACQ" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Asking Agent", adapterType: "process" })
      .returning();
    agentId = agent.id;
    app = createApp(handle, {
      type: "agent",
      agentId,
      companyId,
      source: "api_key",
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("turns agent plain comments with option-style questions into UI answer cards", async () => {
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Theme direction",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      })
      .returning();

    const body = `
Two quick questions before I build the design direction.

**1. Background feel**
For the calm redesign:
- A) Dark stays, but calmer
- B) Light / off-white

**2. Reference site**
Is there a site that already feels like the vibe you want?
- A) Linear.app
- B) Loom / Notion
`;

    const res = await request(app)
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body });
    expect(res.status).toBe(201);

    const questions = await handle.db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue.id),
          eq(issueComments.kind, "question"),
          isNull(issueComments.answeredAt),
        ),
      );
    expect(questions).toHaveLength(2);
    expect(questions[0]?.body).toContain("Background feel");
    expect(questions[0]?.choices).toEqual(
      expect.arrayContaining([expect.stringContaining("A) Dark stays")]),
    );
    expect(questions[1]?.choices).toEqual(
      expect.arrayContaining([expect.stringContaining("B) Loom")]),
    );

    const [updated] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(updated.status).toBe("awaiting_user");
    expect(updated.awaitingUserSince).not.toBeNull();
  });
});
