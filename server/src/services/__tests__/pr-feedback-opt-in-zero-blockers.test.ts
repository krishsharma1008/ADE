// F12 (e2e-run-2026-06-10 finding #12): clicking "Let agents fix" on a PR with ZERO
// pending blockers (e.g. the human is about to merge / already approved) must not
// burn a wasted agent wake — there is nothing to fix.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyIntegrations,
  issues,
} from "@combyne/db";
import { issuePullRequestService } from "../issue-pull-requests.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("F12: feedback opt-in with zero blockers skips the wake", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "OptIn Co", issuePrefix: "OPT" })
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
        token: "test-token",
        defaultRepo: "opt-repo",
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockGitHub(opts: { pullNumber: number; headSha: string; changesRequested: boolean }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes(`/pulls/${opts.pullNumber}/reviews`)) {
        const reviews = opts.changesRequested
          ? [
              {
                id: 1,
                user: { login: "reviewer" },
                state: "CHANGES_REQUESTED",
                body: "Please add .encode() before buildAndExpand.",
                submitted_at: "2026-06-10T00:00:00Z",
              },
            ]
          : [];
        return new Response(JSON.stringify(reviews), { status: 200 });
      }
      if (href.includes("/check-runs")) {
        return new Response(
          JSON.stringify({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] }),
          { status: 200 },
        );
      }
      if (href.includes(`/pulls/${opts.pullNumber}`)) {
        return new Response(
          JSON.stringify({
            id: opts.pullNumber,
            number: opts.pullNumber,
            title: "feat: opt-in probe",
            body: null,
            state: "open",
            draft: false,
            user: { login: "engineer" },
            head: { ref: `feat/OPT-${opts.pullNumber}/x`, sha: opts.headSha },
            base: { ref: "main", repo: { default_branch: "main" } },
            merged: false,
            mergeable: true,
            merge_commit_sha: null,
            merged_at: null,
            created_at: "2026-06-10T00:00:00Z",
            updated_at: "2026-06-10T00:00:00Z",
            html_url: `https://github.test/pull/${opts.pullNumber}`,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
  }

  async function trackPr(pullNumber: number) {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: `Opt-in ticket ${pullNumber}`, status: "in_progress", assigneeAgentId: agentId })
      .returning();
    const svc = issuePullRequestService(handle.db);
    const pr = await svc.upsertForIssue({
      companyId,
      issueId: issue.id,
      requestedByAgentId: agentId,
      repo: "krish-buku/opt-repo",
      pullNumber,
      pullUrl: `https://github.test/pull/${pullNumber}`,
      title: "feat: opt-in probe",
      baseBranch: "main",
      headBranch: `feat/OPT-${pullNumber}/x`,
      headSha: `sha-${pullNumber}`,
      mergeMethod: "squash",
    });
    return { svc, pr };
  }

  async function wakeCount() {
    const rows = await handle.db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    return rows.length;
  }

  it("zero blockers -> opt-in dispatches nothing", async () => {
    const { svc, pr } = await trackPr(31);
    mockGitHub({ pullNumber: 31, headSha: "sha-31", changesRequested: false });

    const before = await wakeCount();
    const result = await svc.setFeedbackOptIn(pr.id, true, {
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    const after = await wakeCount();

    expect(after - before).toBe(0);
    expect(result.dispatched?.wakeRunId ?? null).toBeNull();
  });

  it("pending change-request blockers -> opt-in wakes exactly once", async () => {
    const { svc, pr } = await trackPr(32);
    mockGitHub({ pullNumber: 32, headSha: "sha-32", changesRequested: true });

    const before = await wakeCount();
    const result = await svc.setFeedbackOptIn(pr.id, true, {
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    const after = await wakeCount();

    expect(after - before).toBe(1);
    expect(result.dispatched?.wakeRunId).toBeTruthy();
  });
});
