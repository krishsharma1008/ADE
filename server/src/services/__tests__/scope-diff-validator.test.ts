import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, issues, projects } from "@combyne/db";
import {
  extractIssueIdentifiers,
  validateScopeDiffBeforeAutoClose,
} from "../scope-diff-validator.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function initRepo(): Promise<{ dir: string; baseRef: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "scope-diff-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "README.md"), "# base\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "initial commit");
  // Branch off so base..HEAD has a stable base ref.
  await git(dir, "checkout", "-q", "-b", "feature");
  return { dir, baseRef: "main" };
}

async function commit(dir: string, file: string, message: string): Promise<void> {
  await writeFile(path.join(dir, file), `${file}\n`);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", message);
}

describe("extractIssueIdentifiers", () => {
  it("extracts and de-duplicates Jira/Linear-style identifiers", () => {
    expect(extractIssueIdentifiers("Fixes PAP-12 and references ENG-7, PAP-12")).toEqual([
      "PAP-12",
      "ENG-7",
    ]);
  });

  it("returns an empty list for text with no identifiers", () => {
    expect(extractIssueIdentifiers("no identifiers here")).toEqual([]);
    expect(extractIssueIdentifiers(null)).toEqual([]);
    expect(extractIssueIdentifiers(undefined)).toEqual([]);
  });

  it("does not match lowercase or malformed tokens", () => {
    expect(extractIssueIdentifiers("pap-12 and PAP- and -12")).toEqual([]);
  });
});

describe("validateScopeDiffBeforeAutoClose", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let projectId: string;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Scope Diff Co", issuePrefix: "SDF" })
      .returning();
    companyId = company.id;
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId, name: "Scope Diff Project" })
      .returning();
    projectId = project.id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    if (handle) await stopTestDb();
  });

  async function makeIssue(identifier: string, description = ""): Promise<string> {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: `Work for ${identifier}`, identifier, description, projectId })
      .returning();
    return issue.id;
  }

  it("flags commit messages that reference a different issue identifier", async () => {
    const { dir, baseRef } = await initRepo();
    tempDirs.push(dir);
    await commit(dir, "a.ts", "SDF-1: implement the thing");
    await commit(dir, "b.ts", "Also fixes SDF-99 while here");
    const issueId = await makeIssue("SDF-1");

    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId,
      issueIdentifier: "SDF-1",
      changedFiles: ["a.ts", "b.ts"],
      worktreeCwd: dir,
      baseRef,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const crossRef = result.violations.find((v) => v.kind === "cross_issue_commit_reference");
      expect(crossRef).toBeTruthy();
      expect(crossRef?.evidence).toContain("SDF-99");
    }
  });

  it("passes when commit messages only reference this issue", async () => {
    const { dir, baseRef } = await initRepo();
    tempDirs.push(dir);
    await commit(dir, "a.ts", "SDF-2: implement the thing");
    const issueId = await makeIssue("SDF-2");

    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId,
      issueIdentifier: "SDF-2",
      changedFiles: ["a.ts"],
      worktreeCwd: dir,
      baseRef,
    });
    expect(result.valid).toBe(true);
  });

  it("flags service-boundary crossings beyond the scope-exceptions allow-list", async () => {
    const { dir, baseRef } = await initRepo();
    tempDirs.push(dir);
    await commit(dir, "x.ts", "SDF-3: work");
    const issueId = await makeIssue("SDF-3");

    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId,
      issueIdentifier: "SDF-3",
      changedFiles: [
        "services/orders/handler.ts",
        "services/orders/util.ts",
        "services/payments/charge.ts",
      ],
      worktreeCwd: dir,
      baseRef,
      projectScopeExceptions: [],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const boundary = result.violations.find((v) => v.kind === "service_boundary_crossing");
      expect(boundary).toBeTruthy();
      expect(boundary?.detail).toContain("services/payments");
    }
  });

  it("allows a boundary crossing that is on the scope-exceptions allow-list", async () => {
    const { dir, baseRef } = await initRepo();
    tempDirs.push(dir);
    await commit(dir, "x.ts", "SDF-4: work");
    const issueId = await makeIssue("SDF-4");

    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId,
      issueIdentifier: "SDF-4",
      changedFiles: [
        "services/orders/handler.ts",
        "services/orders/util.ts",
        "services/payments/charge.ts",
      ],
      worktreeCwd: dir,
      baseRef,
      projectScopeExceptions: ["services/payments"],
    });
    expect(result.valid).toBe(true);
  });

  it("does not enforce boundary crossings when no allow-list is provided", async () => {
    const { dir, baseRef } = await initRepo();
    tempDirs.push(dir);
    await commit(dir, "x.ts", "SDF-5: work");
    const issueId = await makeIssue("SDF-5");

    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId,
      issueIdentifier: "SDF-5",
      changedFiles: ["services/orders/handler.ts", "services/payments/charge.ts"],
      worktreeCwd: dir,
      baseRef,
      // projectScopeExceptions omitted -> telemetry-only, no boundary enforcement
    });
    expect(result.valid).toBe(true);
  });

  it("falls back gracefully for a fresh worktree with no history vs base", async () => {
    const { dir, baseRef } = await initRepo();
    tempDirs.push(dir);
    // No commits on the feature branch beyond base -> empty range.
    const issueId = await makeIssue("SDF-6", "References SDF-77 in the body");

    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId,
      issueIdentifier: "SDF-6",
      changedFiles: ["a.ts"],
      worktreeCwd: dir,
      baseRef,
    });
    // Body cross-references alone do not fail validation; no boundary list given.
    expect(result.valid).toBe(true);
  });

  it("never throws when the worktree path is missing", async () => {
    const issueId = await makeIssue("SDF-7");
    const result = await validateScopeDiffBeforeAutoClose(handle.db, {
      issueId,
      issueIdentifier: "SDF-7",
      changedFiles: ["a.ts"],
      worktreeCwd: "/nonexistent/path/that/does/not/exist",
      baseRef: "main",
    });
    expect(result.valid).toBe(true);
  });
});
