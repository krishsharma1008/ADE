import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@combyne/db";
import { withCompanyScope } from "../rls-scope.js";
import { assertCompanyAccess } from "../../routes/authz.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

/**
 * Cross-tenant RLS isolation (PR-17).
 *
 * The embedded rig connects as the table OWNER 'combyne', and migration 0055
 * deliberately does NOT `FORCE` RLS — so the owner BYPASSES the policies and the
 * full suite stays green with zero behavior change. To actually exercise the
 * policies we mint a SEPARATE non-owner LOGIN role here. A non-owner has RLS
 * ENFORCED on it automatically (no FORCE needed), so connecting as that role and
 * binding `app.current_company` proves the per-company isolation + the global
 * (company_id IS NULL) cross-company exception behave as authored.
 */
describe("cross-tenant memory RLS isolation (PR-17)", () => {
  let handle: TestDbHandle;
  let tenantDb: Db; // non-owner role: RLS enforced
  const COMPANY_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const COMPANY_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  async function visibleSubjects(db: Db, scopedCompany: string | null): Promise<string[]> {
    // Each helper runs in its own transaction so the SET LOCAL scope is isolated
    // (transaction-scoped, cleared at COMMIT — the pgbouncer-safe pattern).
    return db.transaction(async (tx) => {
      if (scopedCompany !== null) {
        await tx.execute(sql`SELECT set_config('app.current_company', ${scopedCompany}, true)`);
      }
      const rows = await tx.execute(
        sql`SELECT subject FROM memory_entries ORDER BY subject`,
      );
      return Array.from(rows as Iterable<{ subject: string }>).map((r) => r.subject);
    });
  }

  beforeAll(async () => {
    handle = await startTestDb();
    const owner = handle.db;

    // Seed: one row per company + one instance-wide GLOBAL row (company_id NULL).
    await owner.execute(
      sql`INSERT INTO memory_entries (company_id, layer, subject, body) VALUES
        (${COMPANY_A}::uuid, 'workspace', 'entry-A', 'company A only'),
        (${COMPANY_B}::uuid, 'workspace', 'entry-B', 'company B only'),
        (NULL, 'global', 'entry-GLOBAL', 'instance-wide global')`,
    );

    // A NON-owner login role: policies are ENFORCED for it (it is not the table
    // owner, and owner-bypass only protects the owner). It needs table privileges
    // to issue the SELECTs — RLS narrows rows ON TOP of the GRANT.
    await owner.execute(
      sql.raw(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'combyne_tenant_test') THEN
             CREATE ROLE combyne_tenant_test LOGIN PASSWORD 'tenant';
           END IF;
         END $$;`,
      ),
    );
    await owner.execute(
      sql.raw(
        `GRANT SELECT, INSERT ON memory_entries, memory_promotions, memory_usage TO combyne_tenant_test`,
      ),
    );

    // Build a connection string for the non-owner role on the SAME embedded pg.
    const url = new URL(handle.connectionString);
    url.username = "combyne_tenant_test";
    url.password = "tenant";
    tenantDb = createDb(url.toString());
  }, 120_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("(a) company A scope sees A's entries + global, NOT company B", async () => {
    const seen = await visibleSubjects(tenantDb, COMPANY_A);
    expect(seen).toContain("entry-A");
    expect(seen).toContain("entry-GLOBAL");
    expect(seen).not.toContain("entry-B");
  });

  it("(b) company B scope sees B's entries + global, NOT company A", async () => {
    const seen = await visibleSubjects(tenantDb, COMPANY_B);
    expect(seen).toContain("entry-B");
    expect(seen).toContain("entry-GLOBAL");
    expect(seen).not.toContain("entry-A");
  });

  it("(c) the global (company_id NULL) row is visible under BOTH company scopes", async () => {
    const underA = await visibleSubjects(tenantDb, COMPANY_A);
    const underB = await visibleSubjects(tenantDb, COMPANY_B);
    expect(underA).toContain("entry-GLOBAL");
    expect(underB).toContain("entry-GLOBAL");
  });

  it("an UNSET scope is fail-closed: sees ONLY global rows, never a tenant's data", async () => {
    // current_setting('app.current_company', true) → NULL when unset → NULL::uuid
    // → the company_id = NULL predicate is never true for a per-company row, so
    // an enforced role with no scope set leaks nothing — it sees only globals.
    const seen = await visibleSubjects(tenantDb, null);
    expect(seen).toEqual(["entry-GLOBAL"]);
  });

  it("(d) withCompanyScope runs against the OWNER db without error (owner bypasses; helper exercised)", async () => {
    // The owner bypasses non-forced RLS, so this returns ALL rows — but the helper
    // (transaction + SET LOCAL app.current_company) is exercised end-to-end, which
    // is the exact path that will enforce isolation after the team-onboarding flip.
    const subjects = await withCompanyScope(handle.db, COMPANY_A, async (tx) => {
      const rows = await tx.execute(sql`SELECT subject FROM memory_entries ORDER BY subject`);
      return Array.from(rows as Iterable<{ subject: string }>).map((r) => r.subject);
    });
    expect(subjects).toContain("entry-A");
    expect(subjects).toContain("entry-B"); // owner bypass: all rows visible
    expect(subjects).toContain("entry-GLOBAL");
  });

  it("assertCompanyAccess is fail-closed on '' / undefined but allows the deliberate null", () => {
    const req = {
      actor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    } as unknown as Parameters<typeof assertCompanyAccess>[0];

    // Empty-string / undefined = unresolved scope → throw, even for instance admin.
    expect(() => assertCompanyAccess(req, "")).toThrow();
    expect(() => assertCompanyAccess(req, undefined)).toThrow();

    // null = the deliberate global-layer instance-wide read → allowed.
    expect(() => assertCompanyAccess(req, null)).not.toThrow();

    // A real companyId for a local_implicit/instance-admin actor → allowed.
    expect(() => assertCompanyAccess(req, COMPANY_A)).not.toThrow();
  });
});
