// Recall fix (e2e round-2 prep): a serviceScope on retrieval must narrow to that
// repo's entries PLUS company-wide entries (service_scope IS NULL) — exact-match
// scoping silently excluded null-scoped human answers (the highest-trust facts)
// from every scoped passdown/recall. The UI browse filter (listEntries) keeps
// exact-match semantics: explicitly filtering by scope means that scope only.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies } from "@combyne/db";
import { memoryService } from "../memory.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("scoped memory recall includes company-wide (null-scope) entries", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let scopedId: string;
  let unscopedId: string;
  let otherScopeId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Scope Recall Co", issuePrefix: "SRC" })
      .returning();
    companyId = company.id;
    const svc = memoryService(handle.db);
    scopedId = (
      await svc.createEntry({
        companyId,
        layer: "workspace",
        subject: "Zentropy widget invoicing rounds to two decimals",
        body: "Round zentropy widget invoice totals to two decimals before persisting.",
        serviceScope: "acme/widget-service",
      })
    ).id;
    unscopedId = (
      await svc.createEntry({
        companyId,
        layer: "workspace",
        subject: "Zentropy widget invoicing must never round before tax",
        body: "Company-wide rule: zentropy widget invoice tax is computed pre-rounding.",
        // no serviceScope — company-wide human knowledge
      })
    ).id;
    otherScopeId = (
      await svc.createEntry({
        companyId,
        layer: "workspace",
        subject: "Zentropy widget invoicing import cron",
        body: "The zentropy widget invoice importer runs hourly.",
        serviceScope: "acme/other-service",
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("queryRanked with serviceScope returns scoped + null-scope, not other scopes", async () => {
    const svc = memoryService(handle.db);
    const result = await svc.queryRanked(companyId, "zentropy widget invoicing rounding", {
      layers: ["workspace", "shared"],
      serviceScope: "acme/widget-service",
      limit: 10,
    });
    const ids = result.items.map((item) => item.id);
    expect(ids).toContain(scopedId);
    expect(ids).toContain(unscopedId);
    expect(ids).not.toContain(otherScopeId);
  });

  it("listEntries browse filter keeps exact-match scope semantics", async () => {
    const svc = memoryService(handle.db);
    const list = await svc.listEntries({
      companyId,
      serviceScope: "acme/widget-service",
      status: "active",
    });
    const ids = list.map((entry) => entry.id);
    expect(ids).toContain(scopedId);
    expect(ids).not.toContain(unscopedId);
  });
});
