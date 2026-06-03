import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  executionWorkspaces,
  issues,
  projects,
  projectWorkspaces,
} from "@combyne/db";
import { resolveWorkspaceForHeartbeatRun } from "../heartbeat.js";
import { instanceSettingsService } from "../instance-settings.js";
import { loadAssignedIssueQueue } from "../agent-queue.js";
import { validateScopeDiffBeforeAutoClose } from "../scope-diff-validator.js";
import { verifyCleanBaseCheckoutForIssue } from "../workspace-scope-guard.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createGitRepo(tmpRoot: string) {
  const repo = path.join(tmpRoot, `repo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Combyne Test"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(repo, "README.md"), "adversarial fixture\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return repo;
}

async function createFixture(
  handle: TestDbHandle,
  input: {
    tmpRoot: string;
    enableIsolation?: boolean;
    defaultIsolationMode?: "per_issue_worktree" | "shared_workspace";
    policyDefaultMode?: "shared_workspace" | "isolated_workspace";
    repo?: string;
    /** When true, use a non-git directory as the project cwd. */
    cwdOverride?: string;
  },
) {
  const repo = input.cwdOverride ?? input.repo ?? (await createGitRepo(input.tmpRoot));
  await instanceSettingsService(handle.db).updateExperimental({
    enableIsolatedWorkspaces: input.enableIsolation ?? true,
    defaultIsolationMode: input.defaultIsolationMode ?? "per_issue_worktree",
  });
  const [company] = await handle.db
    .insert(companies)
    .values({ name: "Adversarial Co" })
    .returning();
  const [agent] = await handle.db
    .insert(agents)
    .values({ companyId: company.id, name: "engineer", adapterType: "process" })
    .returning();
  const policy: Record<string, unknown> = {
    enabled: true,
    defaultMode: input.policyDefaultMode ?? "shared_workspace",
    workspaceStrategy: {
      type: "git_worktree",
      branchTemplate: "{{issue.identifier}}-{{slug}}",
    },
  };
  const [project] = await handle.db
    .insert(projects)
    .values({
      companyId: company.id,
      name: "Adversarial repo",
      executionWorkspacePolicy: policy,
    })
    .returning();
  const [workspace] = await handle.db
    .insert(projectWorkspaces)
    .values({
      companyId: company.id,
      projectId: project.id,
      name: "primary",
      cwd: repo,
      repoRef: "HEAD",
      isPrimary: true,
    })
    .returning();
  return { repo, company, agent, project, workspace };
}

async function createIssue(
  handle: TestDbHandle,
  input: {
    companyId: string;
    projectId: string;
    agentId: string;
    identifier: string;
    title: string;
  },
) {
  const [issue] = await handle.db
    .insert(issues)
    .values({
      companyId: input.companyId,
      projectId: input.projectId,
      assigneeAgentId: input.agentId,
      identifier: input.identifier,
      title: input.title,
      status: "todo",
      complexity: "small",
    })
    .returning();
  return issue;
}

describe("scope-isolation adversarial", () => {
  let handle: TestDbHandle;
  let tmpRoot: string;

  beforeEach(async () => {
    handle = await startTestDb();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-adv-"));
  }, 60_000);

  afterEach(async () => {
    if (handle) await stopTestDb();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // ── A. Follow-up wake of the SAME issue with a LIVE reusable workspace must
  //      NOT be blocked by the scope guard even when the base is filthy with
  //      another issue's work. The reuse short-circuit must win.
  it("reuses an existing per-issue worktree on a follow-up wake even when the base is dirty (no refusal)", async () => {
    const fixture = await createFixture(handle, { tmpRoot });
    const issue = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "ADV-1",
      title: "Already isolated issue",
    });

    // Pre-seed an ACTIVE reusable execution workspace for THIS issue, with a
    // real on-disk worktree dir, and point the issue at it.
    const worktreeDir = path.join(fixture.repo, ".combyne-ai", "worktrees", "adv-1-live");
    await fs.mkdir(worktreeDir, { recursive: true });
    const now = new Date();
    const [ws] = await handle.db
      .insert(executionWorkspaces)
      .values({
        companyId: fixture.company.id,
        projectId: fixture.project.id,
        projectWorkspaceId: fixture.workspace.id,
        sourceIssueId: issue.id,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "ADV-1 live workspace",
        status: "active",
        cwd: worktreeDir,
        repoUrl: null,
        baseRef: "HEAD",
        branchName: "adv-1-live",
        providerType: "git_worktree",
        providerRef: worktreeDir,
        lastUsedAt: now,
        openedAt: now,
        createdAt: now,
        updatedAt: now,
        metadata: {},
      })
      .returning();
    await handle.db
      .update(issues)
      .set({ executionWorkspaceId: ws.id, executionWorkspacePreference: "isolated_workspace" })
      .where(eq(issues.id, issue.id));

    // Contaminate the BASE checkout with a DIFFERENT issue's leftover work.
    await fs.writeFile(
      path.join(fixture.repo, "leftover-from-other-ticket.ts"),
      "export const fromAnotherTicket = true;\n",
      "utf8",
    );

    const resolved = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issue.id },
      previousSessionParams: null,
    });

    // The reuse path returns the SAME worktree, never touches the scope guard,
    // and never refuses — the dirty base is irrelevant to a same-issue reuse.
    expect(resolved.source).toBe("execution_workspace");
    expect(resolved.cwd).toBe(worktreeDir);
    expect(resolved.executionWorkspaceId).toBe(ws.id);
    expect(resolved.scopeRefusal ?? null).toBeNull();

    const refusals = await handle.db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "workspace_scope_violation"),
          eq(activityLog.entityId, issue.id),
        ),
      );
    expect(refusals).toHaveLength(0);
  }, 60_000);

  // ── B. realizeExecutionWorkspace FAILURE must degrade to the shared project
  //      checkout WITHOUT crashing or refusing. We force a realize failure by
  //      pointing the project workspace at a directory that exists (passes the
  //      isDirectory stat) but is NOT a git repo, so worktree creation fails.
  it("falls back to the shared checkout (no crash, no refusal) when worktree realization fails", async () => {
    // A plain directory that is NOT a git repo.
    const nonGitDir = path.join(tmpRoot, "not-a-git-repo");
    await fs.mkdir(nonGitDir, { recursive: true });
    await fs.writeFile(path.join(nonGitDir, "file.txt"), "hello\n", "utf8");

    const fixture = await createFixture(handle, { tmpRoot, cwdOverride: nonGitDir });
    const issue = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "ADV-2",
      title: "Worktree realize will fail",
    });

    const resolved = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issue.id },
      previousSessionParams: null,
    });

    // Must NOT throw, must NOT refuse, must land on the shared checkout.
    expect(resolved.scopeRefusal ?? null).toBeNull();
    expect(resolved.source).toBe("project_primary");
    expect(resolved.cwd).toBe(nonGitDir);
    // No isolated workspace row was persisted from the failed realize.
    const rows = await handle.db.select().from(executionWorkspaces);
    expect(rows).toHaveLength(0);
  }, 60_000);

  // ── C. terminal_session / agent_home style runs (no project workspace) must
  //      be UNTOUCHED by the scope guard — no worktree, no refusal, no
  //      execution workspace. We model this by resolving with
  //      useProjectWorkspace: false (the heartbeat sets this for non-issue /
  //      terminal runs), which prevents project-workspace resolution.
  it("does not apply the scope guard to non-project (agent_home) runs", async () => {
    const fixture = await createFixture(handle, { tmpRoot });
    const issue = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "ADV-3",
      title: "Terminal-ish run",
    });
    // Dirty base — would trip the guard on the isolated path.
    await fs.writeFile(path.join(fixture.repo, "unrelated.ts"), "x\n", "utf8");

    const resolved = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issue.id },
      previousSessionParams: null,
      useProjectWorkspace: false,
    });

    expect(resolved.scopeRefusal ?? null).toBeNull();
    expect(resolved.source).not.toBe("execution_workspace");
    // agent_home or project-less fallback — never an isolated worktree.
    expect(resolved.executionWorkspaceId ?? null).toBeNull();
    const refusals = await handle.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "workspace_scope_violation"));
    expect(refusals).toHaveLength(0);
  }, 60_000);

  // ── D. With isolation DISABLED globally, even a per_issue_worktree default
  //      must NOT engage the guard nor isolate — the upgrade is gated on the
  //      experimental flag.
  it("never engages the guard when isolated workspaces are globally disabled", async () => {
    const fixture = await createFixture(handle, {
      tmpRoot,
      enableIsolation: false,
      defaultIsolationMode: "per_issue_worktree",
    });
    const issue = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "ADV-4",
      title: "Isolation disabled",
    });
    await fs.writeFile(path.join(fixture.repo, "dirty.ts"), "x\n", "utf8");

    const resolved = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issue.id },
      previousSessionParams: null,
    });
    expect(resolved.source).toBe("project_primary");
    expect(resolved.scopeRefusal ?? null).toBeNull();
    expect(resolved.executionWorkspaceMode).toBe("shared_workspace");
  }, 60_000);

  // ── E. The CONTEXT-BLEED claim, end-to-end: two DIFFERENT issues that both
  //      isolate from the same base must NEVER share a working tree, and a
  //      base dirtied by issue X must not be silently inherited by issue Y.
  it("two different issues never end up operating on the same working tree", async () => {
    const fixture = await createFixture(handle, { tmpRoot });
    const issueX = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "ADV-50",
      title: "Issue X",
    });
    const issueY = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "ADV-51",
      title: "Issue Y",
    });

    const wsX = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issueX.id },
      previousSessionParams: null,
    });
    const wsY = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issueY.id },
      previousSessionParams: null,
    });

    expect(wsX.source).toBe("execution_workspace");
    expect(wsY.source).toBe("execution_workspace");
    // Hard isolation invariant: distinct cwds, distinct from base, distinct
    // execution-workspace ids.
    expect(wsX.cwd).not.toBe(wsY.cwd);
    expect(wsX.cwd).not.toBe(fixture.repo);
    expect(wsY.cwd).not.toBe(fixture.repo);
    expect(wsX.executionWorkspaceId).not.toBe(wsY.executionWorkspaceId);

    // Now X dirties ITS OWN worktree. Y re-resolving must still get Y's own
    // worktree, never X's, and X's dirt must not bleed into Y.
    await fs.writeFile(path.join(wsX.cwd, "x-only-change.ts"), "export const x = 1;\n", "utf8");
    const wsYAgain = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issueY.id },
      previousSessionParams: null,
    });
    expect(wsYAgain.cwd).toBe(wsY.cwd);
    expect(wsYAgain.cwd).not.toBe(wsX.cwd);
    // Y's worktree does not contain X's change.
    const yHasXChange = await fs
      .access(path.join(wsYAgain.cwd, "x-only-change.ts"))
      .then(() => true)
      .catch(() => false);
    expect(yHasXChange).toBe(false);
  }, 60_000);

  // ── F. Monorepo `src/shared/**` style boundary: crossing app→shared is
  //      flagged unless the shared segment is explicitly allow-listed.
  it("flags monorepo cross-package edits and clears them only via scopeExceptions", async () => {
    const fixture = await createFixture(handle, { tmpRoot });
    const issue = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "MONO-1",
      title: "Monorepo edit",
    });

    // packages/app + packages/shared → two boundaries.
    const changedFiles = [
      "packages/app/src/feature.ts",
      "packages/app/src/feature.test.ts",
      "packages/shared/src/util.ts",
    ];

    // Not configured → boundary check inert.
    const ungated = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: issue.id,
      issueIdentifier: "MONO-1",
      changedFiles,
      worktreeCwd: null,
      baseRef: null,
      projectScopeExceptions: undefined,
    });
    expect(ungated.valid).toBe(true);

    // Configured, shared not allow-listed → flagged.
    const gated = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: issue.id,
      issueIdentifier: "MONO-1",
      changedFiles,
      worktreeCwd: null,
      baseRef: null,
      projectScopeExceptions: [],
    });
    expect(gated.valid).toBe(false);
    if (!gated.valid) {
      expect(gated.violations[0]!.kind).toBe("service_boundary_crossing");
      // The primary (most files) is packages/app; the crossing is packages/shared.
      expect(gated.reason).toMatch(/packages\/shared/);
    }

    // Allow-listing packages/shared clears it.
    const allowed = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: issue.id,
      issueIdentifier: "MONO-1",
      changedFiles,
      worktreeCwd: null,
      baseRef: null,
      projectScopeExceptions: ["packages/shared"],
    });
    expect(allowed.valid).toBe(true);
  }, 60_000);

  // ── G. Fresh worktree with NO commit history vs base → body-heuristic
  //      fallback path. Must NOT throw and must NOT fail on body refs alone.
  it("does not throw or fail on a fresh worktree whose body references other tickets", async () => {
    const repo = await createGitRepo(tmpRoot);
    const fixture = await createFixture(handle, { tmpRoot, repo });
    // Issue body itself references a DIFFERENT ticket, but no commits exist on
    // the worktree vs base → body-only signal must not fail validation.
    const issue = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "FRESH-1",
      title: "Implement FRESH-1, relates to OTHER-99",
    });
    await handle.db
      .update(issues)
      .set({ description: "This depends on OTHER-99 but stays in FRESH-1 scope." })
      .where(eq(issues.id, issue.id));

    // baseRef = HEAD means the range HEAD..HEAD is empty (fresh worktree).
    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: issue.id,
      issueIdentifier: "FRESH-1",
      changedFiles: ["a.ts"],
      worktreeCwd: repo,
      baseRef: "HEAD",
      projectScopeExceptions: undefined,
    });
    // No commit history vs base; body refs alone must NOT fail.
    expect(result.valid).toBe(true);
  }, 60_000);

  // ── H. The scope directive must survive NULL identifier AND null title
  //      without throwing or emitting "null" garbage.
  it("produces a sane directive when identifier and title are null", async () => {
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Null Directive Co" })
      .returning();
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId: company.id, name: "eng", adapterType: "process" })
      .returning();
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId: company.id, name: "p" })
      .returning();
    // Issue with NO identifier.
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId: company.id,
        projectId: project.id,
        assigneeAgentId: agent.id,
        identifier: null,
        title: "Untitled work",
        status: "todo",
        complexity: "small",
      })
      .returning();

    const result = await loadAssignedIssueQueue(handle.db, {
      companyId: company.id,
      agentId: agent.id,
      currentIssueId: issue.id,
      issueIdentifier: null,
      issueTitle: null,
      focusMode: false,
    });
    expect(result.directive).toBeTruthy();
    const directive = result.directive ?? "";
    expect(directive).toMatch(/Respond only to the scope of/i);
    // No literal "null" leaked into the rendered fence.
    expect(directive.toLowerCase()).not.toContain("null");
    expect(directive).toMatch(/the current issue/i);
  }, 60_000);

  // ── I. currentIssueMissing: a current issue id is set but its queue row never
  //      resolves (e.g. closed/foreign). The directive must STILL be produced
  //      using the supplied identifier/title so the fence is not lost.
  it("still produces the directive when the current issue row is missing from the queue", async () => {
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Missing Row Co" })
      .returning();
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId: company.id, name: "eng", adapterType: "process" })
      .returning();

    const result = await loadAssignedIssueQueue(handle.db, {
      companyId: company.id,
      agentId: agent.id,
      // A current id that has NO matching open assigned issue row.
      currentIssueId: "00000000-0000-0000-0000-000000000000",
      issueIdentifier: "GHOST-7",
      issueTitle: "Ghost issue",
      focusMode: false,
    });
    expect(result.currentIssueMissing).toBe(true);
    expect(result.directive).toBeTruthy();
    expect(result.directive ?? "").toMatch(/GHOST-7/);
  }, 60_000);

  // ── K. FALSE-POSITIVE GUARD: non-issue tokens that look like identifiers
  //      (UTF-8, SHA-1, ISO-8601, HTTP-2, etc.) in a commit message MUST NOT be
  //      treated as foreign issue references and block auto-close.
  it("does not treat UTF-8 / SHA-1 / ISO-8601 commit tokens as foreign issue references", async () => {
    const repo = await createGitRepo(tmpRoot);
    await git(repo, ["checkout", "-b", "pap-12-feature"]);
    await fs.writeFile(path.join(repo, "codec.ts"), "export const x = 1;\n", "utf8");
    await git(repo, ["add", "codec.ts"]);
    await git(repo, [
      "commit",
      "-m",
      "PAP-12: fix UTF-8 decoding, switch SHA-1 to SHA-256, parse ISO-8601 over HTTP-2",
    ]);

    const [company] = await handle.db
      .insert(companies)
      .values({ name: "FP Co" })
      .returning();
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId: company.id, name: "eng", adapterType: "process" })
      .returning();
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId: company.id, name: "p" })
      .returning();
    const issue = await createIssue(handle, {
      companyId: company.id,
      projectId: project.id,
      agentId: agent.id,
      identifier: "PAP-12",
      title: "Codec work",
    });

    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: issue.id,
      issueIdentifier: "PAP-12",
      changedFiles: ["codec.ts"],
      worktreeCwd: repo,
      baseRef: "main",
      // Opted-in so a (wrong) violation would actually gate the close.
      projectScopeExceptions: [],
    });
    expect(result.valid).toBe(true);

    // Sanity: a REAL foreign ticket is still caught.
    await fs.writeFile(path.join(repo, "extra.ts"), "export const y = 2;\n", "utf8");
    await git(repo, ["add", "extra.ts"]);
    await git(repo, ["commit", "-m", "PAP-99: actually a different ticket"]);
    const real = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: issue.id,
      issueIdentifier: "PAP-12",
      changedFiles: ["codec.ts", "extra.ts"],
      worktreeCwd: repo,
      baseRef: "main",
      projectScopeExceptions: [],
    });
    expect(real.valid).toBe(false);
    if (!real.valid) {
      expect(real.reason).toMatch(/PAP-99/);
      expect(real.reason).not.toMatch(/UTF|SHA|ISO|HTTP/);
    }
  }, 60_000);

  // ── J. Same-issue identifier-encoded dirty paths are tolerated by the guard
  //      directly (unit-level), independent of any prior session metadata.
  it("guard tolerates a dirty base when every dirty path encodes THIS issue's identifier", async () => {
    const repo = await createGitRepo(tmpRoot);
    await fs.mkdir(path.join(repo, "PAP-77"), { recursive: true });
    await fs.writeFile(path.join(repo, "PAP-77", "work.ts"), "x\n", "utf8");
    const result = await verifyCleanBaseCheckoutForIssue(handle.db, {
      baseCwd: repo,
      issueId: "11111111-1111-1111-1111-111111111111",
      issueIdentifier: "PAP-77",
    });
    expect(result.clean).toBe(true);

    // And a base dirtied by an UNRELATED path with no prior session is unclean.
    const repo2 = await createGitRepo(tmpRoot);
    await fs.writeFile(path.join(repo2, "totally-unrelated.ts"), "x\n", "utf8");
    const unclean = await verifyCleanBaseCheckoutForIssue(handle.db, {
      baseCwd: repo2,
      issueId: "22222222-2222-2222-2222-222222222222",
      issueIdentifier: "PAP-88",
    });
    expect(unclean.clean).toBe(false);
  }, 60_000);
});
