-- Max-turns continuation windows.
--
-- Durable per-TASK budget for the max-turns continuation engine. When the
-- Claude adapter exits at its per-run turn cap (`claude_max_turns`) and the
-- task is still making git-measured progress under budget, a warm continuation
-- run is re-enqueued on the same issue instead of blocking it. One row per
-- issue (UNIQUE on issue_id) holds the round / cumulative-turn book-keeping and
-- the session needed to resume. Separate from usage_pause_windows on purpose —
-- the two lifecycles are distinct and must not share a table.
--
-- Written with IF NOT EXISTS to match the idempotent style of the surrounding
-- migrations so it is safe to apply against a DB that already has the table.
CREATE TABLE IF NOT EXISTS "max_turns_continuation_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
	"agent_id" uuid NOT NULL REFERENCES "public"."agents"("id") ON DELETE cascade,
	"issue_id" uuid NOT NULL REFERENCES "public"."issues"("id") ON DELETE cascade,
	"run_id" uuid REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null,
	"session_id_to_resume" text,
	"session_cwd" text,
	"round_count" integer DEFAULT 0 NOT NULL,
	"max_rounds" integer DEFAULT 3 NOT NULL,
	"cumulative_turns" integer DEFAULT 0 NOT NULL,
	"max_total_turns" integer DEFAULT 200 NOT NULL,
	"head_sha_at_last_round" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "max_turns_continuation_windows_company_agent_idx" ON "max_turns_continuation_windows" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "max_turns_continuation_windows_issue_uq" ON "max_turns_continuation_windows" USING btree ("issue_id");
