// F9 (e2e-run-2026-06-10 finding #9): the no-verifiable-artifact gate trusted only
// self-reported signals (changedFiles + tracked PR rows), so a run that pushed a
// branch AND opened a PR — but exited before tracking it — was flagged artifact-less
// and re-queued (wasteful re-run loop). The gate now cross-checks GitHub: an open PR
// whose head branch carries the issue identifier is auto-tracked; a pushed branch
// with no PR enriches the advisory instead of leaving a dead-end message.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyIntegrations,
  heartbeatRuns,
  issueComments,
  issuePullRequests,
  issues,
} from "@combyne/db";
import { autoCloseIssueAfterSuccessfulRun } from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("F9: artifact gate cross-checks GitHub before declaring no-artifact", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let runId: string;
  let seq = 0;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Crosscheck Co", issuePrefix: "XCK" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", adapterType: "process" })
      .returning();
    agentId = agent.id;
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "succeeded", invocationSource: "on_demand" })
      .returning();
    runId = run.id;
    await handle.db.insert(companyIntegrations).values({
      companyId,
      provider: "github",
      enabled: "true",
      config: {
        baseUrl: "https://api.github.test",
        owner: "krish-buku",
        token: "test-token",
        defaultRepo: "xck-repo",
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedIssue() {
    seq += 1;
    const identifier = `XCK-${seq}`;
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: `Code ticket ${identifier}`,
        identifier,
        status: "in_progress",
        complexity: "small",
        assigneeAgentId: agentId,
      })
      .returning();
    return { issue, identifier };
  }

  function mockGitHub(opts: { openPrHead?: string; branch?: string; fail?: boolean }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (opts.fail) throw new Error("github unreachable");
      const href = String(url);
      if (href.includes("/pulls?state=open")) {
        const prs = opts.openPrHead
          ? [
              {
                id: 900,
                number: 9,
                title: "refactor: the work",
                body: null,
                state: "open",
                draft: false,
                user: { login: "engineer" },
                head: { ref: opts.openPrHead, sha: "headsha9" },
                base: { ref: "staging", repo: { default_branch: "staging" } },
                merged: false,
                mergeable: true,
                merge_commit_sha: null,
                merged_at: null,
                created_at: "2026-06-10T00:00:00Z",
                updated_at: "2026-06-10T00:00:00Z",
                html_url: "https://github.test/pull/9",
              },
            ]
          : [];
        return new Response(JSON.stringify(prs), { status: 200 });
      }
      if (href.includes("/branches")) {
        const branches = opts.branch
          ? [{ name: opts.branch, commit: { sha: "branchsha" }, protected: false }]
          : [];
        return new Response(JSON.stringify(branches), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
  }

  function gateInput(issueId: string) {
    return {
      companyId,
      agentId,
      runId,
      issueId,
      requiresArtifact: true,
      changedFiles: [] as string[],
      repoUrl: "https://github.com/krish-buku/xck-repo.git",
    };
  }

  it("auto-tracks an untracked open PR matching the issue identifier instead of awaiting_user", async () => {
    const { issue, identifier } = await seedIssue();
    mockGitHub({ openPrHead: `feat/${identifier}/refactor-thing` });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, gateInput(issue.id));
    expect(result.reason).not.toBe("no_artifact");

    const [tracked] = await handle.db
      .select()
      .from(issuePullRequests)
      .where(
        and(eq(issuePullRequests.issueId, issue.id), eq(issuePullRequests.pullNumber, 9)),
      );
    expect(tracked).toBeTruthy();
    expect(tracked.repo).toBe("krish-buku/xck-repo");

    const [after] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after.status).not.toBe("awaiting_user");

    const comments = await handle.db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comments.some((c) => c.body.includes("auto-tracked"))).toBe(true);
  });

  it("pushed branch without a PR keeps awaiting_user but names the branch in the advisory", async () => {
    const { issue, identifier } = await seedIssue();
    mockGitHub({ branch: `feat/${identifier}/half-done` });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, gateInput(issue.id));
    expect(result.reason).toBe("no_artifact");

    const [after] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after.status).toBe("awaiting_user");

    const comments = await handle.db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comments.some((c) => c.body.includes(`feat/${identifier}/half-done`))).toBe(true);
  });

  it("nothing found on GitHub -> unchanged no-artifact advisory (regression)", async () => {
    const { issue } = await seedIssue();
    mockGitHub({});

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, gateInput(issue.id));
    expect(result.reason).toBe("no_artifact");
    const [after] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after.status).toBe("awaiting_user");
  });

  it("GitHub unreachable -> soft-fail to the no-artifact path", async () => {
    const { issue } = await seedIssue();
    mockGitHub({ fail: true });

    const result = await autoCloseIssueAfterSuccessfulRun(handle.db, gateInput(issue.id));
    expect(result.reason).toBe("no_artifact");
    const [after] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after.status).toBe("awaiting_user");
  });
});
