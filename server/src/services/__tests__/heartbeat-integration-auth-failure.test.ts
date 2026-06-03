import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issueComments, issues } from "@combyne/db";
import {
  inferAuthUrlForProvider,
  pauseIssueForIntegrationAuth,
  trackConsecutiveAuthFailure,
} from "../heartbeat.js";
import { detectMcpToolAuthError } from "@combyne/adapter-claude-local/server";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

// Reproduce the exact adapter logic from claude-local/execute.ts toAdapterResult:
// an MCP 401 at exit 0 yields a NON-NULL errorMessage + an
// integration_auth_required:<provider> errorCode (never nulled at exit 0).
function toAdapterErrorFields(stdout: string, exitCode: number) {
  const mcpAuth = detectMcpToolAuthError(stdout);
  const provider = mcpAuth.provider ?? "integration";
  const errorCode = mcpAuth.requiresAuth ? `integration_auth_required:${provider}` : null;
  const errorMessage = mcpAuth.requiresAuth
    ? `${provider} auth required`
    : exitCode === 0
      ? null
      : "Claude failed";
  return { errorCode, errorMessage, mcpAuth };
}

// Mirror the heartbeat outcome decision (without driving a real adapter
// process): the auth-code branch is checked BEFORE the exit-0 success check.
function decideOutcome(input: {
  status?: string;
  timedOut?: boolean;
  exitCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}): "succeeded" | "failed" | "cancelled" | "timed_out" {
  if (input.status === "cancelled") return "cancelled";
  if (input.timedOut) return "timed_out";
  if (input.errorCode?.startsWith("integration_auth_required")) return "failed";
  if ((input.exitCode ?? 0) === 0 && !input.errorMessage) return "succeeded";
  return "failed";
}

const ATLASSIAN_401_STDOUT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-4" }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "mcp__claude_ai_Atlassian__getJiraIssue", input: {} },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: true,
          content: [{ type: "text", text: "Request failed with status 401: Unauthorized" }],
        },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "s1",
    result: "Looked at the ticket.",
    total_cost_usd: 0.02,
  }),
].join("\n");

describe("heartbeat integration auth failure loop (Issue 3)", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;

  async function seedIssue(status = "in_progress") {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Sync Jira ticket", status, assigneeAgentId: agentId })
      .returning();
    return issue.id;
  }

  async function seedRun(input: {
    issueId: string;
    status: string;
    errorCode: string | null;
    finishedAt?: Date;
  }) {
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: input.status,
        invocationSource: "on_demand",
        errorCode: input.errorCode,
        finishedAt: input.finishedAt ?? new Date(),
        contextSnapshot: { issueId: input.issueId },
      })
      .returning();
    return run;
  }

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Integration Auth Test Co", issuePrefix: "IAT" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Jira Bot", adapterType: "claude_local" })
      .returning();
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("adapter yields a non-null errorMessage + integration_auth_required code at exit 0", () => {
    const fields = toAdapterErrorFields(ATLASSIAN_401_STDOUT, 0);
    expect(fields.mcpAuth.requiresAuth).toBe(true);
    expect(fields.errorCode).toBe("integration_auth_required:atlassian");
    // The exit-0 success path must NOT null the error message.
    expect(fields.errorMessage).toBe("atlassian auth required");
  });

  it("forces outcome=failed for an exit-0 MCP 401 (never auto-closes)", () => {
    const fields = toAdapterErrorFields(ATLASSIAN_401_STDOUT, 0);
    const outcome = decideOutcome({
      exitCode: 0,
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
    });
    expect(outcome).toBe("failed");
  });

  it("a successful run with no MCP auth error still succeeds", () => {
    const okStdout = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "s2",
      result: "All good.",
    });
    const fields = toAdapterErrorFields(okStdout, 0);
    expect(fields.errorCode).toBeNull();
    expect(decideOutcome({ exitCode: 0, errorCode: null, errorMessage: null })).toBe("succeeded");
  });

  it("transitions the issue to awaiting_user and posts a provider auth link", async () => {
    const issueId = await seedIssue("in_progress");
    const fields = toAdapterErrorFields(ATLASSIAN_401_STDOUT, 0);
    const run = await seedRun({ issueId, status: "failed", errorCode: fields.errorCode });

    const result = await pauseIssueForIntegrationAuth(handle.db, {
      run,
      agent: { id: agentId, name: "Jira Bot" },
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
    });

    expect(result.paused).toBe(true);
    expect(result.breakerTripped).toBe(false);

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("awaiting_user");
    // Never closed.
    expect(issue.status).not.toBe("done");

    const comments = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    const authUrl = inferAuthUrlForProvider("atlassian");
    expect(comments[0].body).toContain(authUrl);
    expect(comments[0].body.toLowerCase()).toContain("authentication");
    // The pause comment should NOT be the breaker comment yet.
    expect(comments[0].body).not.toContain("pausing automatic retries");
  });

  it("does not flip a done/cancelled issue back to awaiting_user", async () => {
    const issueId = await seedIssue("done");
    const fields = toAdapterErrorFields(ATLASSIAN_401_STDOUT, 0);
    const run = await seedRun({ issueId, status: "failed", errorCode: fields.errorCode });

    const result = await pauseIssueForIntegrationAuth(handle.db, {
      run,
      agent: { id: agentId, name: "Jira Bot" },
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
    });
    expect(result.paused).toBe(false);
    expect(result.reason).toBe("status_done");

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("done");
  });

  it("does not resurrect a CANCELLED issue mid-escalation (guarded update)", async () => {
    // Edge case: the human cancelled the issue while an auth-failed run was in
    // flight. The pause must be a no-op and post no comment — no resurrection.
    const issueId = await seedIssue("cancelled");
    const fields = toAdapterErrorFields(ATLASSIAN_401_STDOUT, 0);
    const run = await seedRun({ issueId, status: "failed", errorCode: fields.errorCode });

    const result = await pauseIssueForIntegrationAuth(handle.db, {
      run,
      agent: { id: agentId, name: "Jira Bot" },
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
    });
    expect(result.paused).toBe(false);
    expect(result.reason).toBe("status_cancelled");

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("cancelled");
    const comments = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("is idempotent on a repeated pause — lands awaiting_user once (coexistence safe)", async () => {
    // Models the coexistence path: an auth failure pauses to awaiting_user, and
    // a second pause (e.g. the small-task hardPause branch also firing) must
    // leave the issue at awaiting_user, never bouncing it elsewhere.
    const issueId = await seedIssue("in_progress");
    const fields = toAdapterErrorFields(ATLASSIAN_401_STDOUT, 0);
    const run = await seedRun({ issueId, status: "failed", errorCode: fields.errorCode });

    const first = await pauseIssueForIntegrationAuth(handle.db, {
      run,
      agent: { id: agentId, name: "Jira Bot" },
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
    });
    expect(first.paused).toBe(true);

    const second = await pauseIssueForIntegrationAuth(handle.db, {
      run,
      agent: { id: agentId, name: "Jira Bot" },
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
    });
    // awaiting_user is not done/cancelled, so the guard still allows the pause,
    // but the issue stays at awaiting_user (no resurrection / bounce).
    expect(second.paused).toBe(true);

    const [issue] = await handle.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("awaiting_user");
  });

  it("falls back to a localhost dashboard URL for an unknown provider when COMBYNE_PUBLIC_URL is unset", () => {
    const prevPublic = process.env.COMBYNE_PUBLIC_URL;
    const prevPort = process.env.PORT;
    delete process.env.COMBYNE_PUBLIC_URL;
    delete process.env.PORT;
    try {
      const url = inferAuthUrlForProvider("acme-internal");
      // No public dashboard configured -> localhost loopback, not an external host.
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/settings\/integrations\/acme-internal$/);
    } finally {
      if (prevPublic !== undefined) process.env.COMBYNE_PUBLIC_URL = prevPublic;
      if (prevPort !== undefined) process.env.PORT = prevPort;
    }
  });

  it("trips the circuit breaker after 3 consecutive same-provider failures and posts a breaker comment", async () => {
    const issueId = await seedIssue("in_progress");
    const errorCode = "integration_auth_required:atlassian";

    // Two prior failed auth runs already on the books in the 24h window.
    await seedRun({ issueId, status: "failed", errorCode, finishedAt: new Date(Date.now() - 60_000) });
    await seedRun({ issueId, status: "failed", errorCode, finishedAt: new Date(Date.now() - 30_000) });
    // The current (3rd) failed run.
    const currentRun = await seedRun({ issueId, status: "failed", errorCode });

    const tracked = await trackConsecutiveAuthFailure(handle.db, {
      issueId,
      provider: "atlassian",
      companyId,
      agentId,
    });
    expect(tracked.count).toBe(3);
    expect(tracked.breakerTripped).toBe(true);

    const result = await pauseIssueForIntegrationAuth(handle.db, {
      run: currentRun,
      agent: { id: agentId, name: "Jira Bot" },
      errorCode,
      errorMessage: "atlassian auth required",
    });
    expect(result.paused).toBe(true);
    expect(result.breakerTripped).toBe(true);
    expect(result.reason).toBe("integration_auth_breaker_tripped");

    const comments = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const breakerComment = comments.find((c) => c.body.includes("pausing automatic retries"));
    expect(breakerComment).toBeTruthy();
    expect(breakerComment!.body).toContain(inferAuthUrlForProvider("atlassian"));
  });

  it("does not count in-progress runs or other providers toward the breaker", async () => {
    const issueId = await seedIssue("in_progress");
    // A still-running run (status != failed) must NOT count.
    await seedRun({ issueId, status: "running", errorCode: "integration_auth_required:atlassian" });
    // A different provider must NOT count.
    await seedRun({ issueId, status: "failed", errorCode: "integration_auth_required:linear" });
    // Only one matching failed atlassian run.
    await seedRun({ issueId, status: "failed", errorCode: "integration_auth_required:atlassian" });

    const tracked = await trackConsecutiveAuthFailure(handle.db, {
      issueId,
      provider: "atlassian",
      companyId,
      agentId,
    });
    expect(tracked.count).toBe(1);
    expect(tracked.breakerTripped).toBe(false);
  });

  it("does not count failures outside the 24h window", async () => {
    const issueId = await seedIssue("in_progress");
    const errorCode = "integration_auth_required:atlassian";
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedRun({ issueId, status: "failed", errorCode, finishedAt: old });
    await seedRun({ issueId, status: "failed", errorCode, finishedAt: old });
    await seedRun({ issueId, status: "failed", errorCode });

    const tracked = await trackConsecutiveAuthFailure(handle.db, {
      issueId,
      provider: "atlassian",
      companyId,
      agentId,
    });
    expect(tracked.count).toBe(1);
    expect(tracked.breakerTripped).toBe(false);
  });

  it("infers known provider auth URLs and falls back to dashboard settings for unknown ones", () => {
    expect(inferAuthUrlForProvider("atlassian")).toMatch(/atlassian\.com/);
    expect(inferAuthUrlForProvider("linear")).toMatch(/linear\.app/);
    expect(inferAuthUrlForProvider("slack")).toMatch(/slack\.com/);
    expect(inferAuthUrlForProvider("supabase")).toMatch(/supabase\.com/);
    expect(inferAuthUrlForProvider("some-unknown")).toContain("/settings/integrations/some-unknown");
  });
});
