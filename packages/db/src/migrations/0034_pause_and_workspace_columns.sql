-- Backfill columns the server code already reads/writes but which never got
-- a migration. Without this file `@combyne/server` fails `tsc` in ~100
-- places (budgets, execution-workspaces, routines, plugin-host-services),
-- and the feature code would error at runtime the first time it ran.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pause_reason" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "paused_at" timestamptz;

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "pause_reason" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "paused_at" timestamptz;

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "pause_reason" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "paused_at" timestamptz;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "execution_workspace_policy" jsonb;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "codebase" jsonb;

ALTER TABLE "project_workspaces" ADD COLUMN IF NOT EXISTS "default_ref" text;
ALTER TABLE "project_workspaces" ADD COLUMN IF NOT EXISTS "cleanup_command" text;

ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_run_id" uuid;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "project_workspace_id" uuid;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_workspace_id" uuid;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_workspace_preference" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_workspace_settings" jsonb;
