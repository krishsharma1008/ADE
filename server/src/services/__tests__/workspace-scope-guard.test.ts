import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, executionWorkspaces, issues, projects } from "@combyne/db";
import { verifyCleanBaseCheckoutForIssue } from "../workspace-scope-guard.js";
import { filterDirtyFilesRelatedToIssue } from "../git-state.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "scope-guard-"));
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "README.md"), "# base\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "initial commit");
  return dir;
}

describe("workspace scope guard", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let projectId: string;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Scope Guard Co", issuePrefix: "SCG" })
      .returning();
    companyId = company.id;
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId, name: "Scope Project" })
      .returning();
    projectId = project.id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    if (handle) await stopTestDb();
  });

  async function makeIssue(identifier: string): Promise<string> {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: `Work for ${identifier}`, identifier, projectId })
      .returning();
    return issue.id;
  }

  it("treats a pristine checkout as clean", async () => {
    const repo = await initRepo();
    tempDirs.push(repo);
    const issueId = await makeIssue("SCG-1");
    const result = await verifyCleanBaseCheckoutForIssue(handle.db, {
      baseCwd: repo,
      issueId,
      issueIdentifier: "SCG-1",
    });
    expect(result.clean).toBe(true);
  });

  it("blocks a base dirty with another issue's unrelated work and no prior session", async () => {
    const repo = await initRepo();
    tempDirs.push(repo);
    const issueId = await makeIssue("SCG-2");
    // Dirty file whose path does not encode SCG-2.
    await writeFile(path.join(repo, "payments-service.ts"), "export const x = 1;\n");

    const result = await verifyCleanBaseCheckoutForIssue(handle.db, {
      baseCwd: repo,
      issueId,
      issueIdentifier: "SCG-2",
    });
    expect(result.clean).toBe(false);
    if (!result.clean) {
      expect(result.reason).toContain("uncommitted");
      expect(result.suggestion).toContain("stash");
    }
  });

  it("treats dirty files whose paths encode this issue identifier as clean", async () => {
    const repo = await initRepo();
    tempDirs.push(repo);
    const issueId = await makeIssue("SCG-3");
    await writeFile(path.join(repo, "scg-3-feature.ts"), "export const y = 2;\n");

    const result = await verifyCleanBaseCheckoutForIssue(handle.db, {
      baseCwd: repo,
      issueId,
      issueIdentifier: "SCG-3",
    });
    expect(result.clean).toBe(true);
  });

  it("tolerates unrelated dirt when this issue has a recorded prior session", async () => {
    const repo = await initRepo();
    tempDirs.push(repo);
    const issueId = await makeIssue("SCG-4");
    // Record a prior execution workspace for THIS issue with session metadata.
    await handle.db.insert(executionWorkspaces).values({
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "SCG-4 prior",
      status: "idle",
      metadata: { sessionCount: 2, lastSessionEndedAt: new Date().toISOString() },
    });
    // Dirty file unrelated to SCG-4 by path.
    await writeFile(path.join(repo, "unrelated-helper.ts"), "export const z = 3;\n");

    const result = await verifyCleanBaseCheckoutForIssue(handle.db, {
      baseCwd: repo,
      issueId,
      issueIdentifier: "SCG-4",
    });
    expect(result.clean).toBe(true);
  });

  it("degrades to clean when the base path is not a git repository", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scope-guard-nonrepo-"));
    tempDirs.push(dir);
    const issueId = await makeIssue("SCG-5");
    const result = await verifyCleanBaseCheckoutForIssue(handle.db, {
      baseCwd: dir,
      issueId,
      issueIdentifier: "SCG-5",
    });
    expect(result.clean).toBe(true);
  });

  it("filterDirtyFilesRelatedToIssue partitions related vs unrelated paths", async () => {
    const repo = await initRepo();
    tempDirs.push(repo);
    await writeFile(path.join(repo, "scg-6-change.ts"), "a\n");
    await writeFile(path.join(repo, "other-change.ts"), "b\n");

    const dirty = await filterDirtyFilesRelatedToIssue("SCG-6", repo);
    expect(dirty.hasDirty).toBe(true);
    expect(dirty.related.map((f) => f.path)).toContain("scg-6-change.ts");
    expect(dirty.unrelated.map((f) => f.path)).toContain("other-change.ts");
  });

  it("filterDirtyFilesRelatedToIssue returns no dirt for a clean repo", async () => {
    const repo = await initRepo();
    tempDirs.push(repo);
    const dirty = await filterDirtyFilesRelatedToIssue("SCG-7", repo);
    expect(dirty.hasDirty).toBe(false);
    expect(dirty.all).toHaveLength(0);
  });
});
