CREATE TABLE "qa_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"result_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"storage_key" text,
	"content_type" text,
	"byte_size" integer,
	"summary" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"worker_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'android_emulator' NOT NULL,
	"platform" text DEFAULT 'android' NOT NULL,
	"os_version" text,
	"api_level" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'api' NOT NULL,
	"base_url" text,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid,
	"issue_id" uuid,
	"from_qa_agent_id" uuid,
	"to_agent_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"dedupe_hash" text NOT NULL,
	"artifact_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"creates_bug_issue" boolean DEFAULT false NOT NULL,
	"bug_issue_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid,
	"owner_agent_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_result" text NOT NULL,
	"platform" text DEFAULT 'api' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"service" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" uuid,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"expected_result" text,
	"actual_result" text,
	"failure_reason" text,
	"duration_ms" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid,
	"project_id" uuid,
	"suite_id" uuid,
	"environment_id" uuid,
	"device_id" uuid,
	"qa_agent_id" uuid,
	"requested_by_agent_id" uuid,
	"created_by_run_id" uuid,
	"title" text NOT NULL,
	"platform" text DEFAULT 'api' NOT NULL,
	"runner_type" text DEFAULT 'custom_command' NOT NULL,
	"repo" text,
	"service" text,
	"pull_number" integer,
	"pull_url" text,
	"head_sha" text,
	"build_sha" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"conclusion" text DEFAULT 'unknown' NOT NULL,
	"command_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parser_type" text DEFAULT 'none' NOT NULL,
	"summary" text,
	"signoff_status" text DEFAULT 'not_requested' NOT NULL,
	"signoff_by_user_id" text,
	"signoff_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_test_suites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"platform" text DEFAULT 'api' NOT NULL,
	"runner_type" text DEFAULT 'custom_command' NOT NULL,
	"service" text,
	"case_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"command_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parser_type" text DEFAULT 'none' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qa_artifacts" ADD CONSTRAINT "qa_artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_artifacts" ADD CONSTRAINT "qa_artifacts_run_id_qa_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."qa_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_artifacts" ADD CONSTRAINT "qa_artifacts_result_id_qa_test_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."qa_test_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_devices" ADD CONSTRAINT "qa_devices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_environments" ADD CONSTRAINT "qa_environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_feedback_events" ADD CONSTRAINT "qa_feedback_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_feedback_events" ADD CONSTRAINT "qa_feedback_events_run_id_qa_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."qa_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_feedback_events" ADD CONSTRAINT "qa_feedback_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_feedback_events" ADD CONSTRAINT "qa_feedback_events_from_qa_agent_id_agents_id_fk" FOREIGN KEY ("from_qa_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_feedback_events" ADD CONSTRAINT "qa_feedback_events_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_feedback_events" ADD CONSTRAINT "qa_feedback_events_bug_issue_id_issues_id_fk" FOREIGN KEY ("bug_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_cases" ADD CONSTRAINT "qa_test_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_cases" ADD CONSTRAINT "qa_test_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_cases" ADD CONSTRAINT "qa_test_cases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_cases" ADD CONSTRAINT "qa_test_cases_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_results" ADD CONSTRAINT "qa_test_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_results" ADD CONSTRAINT "qa_test_results_run_id_qa_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."qa_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_results" ADD CONSTRAINT "qa_test_results_case_id_qa_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."qa_test_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_suite_id_qa_test_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."qa_test_suites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_environment_id_qa_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."qa_environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_device_id_qa_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."qa_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_qa_agent_id_agents_id_fk" FOREIGN KEY ("qa_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_runs" ADD CONSTRAINT "qa_test_runs_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_suites" ADD CONSTRAINT "qa_test_suites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_test_suites" ADD CONSTRAINT "qa_test_suites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qa_artifacts_company_run_idx" ON "qa_artifacts" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "qa_artifacts_company_type_idx" ON "qa_artifacts" USING btree ("company_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_devices_company_worker_name_uq" ON "qa_devices" USING btree ("company_id","worker_id","name");--> statement-breakpoint
CREATE INDEX "qa_devices_company_health_idx" ON "qa_devices" USING btree ("company_id","health_status");--> statement-breakpoint
CREATE INDEX "qa_environments_company_kind_idx" ON "qa_environments" USING btree ("company_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_environments_company_name_uq" ON "qa_environments" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "qa_feedback_events_company_status_idx" ON "qa_feedback_events" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "qa_feedback_events_company_issue_idx" ON "qa_feedback_events" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_feedback_events_company_dedupe_uq" ON "qa_feedback_events" USING btree ("company_id","dedupe_hash");--> statement-breakpoint
CREATE INDEX "qa_test_cases_company_platform_idx" ON "qa_test_cases" USING btree ("company_id","platform");--> statement-breakpoint
CREATE INDEX "qa_test_cases_company_service_idx" ON "qa_test_cases" USING btree ("company_id","service");--> statement-breakpoint
CREATE INDEX "qa_test_cases_company_updated_idx" ON "qa_test_cases" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "qa_test_results_company_run_idx" ON "qa_test_results" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "qa_test_results_company_status_idx" ON "qa_test_results" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "qa_test_runs_company_status_idx" ON "qa_test_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "qa_test_runs_company_issue_idx" ON "qa_test_runs" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "qa_test_runs_company_suite_idx" ON "qa_test_runs" USING btree ("company_id","suite_id");--> statement-breakpoint
CREATE INDEX "qa_test_runs_company_pr_idx" ON "qa_test_runs" USING btree ("company_id","repo","pull_number");--> statement-breakpoint
CREATE INDEX "qa_test_runs_company_updated_idx" ON "qa_test_runs" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_test_suites_company_name_uq" ON "qa_test_suites" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "qa_test_suites_company_runner_idx" ON "qa_test_suites" USING btree ("company_id","runner_type");--> statement-breakpoint
CREATE INDEX "qa_test_suites_company_updated_idx" ON "qa_test_suites" USING btree ("company_id","updated_at");