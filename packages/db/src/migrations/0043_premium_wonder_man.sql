CREATE TABLE IF NOT EXISTS "issue_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"approval_id" uuid,
	"requested_by_agent_id" uuid,
	"provider" text DEFAULT 'github' NOT NULL,
	"repo" text NOT NULL,
	"pull_number" integer NOT NULL,
	"pull_url" text NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"base_branch" text NOT NULL,
	"head_branch" text,
	"head_sha" text,
	"expected_head_sha" text,
	"merge_commit_sha" text,
	"merge_method" text DEFAULT 'squash' NOT NULL,
	"ci_status" text DEFAULT 'unknown' NOT NULL,
	"review_status" text DEFAULT 'unknown' NOT NULL,
	"quality_status" text DEFAULT 'not_configured' NOT NULL,
	"merge_status" text DEFAULT 'pending' NOT NULL,
	"feedback_status" text DEFAULT 'idle' NOT NULL,
	"last_feedback_hash" text,
	"last_feedback_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_pull_requests" ADD CONSTRAINT "issue_pull_requests_company_id_companies_id_fk"
 FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_pull_requests" ADD CONSTRAINT "issue_pull_requests_issue_id_issues_id_fk"
 FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_pull_requests" ADD CONSTRAINT "issue_pull_requests_approval_id_approvals_id_fk"
 FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_pull_requests" ADD CONSTRAINT "issue_pull_requests_requested_by_agent_id_agents_id_fk"
 FOREIGN KEY ("requested_by_agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_pull_requests_company_issue_idx" ON "issue_pull_requests" ("company_id","issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_pull_requests_company_merge_status_idx" ON "issue_pull_requests" ("company_id","merge_status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_pull_requests_unique_pr_idx" ON "issue_pull_requests" ("company_id","provider","repo","pull_number");
