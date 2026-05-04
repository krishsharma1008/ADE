CREATE TABLE IF NOT EXISTS "accepted_work_events" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "company_id" uuid NOT NULL,
    "provider" text DEFAULT 'github' NOT NULL,
    "repo" text NOT NULL,
    "pull_number" integer NOT NULL,
    "pull_url" text,
    "title" text NOT NULL,
    "body" text,
    "head_branch" text,
    "merged_sha" text,
    "merged_at" timestamp with time zone,
    "detected_at" timestamp with time zone DEFAULT now() NOT NULL,
    "detection_source" text NOT NULL,
    "issue_id" uuid,
    "contributor_agent_id" uuid,
    "manager_agent_id" uuid,
    "wakeup_requested_at" timestamp with time zone,
    "memory_status" text DEFAULT 'pending' NOT NULL,
    "memory_entry_id" uuid,
    "metadata" jsonb,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accepted_work_events" ADD CONSTRAINT "accepted_work_events_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "accepted_work_events" ADD CONSTRAINT "accepted_work_events_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "accepted_work_events" ADD CONSTRAINT "accepted_work_events_contributor_agent_id_agents_id_fk"
    FOREIGN KEY ("contributor_agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "accepted_work_events" ADD CONSTRAINT "accepted_work_events_manager_agent_id_agents_id_fk"
    FOREIGN KEY ("manager_agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "accepted_work_events" ADD CONSTRAINT "accepted_work_events_memory_entry_id_memory_entries_id_fk"
    FOREIGN KEY ("memory_entry_id") REFERENCES "memory_entries"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accepted_work_events_company_status_idx" ON "accepted_work_events" ("company_id","memory_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accepted_work_events_manager_status_idx" ON "accepted_work_events" ("company_id","manager_agent_id","memory_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accepted_work_events_issue_idx" ON "accepted_work_events" ("company_id","issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accepted_work_events_provider_pr_uq" ON "accepted_work_events" ("company_id","provider","repo","pull_number");
