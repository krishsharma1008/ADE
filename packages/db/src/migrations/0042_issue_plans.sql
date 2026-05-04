CREATE TABLE IF NOT EXISTS "issue_plans" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "issue_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "author_agent_id" uuid,
    "author_user_id" text,
    "content" text NOT NULL,
    "status" text DEFAULT 'draft' NOT NULL,
    "approval_id" uuid,
    "version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "issue_plans" ADD CONSTRAINT "issue_plans_issue_id_issues_id_fk"
 FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_plans" ADD CONSTRAINT "issue_plans_company_id_companies_id_fk"
 FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_plans" ADD CONSTRAINT "issue_plans_author_agent_id_agents_id_fk"
 FOREIGN KEY ("author_agent_id") REFERENCES "agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
 ALTER TABLE "issue_plans" ADD CONSTRAINT "issue_plans_approval_id_approvals_id_fk"
 FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "issue_plans_issue_idx" ON "issue_plans" ("issue_id");
CREATE INDEX IF NOT EXISTS "issue_plans_company_status_idx" ON "issue_plans" ("company_id","status");
