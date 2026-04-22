// Round 3 Phase 11 — project delete guard + force path.
//
// Verifies projectService(db).remove(id, opts):
//   1. Deleting an empty project succeeds.
//   2. Deleting a project with linked issues returns kind:"conflict" unless
//      force=true; counts distinguish total vs open.
//   3. force=true unlinks issues (projectId=null, archived_project_name set)
//      and deletes the project row.
//   4. Closed issues are counted as well — a project with only closed issues
//      still blocks a non-force delete.
//   5. Unknown id returns kind:"not_found".

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, issues, projects } from "@combyne/db";
import { projectService } from "../projects.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("projectService.remove guard + force path", () => {
  let handle: TestDbHandle;
  let svc: ReturnType<typeof projectService>;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    svc = projectService(handle.db);
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Project Delete Co", issuePrefix: "PDC" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("deletes an empty project", async () => {
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId, name: "Empty project" })
      .returning();
    const result = await svc.remove(project.id);
    expect(result.kind).toBe("deleted");
    if (result.kind === "deleted") {
      expect(result.unlinkedIssueCount).toBe(0);
      expect(result.project.id).toBe(project.id);
    }
  });

  it("returns conflict when open + closed issues reference the project", async () => {
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId, name: "Busy project" })
      .returning();
    await handle.db.insert(issues).values([
      { companyId, projectId: project.id, title: "open1", status: "in_progress" },
      { companyId, projectId: project.id, title: "open2", status: "todo" },
      { companyId, projectId: project.id, title: "closed1", status: "done" },
    ]);

    const result = await svc.remove(project.id);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.issueCount).toBe(3);
      expect(result.openCount).toBe(2);
    }

    // Project row still there.
    const [row] = await handle.db
      .select()
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row).toBeDefined();
  });

  it("force=true unlinks issues and archives the project name", async () => {
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId, name: "Force delete me" })
      .returning();
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        projectId: project.id,
        title: "Attached issue",
        status: "in_progress",
      })
      .returning();

    const result = await svc.remove(project.id, { force: true });
    expect(result.kind).toBe("deleted");
    if (result.kind === "deleted") {
      expect(result.unlinkedIssueCount).toBe(1);
    }

    const [refreshed] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(refreshed.projectId).toBeNull();
    expect(refreshed.archivedProjectName).toBe("Force delete me");

    const [projectRow] = await handle.db
      .select()
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(projectRow).toBeUndefined();
  });

  it("blocks non-force delete even when all issues are closed", async () => {
    const [project] = await handle.db
      .insert(projects)
      .values({ companyId, name: "Only closed issues" })
      .returning();
    await handle.db.insert(issues).values([
      { companyId, projectId: project.id, title: "d1", status: "done" },
      { companyId, projectId: project.id, title: "d2", status: "cancelled" },
    ]);
    const result = await svc.remove(project.id);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.issueCount).toBe(2);
      expect(result.openCount).toBe(0);
    }
  });

  it("returns not_found for an unknown id", async () => {
    const result = await svc.remove("00000000-0000-0000-0000-000000000000");
    expect(result.kind).toBe("not_found");
  });
});
