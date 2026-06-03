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
  await fs.writeFile(path.join(repo, "README.md"), "scope creep fixture\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return repo;
}

/**
 * Create a project with isolated workspaces enabled and the per-issue
 * worktree default-isolation mode flipped on, so that an issue resolved
 * against a `shared_workspace` policy default still upgrades to its own
 * worktree (the "code ticket" scope-creep path under test).
 */
async function createScopeCreepFixture(
  handle: TestDbHandle,
  input: {
    tmpRoot: string;
    defaultIsolationMode: "per_issue_worktree" | "shared_workspace";
    /** Project execution-workspace policy defaultMode. */
    policyDefaultMode?: "shared_workspace" | "isolated_workspace";
    scopeExceptions?: string[];
  },
) {
  const repo = await createGitRepo(input.tmpRoot);
  await instanceSettingsService(handle.db).updateExperimental({
    enableIsolatedWorkspaces: true,
    defaultIsolationMode: input.defaultIsolationMode,
  });
  const [company] = await handle.db
    .insert(companies)
    .values({ name: "Scope Creep Co" })
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
  if (input.scopeExceptions) policy.scopeExceptions = input.scopeExceptions;
  const [project] = await handle.db
    .insert(projects)
    .values({
      companyId: company.id,
      name: "Scope creep repo",
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

describe("heartbeat scope-creep scenarios", () => {
  let handle: TestDbHandle;
  let tmpRoot: string;

  beforeEach(async () => {
    handle = await startTestDb();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-scope-creep-"));
  }, 60_000);

  afterEach(async () => {
    if (handle) await stopTestDb();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // ── Scenario 1 ────────────────────────────────────────────────────────────
  // Two sequential code tickets (A then B) on ONE project resolve into DISTINCT
  // worktree cwds (no shared project_primary path) when the instance default
  // isolation mode is per_issue_worktree — even though the project policy
  // default is shared_workspace (the default-isolation upgrade kicks in).
  it("resolves two sequential code tickets into distinct worktrees under per_issue_worktree default", async () => {
    const fixture = await createScopeCreepFixture(handle, {
      tmpRoot,
      defaultIsolationMode: "per_issue_worktree",
      policyDefaultMode: "shared_workspace",
    });
    const issueA = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "SCP-1",
      title: "Code ticket A",
    });
    const issueB = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "SCP-2",
      title: "Code ticket B",
    });

    const workspaceA = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issueA.id },
      previousSessionParams: null,
    });
    const workspaceB = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issueB.id },
      previousSessionParams: null,
    });

    // Both upgraded to isolated worktrees despite the shared_workspace policy
    // default — that is the per_issue_worktree default-isolation behavior.
    expect(workspaceA.source).toBe("execution_workspace");
    expect(workspaceB.source).toBe("execution_workspace");
    expect(workspaceA.executionWorkspaceMode).toBe("isolated_workspace");
    expect(workspaceB.executionWorkspaceMode).toBe("isolated_workspace");

    // DISTINCT cwds — neither shares the project-primary checkout.
    expect(workspaceA.cwd).not.toBe(workspaceB.cwd);
    expect(workspaceA.cwd).not.toBe(fixture.repo);
    expect(workspaceB.cwd).not.toBe(fixture.repo);
    expect(workspaceA.cwd).toContain(path.join(".combyne-ai", "worktrees"));
    expect(workspaceB.cwd).toContain(path.join(".combyne-ai", "worktrees"));

    // Base checkout stays pristine; isolation never touched it.
    const { stdout: primaryStatus } = await execFileAsync("git", [
      "-C",
      fixture.repo,
      "status",
      "--short",
    ]);
    expect(primaryStatus.trim()).toBe("");

    const rows = await handle.db.select().from(executionWorkspaces);
    expect(rows).toHaveLength(2);
  }, 60_000);

  // ── Scenario 2 ────────────────────────────────────────────────────────────
  // Ticket A leaves the BASE checkout dirty with files unrelated to B. When B
  // (which has never run) tries to fork its isolated workspace, the clean-tree
  // guard refuses with a workspace_scope_violation signal. By contrast a
  // same-issue re-run (A, which HAS a recorded prior session) is tolerated.
  it("refuses to fork B's worktree from a base dirtied by unrelated work, but allows A's re-run", async () => {
    const fixture = await createScopeCreepFixture(handle, {
      tmpRoot,
      defaultIsolationMode: "per_issue_worktree",
      policyDefaultMode: "shared_workspace",
    });
    const issueA = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "SCP-10",
      title: "Ticket A leaves leftovers",
    });
    const issueB = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "SCP-11",
      title: "Ticket B clean run",
    });

    // Simulate ticket A having left uncommitted work in the BASE checkout whose
    // paths do NOT encode B's identifier (SCP-11) — contamination from A.
    await fs.writeFile(
      path.join(fixture.repo, "leftover-from-a.ts"),
      "export const leftoverFromTicketA = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(fixture.repo, "src-payments-change.ts"),
      "// unrelated payments edit left behind\n",
      "utf8",
    );

    // B has never run → first-time isolation of a previously-shared checkout.
    // Spec: first-time isolation soft-warns (proceeds) rather than hard-refusing
    // so we don't strand a brand-new issue. Either way it must emit a
    // workspace_scope_violation signal.
    const workspaceB = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issueB.id },
      previousSessionParams: null,
    });

    const violationRows = await handle.db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "workspace_scope_violation"),
          eq(activityLog.entityId, issueB.id),
        ),
      );
    expect(violationRows.length).toBeGreaterThanOrEqual(1);
    const severity = (violationRows[0]!.details ?? {}).severity;
    expect(["soft_warn", "refused"]).toContain(severity);

    // If the guard refused, it must have fallen back to project-primary (no
    // isolated fork) and carried a scopeRefusal. If it soft-warned, it forked
    // anyway and threaded the warning. Both are spec-valid; assert the contract
    // matches whichever branch fired.
    if (severity === "refused") {
      expect(workspaceB.source).toBe("project_primary");
      expect(workspaceB.scopeRefusal).toBeTruthy();
      expect(workspaceB.scopeRefusal?.issueId).toBe(issueB.id);
    } else {
      expect(workspaceB.source).toBe("execution_workspace");
      expect(workspaceB.warnings.join("\n")).toMatch(/uncommitted changes/i);
    }

    // ── Same-issue dirty (A re-run) is allowed via execution_workspace metadata.
    // Give A a recorded prior session so its leftover dirty base is explained.
    const now = new Date();
    await handle.db.insert(executionWorkspaces).values({
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      projectWorkspaceId: fixture.workspace.id,
      sourceIssueId: issueA.id,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "A prior workspace",
      status: "released",
      cwd: path.join(fixture.repo, ".combyne-ai", "worktrees", "scp-10-prior"),
      repoUrl: null,
      baseRef: "HEAD",
      branchName: "scp-10-prior",
      providerType: "git_worktree",
      providerRef: "scp-10-prior",
      lastUsedAt: now,
      openedAt: now,
      createdAt: now,
      updatedAt: now,
      metadata: { sessionCount: 2, lastSessionEndedAt: now.toISOString() },
    });
    // Clear A's executionWorkspaceId so resolution treats this as a fresh fork
    // attempt that must consult prior-session metadata (not the reuse path).
    await handle.db
      .update(issues)
      .set({ executionWorkspaceId: null, executionWorkspacePreference: null })
      .where(eq(issues.id, issueA.id));

    // Base is still dirty with leftover-from-a + payments edits. Resolving A
    // should NOT hard-refuse: A's recorded prior session explains the leftovers.
    const beforeAViolations = await handle.db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "workspace_scope_violation"),
          eq(activityLog.entityId, issueA.id),
        ),
      );

    const workspaceA = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issueA.id },
      previousSessionParams: null,
    });

    // No refusal for A.
    expect(workspaceA.scopeRefusal ?? null).toBeNull();
    // And no new "refused"-severity violation was logged for A.
    const afterAViolations = await handle.db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "workspace_scope_violation"),
          eq(activityLog.entityId, issueA.id),
        ),
      );
    const newARefusals = afterAViolations
      .slice(beforeAViolations.length)
      .filter((row) => (row.details ?? {}).severity === "refused");
    expect(newARefusals).toHaveLength(0);
  }, 60_000);

  // ── Scenario 3 ────────────────────────────────────────────────────────────
  // The scope-diff validator blocks auto-close when the branch's commit
  // messages reference a DIFFERENT issue identifier. The §5c caller only
  // ACTUALLY skips the auto-close when the project opts in via scopeExceptions;
  // otherwise it is telemetry-only and proceeds.
  it("flags cross-issue commit references; gating depends on scopeExceptions opt-in", async () => {
    const repo = await createGitRepo(tmpRoot);
    // Branch off and create a commit that references a FOREIGN ticket.
    await git(repo, ["checkout", "-b", "scp-20-feature"]);
    await fs.writeFile(path.join(repo, "feature.ts"), "export const x = 1;\n", "utf8");
    await git(repo, ["add", "feature.ts"]);
    await git(repo, ["commit", "-m", "SCP-99: implement unrelated feature for another ticket"]);

    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Scope Diff Co" })
      .returning();
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId: company.id, name: "engineer", adapterType: "process" })
      .returning();
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId: company.id, name: "Scope diff repo" })
      .returning();
    const issue = await createIssue(handle, {
      companyId: company.id,
      projectId: project.id,
      agentId: agent.id,
      identifier: "SCP-20",
      title: "This issue",
    });

    // Validator detects the foreign reference regardless of gating.
    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: issue.id,
      issueIdentifier: "SCP-20",
      changedFiles: ["feature.ts"],
      worktreeCwd: repo,
      baseRef: "main",
      // telemetry-only caller passes undefined → boundary check skipped, but the
      // cross-issue commit reference still fires.
      projectScopeExceptions: undefined,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.violations.some((v) => v.kind === "cross_issue_commit_reference")).toBe(true);
      expect(result.reason).toMatch(/SCP-99/);
    }

    // Same validation succeeds when the foreign ref IS this issue (control):
    const cleanRepo = await createGitRepo(tmpRoot);
    await git(cleanRepo, ["checkout", "-b", "scp-21-clean"]);
    await fs.writeFile(path.join(cleanRepo, "ok.ts"), "export const ok = 1;\n", "utf8");
    await git(cleanRepo, ["add", "ok.ts"]);
    await git(cleanRepo, ["commit", "-m", "SCP-21: stay in scope"]);
    const cleanIssue = await createIssue(handle, {
      companyId: company.id,
      projectId: project.id,
      agentId: agent.id,
      identifier: "SCP-21",
      title: "In-scope issue",
    });
    const cleanResult = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: cleanIssue.id,
      issueIdentifier: "SCP-21",
      changedFiles: ["ok.ts"],
      worktreeCwd: cleanRepo,
      baseRef: "main",
      projectScopeExceptions: undefined,
    });
    expect(cleanResult.valid).toBe(true);

    // ── Gating semantics that §5c relies on: scopeExceptions opt-in.
    // When the project provides a scopeExceptions array, the caller treats a
    // violation as gating (skips auto-close). Service-boundary crossing is only
    // enforced once that array is present. Prove the boundary check is inert
    // without it and active with it.
    const boundaryOnlyUngated = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: cleanIssue.id,
      issueIdentifier: "SCP-21",
      changedFiles: ["services/payments/a.ts", "services/lending/b.ts"],
      worktreeCwd: null,
      baseRef: null,
      projectScopeExceptions: undefined, // not configured → boundary check skipped
    });
    expect(boundaryOnlyUngated.valid).toBe(true);

    const boundaryGated = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: cleanIssue.id,
      issueIdentifier: "SCP-21",
      changedFiles: ["services/payments/a.ts", "services/lending/b.ts"],
      worktreeCwd: null,
      baseRef: null,
      projectScopeExceptions: [], // configured (opted-in), allow-list empty
    });
    expect(boundaryGated.valid).toBe(false);
    if (!boundaryGated.valid) {
      expect(boundaryGated.violations.some((v) => v.kind === "service_boundary_crossing")).toBe(
        true,
      );
    }

    // And an allow-list that names the crossing boundary clears it.
    const boundaryAllowed = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId: cleanIssue.id,
      issueIdentifier: "SCP-21",
      changedFiles: ["services/payments/a.ts", "services/lending/b.ts"],
      worktreeCwd: null,
      baseRef: null,
      projectScopeExceptions: ["services/lending"],
    });
    expect(boundaryAllowed.valid).toBe(true);
  }, 60_000);

  // ── Scenario 4 ────────────────────────────────────────────────────────────
  // The scope fence (FOCUS_DIRECTIVE) must reach the run context even when
  // focusMode is OFF. focusMode controls the loud rendered "Current focus"
  // block + digest labelling; the SCOPE SAFETY directive is a guardrail and
  // should be produced whenever there is a current issue regardless of focus.
  it("produces the scope directive even when focusMode is OFF", async () => {
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Focus Off Co" })
      .returning();
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId: company.id, name: "engineer", adapterType: "process" })
      .returning();
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId: company.id, name: "Focus off repo" })
      .returning();
    const issue = await createIssue(handle, {
      companyId: company.id,
      projectId: project.id,
      agentId: agent.id,
      identifier: "SCP-30",
      title: "Stay in your lane",
    });

    const result = await loadAssignedIssueQueue(handle.db, {
      companyId: company.id,
      agentId: agent.id,
      currentIssueId: issue.id,
      issueIdentifier: "SCP-30",
      issueTitle: "Stay in your lane",
      focusMode: false,
    });

    // The loud focus block is suppressed when focusMode is off...
    expect(result.focusBody).toBe("");
    // ...but the scope fence directive is STILL produced (the guardrail).
    expect(result.directive).toBeTruthy();
    expect(result.directive ?? "").toMatch(/Respond only to the scope of/i);
    expect(result.directive ?? "").toMatch(/SCP-30/);
    expect(result.directive ?? "").toMatch(/STOP and create separate issues/i);

    // The heartbeat §5a injection condition (`queue.directive && memoryIssueId`)
    // therefore fires with focusMode off → the fence reaches the adapter.
    const wouldInject = Boolean(result.directive && issue.id);
    expect(wouldInject).toBe(true);
  }, 60_000);
});
