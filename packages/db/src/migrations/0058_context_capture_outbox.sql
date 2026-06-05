CREATE TABLE IF NOT EXISTS "context_capture_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"company_id" uuid NOT NULL,
	"provenance" text,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_capture_outbox_source_unique" UNIQUE("source")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_capture_outbox_due_idx" ON "context_capture_outbox" ("next_attempt_at");
