import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { renderReport, workspaceDiffSummary } from "../../../scripts/em-autonomy-wide-claude-audit.mjs";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createCommittedWorktree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-audit-report-"));
  tempRoots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "AUD-1-output");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Combyne Test"]);
  await fs.writeFile(path.join(repo, "src", "example.txt"), "before\n", "utf8");
  await git(repo, ["add", "src/example.txt"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  const head = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();

  await fs.mkdir(path.dirname(worktree), { recursive: true });
  await git(repo, ["worktree", "add", "-b", "AUD-1-output", worktree, head]);
  await fs.writeFile(path.join(worktree, "src", "example.txt"), "after\n", "utf8");
  await git(worktree, ["add", "src/example.txt"]);
  await git(worktree, ["commit", "-m", "Audit issue output"]);
  return { repo, worktree, head };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("wide EM autonomy audit report output quality", () => {
  it("reports committed work from an issue worktree, not only the base repo", async () => {
    const { repo, worktree, head } = await createCommittedWorktree();
    const diff = workspaceDiffSummary(
      { cwd: worktree, branchName: "AUD-1-output", baseRef: head },
      { target: repo, head },
    );

    expect(diff.committedFiles).toContain("src/example.txt");
    expect(diff.committedDiffStat).toMatch(/src\/example\.txt/);

    const ctx = {
      company: { id: "company-1", name: "Audit Report Co" },
      bnplProject: { id: "project-1" },
      brickProject: { id: "project-2" },
      bnplCopy: { target: repo, head },
      brickCopy: { target: repo, head },
    };
    const finalSummaries = [
      {
        key: "S1",
        size: "S",
        issueId: "issue-1",
        identifier: "AUD-1",
        title: "Preserve issue worktree output",
        finalStatus: "done",
        issueCount: 1,
        humanQuestions: [],
        openHumanQuestions: [],
        internalQuestions: [],
        internalAnswers: [],
        runs: [],
        outputQuality: [
          {
            issueId: "issue-1",
            identifier: "AUD-1",
            title: "Preserve issue worktree output",
            status: "done",
            executionWorkspaceId: "workspace-1",
            workspacePath: worktree,
            branchName: "AUD-1-output",
            baseRef: head,
            diffStat: `Committed:\n${diff.committedDiffStat}`,
            changedFiles: diff.committedFiles,
            claimedFiles: ["src/example.txt"],
            outputQualityStatus: "diff_present",
            worktreeStatus: diff.status,
          },
        ],
      },
    ];

    const report = renderReport(
      ctx,
      [{ key: "S1", issue: { id: "issue-1", identifier: "AUD-1" } }],
      [],
      [],
      finalSummaries,
      [],
      [],
    );

    expect(report).toContain("## Issue Worktree Outputs");
    expect(report).toContain(worktree);
    expect(report).toContain("src/example.txt");
    expect(report).toContain("diff_present");
  }, 60_000);
});
