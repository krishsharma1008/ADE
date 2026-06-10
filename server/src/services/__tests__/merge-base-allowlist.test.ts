// F8 (e2e-run-2026-06-10 finding #8): the merge-base allowlist was one global env
// list, so staging-default repos ("staging" is origin/HEAD on the BukuWarung test
// mirrors) could never be merged from the dashboard — humans were forced into
// out-of-band GitHub merges, which then stranded pipeline state (finding #13).
// reconcile() now resolves the allowlist per repo: static/env list ∪ the PR base
// repo's own default branch ∪ project_workspaces.metadata.allowedMergeBases for
// workspaces whose repoUrl (any ssh/https/.git form) matches the PR repo.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyIntegrations,
  issuePullRequests,
  issues,
  projects,
  projectWorkspaces,
} from "@combyne/db";
import { issuePullRequestService } from "../issue-pull-requests.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("F8: per-repo merge-base allowlist", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let projectId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Merge Base Co", issuePrefix: "MBC" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", adapterType: "process" })
      .returning();
    agentId = agent.id;
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId, name: "Mirror Project" })
      .returning();
    projectId = project.id;
    await handle.db.insert(companyIntegrations).values({
      companyId,
      provider: "github",
      enabled: "true",
      config: {
        baseUrl: "https://api.github.test",
        owner: "krish-buku",
        token: "test-token",
        defaultRepo: "fs-brick-service-test",
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockGitHub(opts: {
    pullNumber: number;
    headSha: string;
    baseBranch: string;
    baseRepoDefaultBranch: string;
  }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes(`/pulls/${opts.pullNumber}/reviews`)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (href.includes(`/commits/${opts.headSha}/check-runs`)) {
        return new Response(
          JSON.stringify({
            check_runs: [
              { id: 1, name: "build", status: "completed", conclusion: "success" },
            ],
          }),
          { status: 200 },
        );
      }
      if (href.includes(`/pulls/${opts.pullNumber}`)) {
        return new Response(
          JSON.stringify({
            id: opts.pullNumber,
            number: opts.pullNumber,
            title: "feat: change",
            body: null,
            state: "open",
            draft: false,
            user: { login: "engineer" },
            head: { ref: "feat/X-1/change", sha: opts.headSha },
            base: {
              ref: opts.baseBranch,
              repo: { default_branch: opts.baseRepoDefaultBranch },
            },
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

  async function seedTrackedPr(opts: { repo: string; pullNumber: number; baseBranch: string }) {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: `Ticket for PR ${opts.pullNumber}`, status: "in_progress", assigneeAgentId: agentId })
      .returning();
    const svc = issuePullRequestService(handle.db);
    const pr = await svc.upsertForIssue({
      companyId,
      issueId: issue.id,
      requestedByAgentId: agentId,
      repo: opts.repo,
      pullNumber: opts.pullNumber,
      pullUrl: `https://github.test/pull/${opts.pullNumber}`,
      title: "feat: change",
      baseBranch: opts.baseBranch,
      headBranch: "feat/X-1/change",
      headSha: `sha-${opts.pullNumber}`,
      mergeMethod: "squash",
    });
    return { svc, pr };
  }

  async function blockersAfterReconcile(prId: string) {
    const [row] = await handle.db
      .select({ metadata: issuePullRequests.metadata })
      .from(issuePullRequests)
      .where(eq(issuePullRequests.id, prId));
    return ((row.metadata as Record<string, unknown>)?.blockers ?? []) as string[];
  }

  it("workspace metadata.allowedMergeBases admits staging (ssh-form repoUrl match)", async () => {
    await handle.db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "brick mirror",
      repoUrl: "git@github.com:krish-buku/fs-brick-service-test.git",
      metadata: { allowedMergeBases: ["staging"] },
    });
    const { svc, pr } = await seedTrackedPr({
      repo: "krish-buku/fs-brick-service-test",
      pullNumber: 11,
      baseBranch: "staging",
    });
    mockGitHub({ pullNumber: 11, headSha: "sha-11", baseBranch: "staging", baseRepoDefaultBranch: "main" });

    await svc.reconcile(pr.id);
    const blockers = await blockersAfterReconcile(pr.id);
    expect(blockers.find((b) => b.includes("not merge-allowed"))).toBeUndefined();
  });

  it("the base repo's own default branch is auto-allowed without any config", async () => {
    const { svc, pr } = await seedTrackedPr({
      repo: "krish-buku/other-repo",
      pullNumber: 12,
      baseBranch: "trunk",
    });
    mockGitHub({ pullNumber: 12, headSha: "sha-12", baseBranch: "trunk", baseRepoDefaultBranch: "trunk" });

    await svc.reconcile(pr.id);
    const blockers = await blockersAfterReconcile(pr.id);
    expect(blockers.find((b) => b.includes("not merge-allowed"))).toBeUndefined();
  });

  it("a non-default, non-allowlisted base branch is still blocked", async () => {
    const { svc, pr } = await seedTrackedPr({
      repo: "krish-buku/other-repo",
      pullNumber: 13,
      baseBranch: "random-branch",
    });
    mockGitHub({
      pullNumber: 13,
      headSha: "sha-13",
      baseBranch: "random-branch",
      baseRepoDefaultBranch: "main",
    });

    await svc.reconcile(pr.id);
    const blockers = await blockersAfterReconcile(pr.id);
    expect(blockers.find((b) => b.includes("`random-branch` is not merge-allowed"))).toBeTruthy();
  });
});
