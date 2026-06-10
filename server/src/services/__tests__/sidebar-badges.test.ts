// F10 (e2e-run-2026-06-10 finding #10): awaiting_user issues were invisible at the
// notification level — sidebar-badges now exposes an awaitingUser count and folds it
// into the inbox sum.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, issues } from "@combyne/db";
import { sidebarBadgeService } from "../sidebar-badges.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("F10: sidebar badges count awaiting_user issues", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Badge Co", issuePrefix: "BDG" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("counts awaiting_user issues into awaitingUser and inbox", async () => {
    const svc = sidebarBadgeService(handle.db);
    const empty = await svc.get(companyId);
    expect(empty.awaitingUser).toBe(0);

    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Needs an answer", status: "awaiting_user" })
      .returning();
    await handle.db
      .insert(issues)
      .values({ companyId, title: "Normal work", status: "in_progress" });

    const withAwaiting = await svc.get(companyId);
    expect(withAwaiting.awaitingUser).toBe(1);
    expect(withAwaiting.inbox).toBe(empty.inbox + 1);

    // Resolving the issue clears the badge.
    await handle.db.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id));
    const cleared = await svc.get(companyId);
    expect(cleared.awaitingUser).toBe(0);
    expect(cleared.inbox).toBe(empty.inbox);
  });
});
