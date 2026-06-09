// Server-side backstop for the production-remote guardrail: the PR-tracking
// endpoint must refuse to track a PR whose repo is not on the push allowlist,
// even though the per-workspace pre-push hook is the first line of defense.

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { agents, companies, issues } from "@combyne/db";
import { issuePullRequestRoutes } from "../issue-pull-requests.js";
import { errorHandler } from "../../middleware/index.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "../../services/__tests__/_test-db.js";
import { ALLOWED_PUSH_REMOTE_PATTERNS_ENV } from "../../services/push-remote-allowlist.js";

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
  app.use("/api", issuePullRequestRoutes(handle.db));
  app.use(errorHandler);
  return app;
}

describe("issue PR tracking — repo allowlist backstop", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  let issueId: string;
  const priorEnv = process.env[ALLOWED_PUSH_REMOTE_PATTERNS_ENV];

  beforeAll(async () => {
    handle = await startTestDb();
    app = createApp(handle);
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "PR Guard Co", issuePrefix: "PRG" })
      .returning();
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId: company.id, name: "Engineer", adapterType: "process" })
      .returning();
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId: company.id, title: "Ship safely", status: "in_progress", assigneeAgentId: agent.id })
      .returning();
    issueId = issue.id;
  });

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(() => {
    process.env[ALLOWED_PUSH_REMOTE_PATTERNS_ENV] = "acme/widget-test,acme/*-test";
  });

  afterEach(() => {
    if (priorEnv === undefined) delete process.env[ALLOWED_PUSH_REMOTE_PATTERNS_ENV];
    else process.env[ALLOWED_PUSH_REMOTE_PATTERNS_ENV] = priorEnv;
  });

  const body = (repo: string) => ({
    repo,
    pullNumber: 7,
    pullUrl: `https://github.com/${repo}/pull/7`,
    title: "Add feature",
    baseBranch: "main",
    headBranch: "feature",
  });

  it("rejects tracking a PR for a non-allowlisted (production) repo with a 4xx", async () => {
    const res = await request(app)
      .post(`/api/issues/${issueId}/pull-requests`)
      .send(body("bukuwarung/fs-bnpl-service"));
    expect(res.status).toBe(422);
    expect(res.body.repo).toBe("bukuwarung/fs-bnpl-service");
    expect(String(res.body.error)).toMatch(/allowlist/i);
  });

  it("allows tracking a PR for an allowlisted test repo", async () => {
    const res = await request(app)
      .post(`/api/issues/${issueId}/pull-requests`)
      .send(body("acme/widget-test"));
    expect(res.status).toBe(201);
    expect(res.body.repo).toBe("acme/widget-test");
  });

  it("fails OPEN when the allowlist env is unset (the per-workspace pre-push hook is the primary guard, so the backstop must not break PR tracking for deployments that haven't adopted the env)", async () => {
    delete process.env[ALLOWED_PUSH_REMOTE_PATTERNS_ENV];
    const res = await request(app)
      .post(`/api/issues/${issueId}/pull-requests`)
      .send(body("acme/widget-test"));
    expect(res.status).toBe(201);
  });
});
