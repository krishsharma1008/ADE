-- Issue 4 — usage_pause_windows.
--
-- NOTE: drizzle-kit generated this diff against the 0044 snapshot (the 0045 /
-- 0046 migrations were hand-written without refreshing the drizzle snapshots),
-- so it spuriously re-emitted issue_context_refs / heartbeat_runs / issues
-- statements that already shipped in 0045+0046. Those were removed by hand —
-- this migration must ONLY introduce usage_pause_windows. Written with
-- IF NOT EXISTS to match the idempotent style of 0045 so it is safe to apply
-- against a DB that already has the table.
CREATE TABLE IF NOT EXISTS "usage_pause_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
	"agent_id" uuid NOT NULL REFERENCES "public"."agents"("id") ON DELETE cascade,
	"run_id" uuid NOT NULL REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade,
	"session_id_to_resume" text NOT NULL,
	"session_cwd" text,
	"paused_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resets_at" timestamp with time zone,
	"pause_reason" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"retry_backoff_ms" integer DEFAULT 30000 NOT NULL,
	"max_retries" integer DEFAULT 10 NOT NULL,
	"last_error_message" text,
	"last_resume_attempt_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_pause_windows_company_agent_idx" ON "usage_pause_windows" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_pause_windows_next_retry_idx" ON "usage_pause_windows" USING btree ("next_retry_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_pause_windows_resets_at_idx" ON "usage_pause_windows" USING btree ("resets_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_pause_windows_run_uq" ON "usage_pause_windows" USING btree ("run_id");
