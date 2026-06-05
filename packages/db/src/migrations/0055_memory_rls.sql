-- 0055 — Multi-team Row-Level Security for the memory/context tables (PR-17).
--
-- DECISION: ONE shared context Postgres instance + Postgres RLS for per-company
-- isolation (instead of a database-per-tenant). This migration AUTHORS the
-- policies now so they are version-controlled, code-reviewed, and CI-tested
-- against the single tenant, and ENFORCED later at the team-onboarding boundary.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ SAFETY: RLS is ENABLED but deliberately NOT *FORCED*.                      │
-- │                                                                            │
-- │ Postgres skips RLS for a table's OWNER role UNLESS the table is marked     │
-- │ `FORCE ROW LEVEL SECURITY`. The running app (and the embedded test rig)    │
-- │ connect as the DB OWNER role 'combyne', so with ENABLE-but-not-FORCE the   │
-- │ policies are DORMANT for the app: zero behavior change, the green suite    │
-- │ stays green. The policies are nonetheless live and enforce immediately for │
-- │ any NON-owner role (proven by the cross-tenant isolation test, which       │
-- │ connects as a non-owner role with RLS enforced on it).                     │
-- │                                                                            │
-- │ The enforcement flip happens at team onboarding: add a non-owner app role  │
-- │ + `ALTER TABLE … FORCE ROW LEVEL SECURITY` + route every request through   │
-- │ withCompanyScope() (server/src/services/rls-scope.ts). DO NOT add FORCE    │
-- │ here — it would break the owner-connected app and the suite.               │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- GLOBAL LAYER EXCEPTION: instance-wide global memory (0054) carries
-- company_id = NULL (owned by no company, readable/writable across all
-- companies). Each policy therefore allows a row when its company_id matches the
-- caller's `app.current_company` GUC *OR* company_id IS NULL.
--
-- UNSET-GUC SAFETY (fail-closed, not a leak): current_setting('app.current_company', true)
-- returns NULL on a FRESH session, but — critically — returns the EMPTY STRING ''
-- on a connection where a transaction-local SET LOCAL has already been set and
-- then RESET at COMMIT (the normal pooled/reused-connection case). A bare
-- `''::uuid` cast RAISES "invalid input syntax for type uuid", which would break
-- every unscoped query at the enforcement boundary. So we wrap with
-- NULLIF(current_setting(...), '') to fold BOTH the unset (NULL) and reset ('')
-- states to NULL. `NULL::uuid` is NULL, so `company_id = NULL` is NULL (never
-- true) for every per-company row → an enforced non-owner with no scope set sees
-- ONLY the global (company_id IS NULL) rows, never another company's data, and
-- never errors.

-- combyne_scheduler: a BYPASSRLS role to GRANT to instance-wide background jobs
-- (auto-distill, re-embed, decay) that must read/write across all companies at
-- the enforcement boundary. NOLOGIN — it is a role to GRANT, not a login. Created
-- idempotently so re-running the migration (or running it on a DB that already
-- has the role) is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'combyne_scheduler') THEN
    CREATE ROLE combyne_scheduler BYPASSRLS NOLOGIN;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "memory_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_entries_company_isolation" ON "memory_entries"
  USING ("company_id" = NULLIF(current_setting('app.current_company', true), '')::uuid OR "company_id" IS NULL)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company', true), '')::uuid OR "company_id" IS NULL);--> statement-breakpoint

ALTER TABLE "memory_promotions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_promotions_company_isolation" ON "memory_promotions"
  USING ("company_id" = NULLIF(current_setting('app.current_company', true), '')::uuid OR "company_id" IS NULL)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company', true), '')::uuid OR "company_id" IS NULL);--> statement-breakpoint

ALTER TABLE "memory_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_usage_company_isolation" ON "memory_usage"
  USING ("company_id" = NULLIF(current_setting('app.current_company', true), '')::uuid OR "company_id" IS NULL)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company', true), '')::uuid OR "company_id" IS NULL);
