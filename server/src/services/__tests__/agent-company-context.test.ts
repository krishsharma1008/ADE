import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companies, projects, projectWorkspaces } from "@combyne/db";
import { loadCompanyProjectOverview } from "../agent-company-context.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("agent company project context", () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await startTestDb();
  }, 60_000);

  afterEach(async () => {
    if (handle) await stopTestDb();
  });

  it("redacts writable primary checkout paths for isolated execution runs", async () => {
    const cwd = "/tmp/combyne-primary-checkout";
    const [company] = await handle.db.insert(companies).values({ name: "Context Co" }).returning();
    const [project] = await handle.db
      .insert(projects)
      .values({
        companyId: company.id,
        name: "API service",
        description: "Backend service",
        status: "active",
      })
      .returning();
    await handle.db.insert(projectWorkspaces).values({
      companyId: company.id,
      projectId: project.id,
      name: "primary",
      cwd,
      repoUrl: "git@example.com:api/service.git",
      repoRef: "main",
      isPrimary: true,
    });

    const normal = await loadCompanyProjectOverview(handle.db, company.id);
    expect(normal.body).toContain(cwd);
    expect(normal.body).toContain("read/write files there directly");
    expect(normal.items[0]?.workspaces[0]?.cwd).toBe(cwd);

    const redacted = await loadCompanyProjectOverview(handle.db, company.id, {
      redactLocalWorkspacePaths: true,
    });
    expect(redacted.body).not.toContain(cwd);
    expect(redacted.body).not.toContain("read/write files there directly");
    expect(redacted.body).toContain("Primary local path hidden");
    expect(redacted.items[0]?.workspaces[0]?.cwd).toBeNull();
    expect(redacted.items[0]?.workspaces[0]?.localPathHidden).toBe(true);
  }, 60_000);
});
