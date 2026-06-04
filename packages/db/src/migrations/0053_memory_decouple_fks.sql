-- 0053 — Decouple the memory/context layer from the main DB's entity tables
-- (CENTRAL_CONTEXT_DB_PLAN — separate dedicated context DB).
--
-- The memory tables (memory_entries, memory_promotions, agent_memory) can now
-- physically live in a SEPARATE Postgres selected by CONTEXT_DATABASE_URL. A
-- cross-database foreign key is impossible, so we drop the cross-entity FKs that
-- point from the memory tables into companies/agents/issues/heartbeat_runs. The
-- decoupled columns KEEP their values as logical references into the main DB.
--
-- Within-memory FKs are intentionally PRESERVED (memory_promotions.source_entry_id,
-- memory_usage.entry_id, memory_entries.superseded_by_id) — those stay inside the
-- context DB and remain enforceable. memory_usage.company_id already has no FK.
ALTER TABLE "memory_entries" DROP CONSTRAINT IF EXISTS "memory_entries_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "memory_promotions" DROP CONSTRAINT IF EXISTS "memory_promotions_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "agent_memory" DROP CONSTRAINT IF EXISTS "agent_memory_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "agent_memory" DROP CONSTRAINT IF EXISTS "agent_memory_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "agent_memory" DROP CONSTRAINT IF EXISTS "agent_memory_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "agent_memory" DROP CONSTRAINT IF EXISTS "agent_memory_source_run_id_heartbeat_runs_id_fk";
