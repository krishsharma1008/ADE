ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "latest_user_facing_agent_message" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "blocked_source" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "blocked_at" timestamp with time zone;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "issue_context_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "public"."companies"("id"),
	"issue_id" uuid NOT NULL REFERENCES "public"."issues"("id") ON DELETE cascade,
	"source_comment_id" uuid REFERENCES "public"."issue_comments"("id") ON DELETE set null,
	"created_by_agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE set null,
	"created_by_user_id" text,
	"kind" text NOT NULL,
	"label" text,
	"raw_ref" text NOT NULL,
	"resolved_ref" text,
	"accessibility_status" text DEFAULT 'unknown' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_context_refs_company_issue_idx" ON "issue_context_refs" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_context_refs_company_issue_raw_uq" ON "issue_context_refs" USING btree ("company_id","issue_id","raw_ref");--> statement-breakpoint

ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_pid" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_host_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_restart_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "recovery_status" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "retry_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_loss_retry_count" integer DEFAULT 0 NOT NULL;
