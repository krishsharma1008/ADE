// Round 3 Phase 12 — routine origin filter + autoClose tick.
//
// Verifies:
//   1. issueService(db).list(companyId, { excludeOriginKind: "routine_execution" })
//      excludes routine-origin issues while surfacing manual + terminal issues.
//   2. issueService(db).list(companyId, { originKind: "routine_execution" })
//      surfaces only routine-origin issues.
//   3. routineService(db).autoCloseExpiredRoutineIssues(now) closes open
//      routine issues older than autoCloseAfterMs, ignores fresh ones,
//      leaves manual issues untouched, and never touches terminal statuses.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, issues, projects, routines } from "@combyne/db";
import { issueService } from "../issues.js";
import { routineService } from "../routines.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("routine filter + auto-close tick", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let projectId: string;
  let routineId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Routine Filter Co", issuePrefix: "RFC" })
      .returning();
    companyId = company.id;

    const [project] = await handle.db
      .insert(projects)
      .values({ companyId, name: "Routine project" })
      .returning();
    projectId = project.id;

    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Routine Agent", adapterType: "process" })
      .returning();
    agentId = agent.id;

    const [routine] = await handle.db
      .insert(routines)
      .values({
        companyId,
        projectId,
        title: "Nightly routine",
        assigneeAgentId: agentId,
        autoCloseAfterMs: 60 * 60 * 1000, // 1 hour
      })
      .returning();
    routineId = routine.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("excludeOriginKind=routine_execution hides routine issues", async () => {
    const svc = issueService(handle.db);
    await handle.db.insert(issues).values([
      { companyId, projectId, title: "manual #1", status: "todo", originKind: "manual" },
      { companyId, projectId, title: "manual #2", status: "in_progress" }, // originKind null
      {
        companyId,
        projectId,
        title: "routine run #1",
        status: "todo",
        originKind: "routine_execution",
        originId: routineId,
      },
      {
        companyId,
        projectId,
        title: "terminal #1",
        status: "todo",
        originKind: "terminal_session",
      },
    ]);

    const defaultList = await svc.list(companyId);
    const titles = defaultList.map((i) => i.title).sort();
    expect(titles).toContain("routine run #1");

    const excluded = await svc.list(companyId, { excludeOriginKind: "routine_execution" });
    const excludedTitles = excluded.map((i) => i.title).sort();
    expect(excludedTitles).not.toContain("routine run #1");
    // Null originKind + manual + terminal_session are all preserved.
    expect(excludedTitles).toEqual(
      expect.arrayContaining(["manual #1", "manual #2", "terminal #1"]),
    );

    const onlyRoutine = await svc.list(companyId, { originKind: "routine_execution" });
    expect(onlyRoutine.map((i) => i.title)).toEqual(["routine run #1"]);
  });

  it("autoCloseExpiredRoutineIssues closes stale open routine issues", async () => {
    // Clear earlier test data — start fresh for auto-close scenario.
    await handle.db.delete(issues).where(eq(issues.companyId, companyId));

    const now = new Date("2026-04-23T12:00:00Z");
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000);

    // Three routine issues: one old+open (should close), one fresh+open (no),
    // one old+done (already terminal, must not flip updatedAt).
    // Plus one manual issue that's old but unrelated — must not be touched.
    const inserted = await handle.db
      .insert(issues)
      .values([
        {
          companyId,
          projectId,
          title: "stale routine",
          status: "todo",
          originKind: "routine_execution",
          originId: routineId,
          createdAt: twoHoursAgo,
          updatedAt: twoHoursAgo,
        },
        {
          companyId,
          projectId,
          title: "fresh routine",
          status: "todo",
          originKind: "routine_execution",
          originId: routineId,
          createdAt: fifteenMinAgo,
          updatedAt: fifteenMinAgo,
        },
        {
          companyId,
          projectId,
          title: "done routine",
          status: "done",
          originKind: "routine_execution",
          originId: routineId,
          createdAt: twoHoursAgo,
          updatedAt: twoHoursAgo,
        },
        {
          companyId,
          projectId,
          title: "stale manual",
          status: "todo",
          originKind: "manual",
          createdAt: twoHoursAgo,
          updatedAt: twoHoursAgo,
        },
      ])
      .returning();

    const svc = routineService(handle.db);
    const result = await svc.autoCloseExpiredRoutineIssues(now);
    expect(result.closed).toBe(1);

    const byTitle = new Map(
      (
        await handle.db
          .select()
          .from(issues)
          .where(eq(issues.companyId, companyId))
      ).map((row) => [row.title, row]),
    );
    expect(byTitle.get("stale routine")?.status).toBe("done");
    expect(byTitle.get("stale routine")?.completedAt).toBeTruthy();
    expect(byTitle.get("fresh routine")?.status).toBe("todo");
    expect(byTitle.get("done routine")?.status).toBe("done");
    expect(byTitle.get("stale manual")?.status).toBe("todo");

    expect(inserted.length).toBe(4); // sanity
  });

  it("autoClose no-ops when routine has no threshold set", async () => {
    // Make a second routine without autoCloseAfterMs; confirm its issue is untouched.
    const [routineNoClose] = await handle.db
      .insert(routines)
      .values({
        companyId,
        projectId,
        title: "No-close routine",
        assigneeAgentId: agentId,
      })
      .returning();

    const now = new Date("2026-04-23T12:00:00Z");
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await handle.db.insert(issues).values({
      companyId,
      projectId,
      title: "stale no-close routine issue",
      status: "todo",
      originKind: "routine_execution",
      originId: routineNoClose.id,
      createdAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
    });

    const svc = routineService(handle.db);
    const result = await svc.autoCloseExpiredRoutineIssues(now);
    // Only routines with autoCloseAfterMs are considered — the earlier closed
    // "stale routine" is already done, so result.closed is 0 here.
    expect(result.closed).toBe(0);

    const [row] = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.title, "stale no-close routine issue"));
    expect(row?.status).toBe("todo");
  });
});
