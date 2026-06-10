// WS-B: fine-grained per-company agent capabilities for GitHub/Jira.
// Covers: resolver defaults + env override matrix, the agent-reachable
// PR-tracking gate, capability PATCH preserving secrets, and the gh CLI
// section of the GitHub test endpoint (execFile mocked).

import express from "express";
import request from "supertest";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  resolveGithubAgentCapabilities,
  resolveJiraAgentCapabilities,
} from "@combyne/shared";
import { agents, companies, companyIntegrations, issues } from "@combyne/db";
import { eq } from "drizzle-orm";
import { integrationRoutes } from "../integrations.js";
import { issuePullRequestRoutes } from "../issue-pull-requests.js";
import { errorHandler } from "../../middleware/index.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "../../services/__tests__/_test-db.js";

vi.mock("../../services/github-cli.js", () => ({
  testGhCli: vi.fn(async () => ({
    available: true,
    authenticated: true,
    login: "test-operator",
    error: null,
  })),
}));

describe("WS-B resolvers", () => {
  it("github defaults: read/push/raisePr on, mergePr off", () => {
    expect(resolveGithubAgentCapabilities(null)).toEqual({
      canRead: true,
      canPush: true,
      canRaisePr: true,
      canMergePr: false,
    });
  });

  it("github explicit config overrides defaults both directions", () => {
    expect(
      resolveGithubAgentCapabilities({ agentCapabilities: { canPush: false, canMergePr: true } }),
    ).toEqual({ canRead: true, canPush: false, canRaisePr: true, canMergePr: true });
  });

  it("jira write defaults follow env read-only; explicit config overrides", () => {
    expect(resolveJiraAgentCapabilities(null, { envReadOnly: true })).toEqual({
      canRead: true,
      canComment: false,
      canTransition: false,
      canCreateIssue: false,
    });
    expect(resolveJiraAgentCapabilities(null, { envReadOnly: false })).toEqual({
      canRead: true,
      canComment: true,
      canTransition: true,
      canCreateIssue: true,
    });
    expect(
      resolveJiraAgentCapabilities(
        { agentCapabilities: { canComment: true, canCreateIssue: false } },
        { envReadOnly: true },
      ),
    ).toMatchObject({ canComment: true, canTransition: false, canCreateIssue: false });
  });
});

describe("WS-B route gates + PATCH + CLI test", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  const actorRef: { current: Record<string, unknown> } = { current: {} };
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const appLocal = express();
    appLocal.use(express.json());
    appLocal.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actorRef.current;
      next();
    });
    appLocal.use("/api", integrationRoutes(handle.db));
    appLocal.use("/api", issuePullRequestRoutes(handle.db));
    appLocal.use(errorHandler);
    app = appLocal;

    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Caps Co", issuePrefix: "CAPS" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", adapterType: "process" })
      .returning();
    agentId = agent.id;
    await handle.db.insert(companyIntegrations).values({
      companyId,
      provider: "github",
      enabled: "true",
      config: {
        baseUrl: "https://api.github.test",
        owner: "krish-buku",
        token: "secret-token-1234",
        defaultRepo: "caps-repo",
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  afterEach(() => {
    actorRef.current = {};
  });

  function asBoard() {
    actorRef.current = {
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    };
  }

  function asAgent() {
    actorRef.current = { type: "agent", agentId, companyId, source: "agent_jwt" };
  }

  async function seedIssue() {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Caps ticket", status: "in_progress", assigneeAgentId: agentId })
      .returning();
    return issue;
  }

  async function setCaps(caps: Record<string, boolean> | undefined) {
    const [row] = await handle.db
      .select()
      .from(companyIntegrations)
      .where(eq(companyIntegrations.companyId, companyId));
    const config = { ...(row.config as Record<string, unknown>) };
    if (caps === undefined) delete config.agentCapabilities;
    else config.agentCapabilities = caps;
    await handle.db
      .update(companyIntegrations)
      .set({ config })
      .where(eq(companyIntegrations.id, row.id));
  }

  function trackPayload(pullNumber: number) {
    return {
      repo: "krish-buku/caps-repo-test",
      pullNumber,
      pullUrl: `https://github.test/pull/${pullNumber}`,
      title: "feat: caps",
      baseBranch: "main",
      headBranch: `feat/CAPS-${pullNumber}/x`,
      headSha: `sha-${pullNumber}`,
      mergeMethod: "squash",
    };
  }

  it("agent PR tracking is 403 when canRaisePr=false, allowed by default, board unaffected", async () => {
    const issue = await seedIssue();
    await setCaps({ canRaisePr: false });

    asAgent();
    const denied = await request(app)
      .post(`/api/issues/${issue.id}/pull-requests`)
      .send(trackPayload(41));
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("canRaisePr");

    asBoard();
    const boardOk = await request(app)
      .post(`/api/issues/${issue.id}/pull-requests`)
      .send(trackPayload(42));
    expect(boardOk.status).toBe(201);

    await setCaps(undefined);
    asAgent();
    const issue2 = await seedIssue();
    const allowed = await request(app)
      .post(`/api/issues/${issue2.id}/pull-requests`)
      .send(trackPayload(43));
    expect(allowed.status).toBe(201);
  });

  it("PATCH agentCapabilities preserves the stored token and is reflected as effective caps", async () => {
    asBoard();
    const res = await request(app)
      .patch(`/api/companies/${companyId}/integrations/github`)
      .send({ agentCapabilities: { canMergePr: true, canPush: false } });
    expect(res.status).toBe(200);
    expect(res.body.effectiveAgentCapabilities).toMatchObject({
      canMergePr: true,
      canPush: false,
      canRaisePr: true,
    });

    const [row] = await handle.db
      .select()
      .from(companyIntegrations)
      .where(eq(companyIntegrations.companyId, companyId));
    const config = row.config as Record<string, unknown>;
    expect(config.token).toBe("secret-token-1234"); // untouched
    expect(config.agentCapabilities).toEqual({ canMergePr: true, canPush: false });

    await setCaps(undefined); // reset for other tests
  });

  it("GitHub test endpoint reports REST + gh CLI status", async () => {
    asBoard();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ login: "krish-buku" }), { status: 200 });
    });
    try {
      const res = await request(app)
        .post(`/api/companies/${companyId}/integrations/github/test`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.cli).toEqual({
        available: true,
        authenticated: true,
        login: "test-operator",
        error: null,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
