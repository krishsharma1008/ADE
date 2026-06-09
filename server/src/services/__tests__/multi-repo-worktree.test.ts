import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupExecutionWorkspaceArtifacts,
  enumerateChildGitRepos,
  realizeExecutionWorkspace,
} from "../workspace-runtime.js";

// Minimal real-git fixtures so the worktree commands actually run. Each child
// repo gets one commit so `git worktree add` has a base to fork from.
function git(args: string[], cwd: string) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

async function initChildRepo(parent: string, name: string) {
  const repo = path.join(parent, name);
  await fs.mkdir(repo, { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@combyne.dev"], repo);
  git(["config", "user.name", "Combyne Test"], repo);
  await fs.writeFile(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
  git(["add", "."], repo);
  git(["commit", "-m", "initial"], repo);
  return repo;
}

const agent = { id: "agent-1", name: "Tester", companyId: "company-1" };
const issue = { id: "issue-1", identifier: "PAP-42", title: "multi repo isolation" };

describe("multi-repo per-repo-worktree isolation", () => {
  let parentDir: string;

  beforeEach(async () => {
    parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-multirepo-"));
    // Two real child repos + one plain (non-repo) dir + one dot-dir. Only the
    // two real repos should be enumerated.
    await initChildRepo(parentDir, "fs-bnpl-service");
    await initChildRepo(parentDir, "fs-brick-service");
    await fs.mkdir(path.join(parentDir, "docs-not-a-repo"), { recursive: true });
    await fs.mkdir(path.join(parentDir, ".combyne-ai"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(parentDir, { recursive: true, force: true }).catch(() => {});
  });

  it("enumerates only the immediate child git repos (skips non-repos and dot-dirs)", async () => {
    const repos = await enumerateChildGitRepos(parentDir);
    expect(repos.map((r) => r.name).sort()).toEqual(["fs-bnpl-service", "fs-brick-service"]);
    // Each enumerated entry points at the child's own toplevel.
    for (const repo of repos) {
      expect(repo.root).toBe(path.resolve(path.join(parentDir, repo.name)));
    }
  });

  it("realizes one worktree per child repo under a single isolated task dir", async () => {
    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: parentDir,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: null,
      },
      // isolated_workspace mode resolves to a git_worktree strategy; the
      // realization auto-detects the multi-repo parent at runtime.
      config: { workspaceStrategy: { type: "git_worktree" } },
      issue,
      agent,
      recorder: null,
    });

    expect(realized.strategy).toBe("multi_repo_worktree");
    // The run cwd is the task dir, NOT any single child repo.
    expect(realized.cwd).toBe(realized.worktreePath);
    expect(realized.childWorktrees).toBeDefined();
    expect(realized.childWorktrees!.map((c) => c.repoName).sort()).toEqual([
      "fs-bnpl-service",
      "fs-brick-service",
    ]);

    // Each child worktree lives at <taskDir>/<repo-name> and is a real linked
    // worktree on the per-issue branch.
    for (const child of realized.childWorktrees!) {
      expect(child.worktreePath).toBe(path.join(realized.cwd, child.repoName));
      const stat = await fs.stat(child.worktreePath);
      expect(stat.isDirectory()).toBe(true);
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], child.worktreePath);
      expect(branch).toBe(realized.branchName);
    }
  });

  it("cleanup removes every child worktree and the task dir", async () => {
    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: parentDir,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: null,
      },
      config: { workspaceStrategy: { type: "git_worktree" } },
      issue,
      agent,
      recorder: null,
    });
    expect(realized.strategy).toBe("multi_repo_worktree");

    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "exec-ws-1",
        cwd: realized.cwd,
        providerType: "multi_repo_worktree",
        providerRef: realized.worktreePath,
        branchName: realized.branchName,
        repoUrl: null,
        baseRef: null,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        sourceIssueId: issue.id,
        metadata: { createdByRuntime: true, childWorktrees: realized.childWorktrees },
      },
      projectWorkspace: { cwd: parentDir, cleanupCommand: null },
      recorder: null,
    });

    expect(result.cleaned).toBe(true);
    // Every child worktree path is gone.
    for (const child of realized.childWorktrees!) {
      await expect(fs.stat(child.worktreePath)).rejects.toThrow();
    }
    // The child repos themselves survive — only the worktrees were removed.
    for (const name of ["fs-bnpl-service", "fs-brick-service"]) {
      const stat = await fs.stat(path.join(parentDir, name));
      expect(stat.isDirectory()).toBe(true);
      // `git worktree list` in the child repo no longer references the task dir.
      const list = git(["worktree", "list"], path.join(parentDir, name));
      expect(list).not.toContain(realized.cwd);
    }
  });
});
