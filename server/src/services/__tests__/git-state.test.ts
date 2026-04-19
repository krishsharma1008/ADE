import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectGitStateForIssue } from "../git-state.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  return execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Combyne Test",
      GIT_AUTHOR_EMAIL: "test@combyne.dev",
      GIT_COMMITTER_NAME: "Combyne Test",
      GIT_COMMITTER_EMAIL: "test@combyne.dev",
    },
  });
}

describe("git-state: inspectGitStateForIssue", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "combyne-git-state-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(repo, "a.txt"), "hello\n");
    await runGit(repo, ["add", "a.txt"]);
    await runGit(repo, ["commit", "-q", "-m", "initial seed"]);

    // A commit that mentions the issue identifier.
    await writeFile(path.join(repo, "b.txt"), "fix\n");
    await runGit(repo, ["add", "b.txt"]);
    await runGit(repo, ["commit", "-q", "-m", "LND-4994: wire up the thing"]);

    // A commit that mentions a fragment of the title.
    await writeFile(path.join(repo, "c.txt"), "more\n");
    await runGit(repo, ["add", "c.txt"]);
    await runGit(repo, ["commit", "-q", "-m", "Polish the widget dashboard"]);

    // A feature branch whose name contains the identifier.
    await runGit(repo, ["branch", "feature/LND-4994-wire-up"]);
  }, 60_000);

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it("flags an issue as likely resolved when commits mention the identifier", async () => {
    const state = await inspectGitStateForIssue({
      cwd: repo,
      issueIdentifier: "LND-4994",
      issueTitle: "Wire up the thing",
    });
    expect(state).not.toBeNull();
    expect(state!.isGitRepo).toBe(true);
    expect(state!.matchingCommits.length).toBeGreaterThanOrEqual(1);
    expect(state!.matchingCommits[0]!.subject).toMatch(/LND-4994/);
    expect(state!.matchingBranches).toContain("feature/LND-4994-wire-up");
    expect(state!.likelyResolved).toBe(true);
    expect(state!.summary).toMatch(/commit\(s\) mentioning this issue/);
  });

  it("returns a degraded result with recent commits when nothing matches", async () => {
    const state = await inspectGitStateForIssue({
      cwd: repo,
      issueIdentifier: "NOPE-1",
      issueTitle: "No such task anywhere",
    });
    expect(state).not.toBeNull();
    expect(state!.likelyResolved).toBe(false);
    expect(state!.matchingCommits).toHaveLength(0);
    expect(state!.recentCommits.length).toBeGreaterThan(0);
    expect(state!.summary).toMatch(/No direct matches/);
  });

  it("gracefully reports non-git workspaces without throwing", async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), "combyne-no-git-"));
    try {
      const state = await inspectGitStateForIssue({
        cwd: notARepo,
        issueIdentifier: "X-1",
        issueTitle: "anything",
      });
      expect(state).not.toBeNull();
      expect(state!.isGitRepo).toBe(false);
      expect(state!.summary).toMatch(/not a git repository/);
    } finally {
      await rm(notARepo, { recursive: true, force: true }).catch(() => {});
    }
  });
});
