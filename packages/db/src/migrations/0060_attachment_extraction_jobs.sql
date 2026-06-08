CREATE TABLE IF NOT EXISTS "attachment_extraction_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"answer_comment_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"question_text" text NOT NULL,
	"answer_text" text NOT NULL,
	"content_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_extraction_jobs_asset_id_unique" UNIQUE("asset_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachment_extraction_jobs_due_idx" ON "attachment_extraction_jobs" ("next_attempt_at");
