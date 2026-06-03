import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, executionWorkspaces, issues, projects, projectWorkspaces } from "@combyne/db";
import { resolveWorkspaceForHeartbeatRun } from "../heartbeat.js";
import { instanceSettingsService } from "../instance-settings.js";
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
  await fs.writeFile(path.join(repo, "README.md"), "workspace isolation fixture\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return repo;
}

async function createWorkspaceFixture(
  handle: TestDbHandle,
  input: { tmpRoot: string; isolatedEnabled: boolean; policyEnabled: boolean },
) {
  const repo = await createGitRepo(input.tmpRoot);
  await instanceSettingsService(handle.db).updateExperimental({
    enableIsolatedWorkspaces: input.isolatedEnabled,
  });
  const [company] = await handle.db
    .insert(companies)
    .values({ name: "Workspace Isolation Co" })
    .returning();
  const [agent] = await handle.db
    .insert(agents)
    .values({ companyId: company.id, name: "engineer", adapterType: "process" })
    .returning();
  const [project] = await handle.db
    .insert(projects)
    .values({
      companyId: company.id,
      name: "Isolated repo",
      executionWorkspacePolicy: {
        enabled: input.policyEnabled,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
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

describe("heartbeat workspace isolation", () => {
  let handle: TestDbHandle;
  let tmpRoot: string;

  beforeEach(async () => {
    handle = await startTestDb();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-workspace-isolation-"));
  }, 60_000);

  afterEach(async () => {
    if (handle) await stopTestDb();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("resolves two same-project issues into different git worktree paths", async () => {
    const fixture = await createWorkspaceFixture(handle, {
      tmpRoot,
      isolatedEnabled: true,
      policyEnabled: true,
    });
    const issueA = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "WIT-101",
      title: "Change first repo path",
    });
    const issueB = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "WIT-102",
      title: "Change second repo path",
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

    expect(workspaceA.source).toBe("execution_workspace");
    expect(workspaceB.source).toBe("execution_workspace");
    expect(workspaceA.cwd).not.toBe(workspaceB.cwd);
    expect(workspaceA.cwd).toContain(path.join(".combyne-ai", "worktrees"));
    expect(workspaceB.cwd).toContain(path.join(".combyne-ai", "worktrees"));
    expect(workspaceA.workspaceHints).toEqual([
      expect.objectContaining({ workspaceId: fixture.workspace.id, cwd: null }),
    ]);
    expect(workspaceB.workspaceHints).toEqual([
      expect.objectContaining({ workspaceId: fixture.workspace.id, cwd: null }),
    ]);
    await expect(fs.stat(workspaceA.cwd).then((stats) => stats.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(workspaceB.cwd).then((stats) => stats.isDirectory())).resolves.toBe(true);
    const { stdout: primaryStatus } = await execFileAsync("git", ["-C", fixture.repo, "status", "--short"]);
    expect(primaryStatus.trim()).toBe("");

    const rows = await handle.db.select().from(executionWorkspaces);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.cwd))).toEqual(new Set([workspaceA.cwd, workspaceB.cwd]));
    const [persistedIssueA] = await handle.db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueA.id));
    const [persistedIssueB] = await handle.db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueB.id));
    expect(persistedIssueA.executionWorkspaceId).toBe(workspaceA.executionWorkspaceId);
    expect(persistedIssueB.executionWorkspaceId).toBe(workspaceB.executionWorkspaceId);
  }, 60_000);

  it("reuses the same issue worktree on follow-up wakes", async () => {
    const fixture = await createWorkspaceFixture(handle, {
      tmpRoot,
      isolatedEnabled: true,
      policyEnabled: true,
    });
    const issue = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "WIT-201",
      title: "Reuse worktree",
    });

    const first = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issue.id },
      previousSessionParams: null,
    });
    const second = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issue.id, wakeCommentId: "follow-up" },
      previousSessionParams: { cwd: first.cwd, sessionId: "session-1" },
    });

    expect(second.source).toBe("execution_workspace");
    expect(second.cwd).toBe(first.cwd);
    expect(second.executionWorkspaceId).toBe(first.executionWorkspaceId);
    const rows = await handle.db.select().from(executionWorkspaces);
    expect(rows).toHaveLength(1);
  }, 60_000);

  it("keeps project-primary behavior when isolation is disabled", async () => {
    const fixture = await createWorkspaceFixture(handle, {
      tmpRoot,
      isolatedEnabled: false,
      policyEnabled: true,
    });
    const issue = await createIssue(handle, {
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      agentId: fixture.agent.id,
      identifier: "WIT-301",
      title: "Shared workspace fallback",
    });

    const resolved = await resolveWorkspaceForHeartbeatRun(handle.db, {
      agent: fixture.agent,
      context: { issueId: issue.id },
      previousSessionParams: null,
    });

    expect(resolved.source).toBe("project_primary");
    expect(resolved.cwd).toBe(fixture.repo);
    expect(resolved.executionWorkspaceId).toBeNull();
    expect(resolved.workspaceHints).toEqual([
      expect.objectContaining({ workspaceId: fixture.workspace.id, cwd: fixture.repo }),
    ]);
    const rows = await handle.db.select().from(executionWorkspaces);
    expect(rows).toHaveLength(0);
  }, 60_000);
});
