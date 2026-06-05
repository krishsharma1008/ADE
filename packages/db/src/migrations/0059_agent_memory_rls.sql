-- 0059 — Row-Level Security for agent_memory (RLS-AGENTMEM-1).
--
-- agent_memory is a CONTEXT table: it carries company_id, is routed through
-- resolveContextDb (so it lives on the shared remote context DB), and is carried
-- by the memory ETL. But migration 0055 enabled RLS only on memory_entries /
-- memory_promotions / memory_usage — leaving agent_memory the one shared
-- per-company context table whose DB-level isolation was dormant AND untested.
-- This migration brings it into the same posture as the rest of the spine.
--
-- Same SAFETY model as 0055: ENABLE (not FORCE) — dormant for the owner-connected
-- app today, enforced for any non-owner role, flipped to FORCE at team onboarding.
-- agent_memory has no global (company_id IS NULL) layer today; the `OR company_id
-- IS NULL` arm is harmless and future-proofs a later global agent-memory layer.
-- DDL is guarded so a concurrent/repeat apply (advisory-lock belt, MIGPROV-1) is
-- a no-op rather than a crash.

ALTER TABLE "agent_memory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_memory'
      AND policyname = 'agent_memory_company_isolation'
  ) THEN
    CREATE POLICY "agent_memory_company_isolation" ON "agent_memory"
      USING ("company_id" = NULLIF(current_setting('app.current_company', true), '')::uuid OR "company_id" IS NULL)
      WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company', true), '')::uuid OR "company_id" IS NULL);
  END IF;
END $$;
