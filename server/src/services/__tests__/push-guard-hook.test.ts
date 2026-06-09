import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installPushGuardHook, renderPushGuardHook } from "../workspace-runtime.js";

// Invoke a rendered pre-push hook exactly the way git does: argv = [remoteName,
// remoteUrl], with "<localRef> <localSha> <remoteRef> <remoteSha>" on stdin.
// Exit 0 = push allowed, non-zero = blocked.
function runHook(hookPath: string, remoteName: string, remoteUrl: string) {
  return spawnSync("/bin/sh", [hookPath, remoteName, remoteUrl], {
    input: "refs/heads/main 0000 refs/heads/main 0000\n",
    encoding: "utf8",
  });
}

describe("push guard pre-push hook (POSIX shell)", () => {
  const patterns = [
    "github.com/acme/widget",
    "github.com/acme/widget-test",
    "github.com/acme/*-test",
  ];
  let hookPath: string;

  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-pushguard-"));
    hookPath = path.join(dir, "pre-push");
    await fs.writeFile(hookPath, renderPushGuardHook(patterns), { mode: 0o755 });
  });

  it("allows pushes to the configured repo and *-test forks", () => {
    expect(runHook(hookPath, "origin", "git@github.com:acme/widget.git").status).toBe(0);
    expect(runHook(hookPath, "origin", "https://github.com/acme/widget-test.git").status).toBe(0);
    expect(runHook(hookPath, "origin", "https://github.com/acme/feature-test").status).toBe(0);
  });

  it("blocks pushes to bukuwarung/* production and other unknown remotes", () => {
    const blocked = runHook(hookPath, "origin", "git@github.com:bukuwarung/fs-bnpl-service.git");
    expect(blocked.status).not.toBe(0);
    // The error names the blocked remote so an agent sees why.
    expect(blocked.stderr).toContain("BLOCKED");
    expect(blocked.stderr).toContain("bukuwarung/fs-bnpl-service");

    expect(runHook(hookPath, "origin", "https://github.com/acme/other-prod").status).not.toBe(0);
    expect(runHook(hookPath, "origin", "https://gitlab.com/acme/widget").status).not.toBe(0);
  });

  it("blocks everything when no patterns are configured", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-pushguard-empty-"));
    const emptyHook = path.join(dir, "pre-push");
    await fs.writeFile(emptyHook, renderPushGuardHook([]), { mode: 0o755 });
    expect(runHook(emptyHook, "origin", "https://github.com/acme/widget").status).not.toBe(0);
  });
});

describe("installPushGuardHook (real git repo)", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-pushguard-repo-"));
    spawnSync("git", ["init", "-q"], { cwd: repoDir });
  });

  afterAll(async () => {
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("installs an executable, marker-tagged pre-push hook keyed to the project repo url", async () => {
    const warnings = await installPushGuardHook({
      cwd: repoDir,
      repoUrls: ["https://github.com/acme/widget"],
    });
    expect(warnings).toEqual([]);

    const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");
    const contents = await fs.readFile(hookPath, "utf8");
    expect(contents).toContain("combyne-push-remote-guard");
    expect(contents).toContain("github.com/acme/*-test");
    const stat = await fs.stat(hookPath);
    expect(stat.mode & 0o111).not.toBe(0); // executable

    // The installed hook makes a real allow/block decision.
    expect(runHook(hookPath, "origin", "git@github.com:acme/widget.git").status).toBe(0);
    expect(runHook(hookPath, "origin", "git@github.com:bukuwarung/fs-bnpl-service.git").status).not.toBe(0);
  });

  it("does not clobber a human-authored pre-push hook", async () => {
    const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");
    const human = "#!/bin/sh\necho human-hook\nexit 0\n";
    await fs.writeFile(hookPath, human, { mode: 0o755 });

    const warnings = await installPushGuardHook({
      cwd: repoDir,
      repoUrls: ["https://github.com/acme/widget"],
    });
    expect(warnings.some((w) => w.includes("not authored by Combyne"))).toBe(true);
    expect(await fs.readFile(hookPath, "utf8")).toBe(human);
  });
});
