import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { companies, memoryEntries } from "@combyne/db";
import { EVAL_ENTRIES } from "../../src/services/embedding-eval-fixture.js";
import { EVAL_CODE_SUBJECTS } from "../embedding-eval-code.js";
import {
  FIXTURE_SUBJECT_ALLOWLIST,
  FIXTURE_SUBJECT_COUNT,
  buildFixtureCleanupFilter,
  selectFixtureRows,
  deleteFixtureRows,
} from "../cleanup-global-fixtures.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "../../src/services/__tests__/_test-db.js";

// A subject that is NOT any fixture — used for the non-allowlist case.
const NON_FIXTURE_SUBJECT = "Some genuinely captured company knowledge (not a fixture)";

describe("Phase 4 cleanup-global-fixtures", () => {
  let handle: TestDbHandle;
  let companyId: string;

  // Track the rows we seed so the assertions key off real ids, not counts.
  let fixtureGlobalNullSourceId: string; // (1) allowlist subject + NULL source -> matched
  let fixtureGlobalPromotionId: string; // (2) allowlist subject but global-promotion source -> NOT matched
  let nonFixtureGlobalId: string; // (3) non-allowlist subject -> NOT matched
  let fixtureCompanyScopedId: string; // (4) company-scoped allowlist subject -> NOT matched

  beforeAll(async () => {
    handle = await startTestDb();

    // A real company so the company-scoped (workspace) row carries a genuine company_id.
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: `CleanupCo-${suffix}`, issuePrefix: `C${suffix}` })
      .returning();
    companyId = company.id;

    const fixtureSubject = FIXTURE_SUBJECT_ALLOWLIST[0];

    // (1) GLOBAL, allowlist subject, NULL source — the leftover fixture to delete.
    const [r1] = await handle.db
      .insert(memoryEntries)
      .values({
        companyId: null,
        layer: "global",
        status: "active",
        subject: fixtureSubject,
        body: "leftover eval fixture body",
        source: null,
      })
      .returning();
    fixtureGlobalNullSourceId = r1.id;

    // (2) GLOBAL, allowlist subject, but a human-governed global-promotion source — must be LEFT.
    const [r2] = await handle.db
      .insert(memoryEntries)
      .values({
        companyId: null,
        layer: "global",
        status: "active",
        subject: FIXTURE_SUBJECT_ALLOWLIST[1],
        body: "promoted into global by a human",
        source: "global-promotion:abc",
      })
      .returning();
    fixtureGlobalPromotionId = r2.id;

    // (3) GLOBAL, NON-allowlist subject — must be LEFT.
    const [r3] = await handle.db
      .insert(memoryEntries)
      .values({
        companyId: null,
        layer: "global",
        status: "active",
        subject: NON_FIXTURE_SUBJECT,
        body: "real global knowledge",
        source: null,
      })
      .returning();
    nonFixtureGlobalId = r3.id;

    // (4) Company-scoped (real company_id, layer=workspace), allowlist subject — must be LEFT.
    const [r4] = await handle.db
      .insert(memoryEntries)
      .values({
        companyId,
        layer: "workspace",
        status: "active",
        subject: fixtureSubject,
        body: "a company genuinely captured this subject",
        source: null,
      })
      .returning();
    fixtureCompanyScopedId = r4.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("imports the allowlist from source and pins its size to 30", () => {
    // 14 EVAL_ENTRIES + 16 EVAL_CODE_SUBJECTS = 30, never hardcoded.
    expect(EVAL_ENTRIES.length).toBe(14);
    expect(EVAL_CODE_SUBJECTS.length).toBe(16);
    expect(FIXTURE_SUBJECT_COUNT).toBe(30);
    expect(FIXTURE_SUBJECT_ALLOWLIST.length).toBe(30);
  });

  it("the filter is built from declared columns only (no embedding_vec in the SQL)", () => {
    // Render the predicate to its real SQL string and assert it touches only the
    // declared columns and NEVER the conditional pgvector embedding_vec column.
    const { sql, params } = new PgDialect().sqlToQuery(buildFixtureCleanupFilter());
    expect(sql).not.toContain("embedding_vec");
    expect(sql).toContain("company_id");
    expect(sql).toContain("layer");
    expect(sql).toContain("status");
    expect(sql).toContain("subject");
    expect(sql).toContain("source");
    // The required (IS NULL OR NOT LIKE) form, and the promotion literal bound as a param.
    expect(sql).toContain('"source" is null or "memory_entries"."source" not like');
    expect(params).toContain("global-promotion:%");
  });

  it("selectFixtureRows matches ONLY the global allowlist+non-promotion row", async () => {
    const rows = await selectFixtureRows(handle.db);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(fixtureGlobalNullSourceId); // (1) matched
    expect(ids).not.toContain(fixtureGlobalPromotionId); // (2) promotion source -> NOT matched
    expect(ids).not.toContain(nonFixtureGlobalId); // (3) non-allowlist -> NOT matched
    expect(ids).not.toContain(fixtureCompanyScopedId); // (4) company-scoped -> NOT matched
    expect(rows.length).toBe(1);

    // Every matched subject is genuinely in the allowlist.
    const allowed = new Set(FIXTURE_SUBJECT_ALLOWLIST);
    expect(rows.every((r) => allowed.has(r.subject))).toBe(true);
  });

  it("deleteFixtureRows removes ONLY the fixture and reports deleted===previewed", async () => {
    const result = await deleteFixtureRows(handle.db);

    // deleted === previewed (NOT a hardcoded count).
    expect(result.deleted).toBe(result.previewed);
    expect(result.deleted).toBe(1);

    const remaining = await handle.db.select().from(memoryEntries);
    const remainingIds = remaining.map((r) => r.id);

    // Only the leftover fixture is gone; the other three survive.
    expect(remainingIds).not.toContain(fixtureGlobalNullSourceId);
    expect(remainingIds).toContain(fixtureGlobalPromotionId);
    expect(remainingIds).toContain(nonFixtureGlobalId);
    expect(remainingIds).toContain(fixtureCompanyScopedId);
  });

  it("is idempotent: a second delete finds nothing", async () => {
    const again = await deleteFixtureRows(handle.db);
    expect(again.previewed).toBe(0);
    expect(again.deleted).toBe(0);
  });

  it("NEVER runs the CLI on import: importing the module has no side effects", async () => {
    const before = await handle.db.select().from(memoryEntries).where(eq(memoryEntries.companyId, companyId));
    const mod = await import("../cleanup-global-fixtures.js");
    expect(typeof mod.buildFixtureCleanupFilter).toBe("function");
    expect(typeof mod.selectFixtureRows).toBe("function");
    expect(typeof mod.deleteFixtureRows).toBe("function");
    const after = await handle.db.select().from(memoryEntries).where(eq(memoryEntries.companyId, companyId));
    expect(after.length).toBe(before.length);
  });
});
