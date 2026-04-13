-- Migration: Create tables from Paperclip merge
-- These tables support skills, plugins, routines, workspaces, documents, finance, and more.

-- 1. instance_settings
CREATE TABLE IF NOT EXISTS instance_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key TEXT NOT NULL DEFAULT 'default',
  general JSONB NOT NULL DEFAULT '{}'::jsonb,
  experimental JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS instance_settings_singleton_key_idx ON instance_settings (singleton_key);

-- 2. board_api_keys
CREATE TABLE IF NOT EXISTS board_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  last_used_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS board_api_keys_key_hash_idx ON board_api_keys (key_hash);
CREATE INDEX IF NOT EXISTS board_api_keys_user_idx ON board_api_keys (user_id);

-- 3. company_skills
CREATE TABLE IF NOT EXISTS company_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  key TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  markdown TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'local_path',
  source_locator TEXT,
  source_ref TEXT,
  trust_level TEXT NOT NULL DEFAULT 'markdown_only',
  compatibility TEXT NOT NULL DEFAULT 'compatible',
  file_inventory JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS company_skills_company_key_idx ON company_skills (company_id, key);
CREATE INDEX IF NOT EXISTS company_skills_company_name_idx ON company_skills (company_id, name);

-- 4. company_logos
CREATE TABLE IF NOT EXISTS company_logos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS company_logos_company_uq ON company_logos (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS company_logos_asset_uq ON company_logos (asset_id);

-- 5. documents
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  title TEXT,
  format TEXT NOT NULL DEFAULT 'markdown',
  latest_body TEXT NOT NULL,
  latest_revision_id UUID,
  latest_revision_number INTEGER NOT NULL DEFAULT 1,
  created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_by_user_id TEXT,
  updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  updated_by_user_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS documents_company_updated_idx ON documents (company_id, updated_at);

-- 6. document_revisions
CREATE TABLE IF NOT EXISTS document_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  title TEXT,
  format TEXT NOT NULL DEFAULT 'markdown',
  body TEXT NOT NULL,
  change_summary TEXT,
  created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_by_user_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS document_revisions_document_revision_uq ON document_revisions (document_id, revision_number);

-- 7. issue_documents
CREATE TABLE IF NOT EXISTS issue_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS issue_documents_company_issue_key_uq ON issue_documents (company_id, issue_id, key);
CREATE UNIQUE INDEX IF NOT EXISTS issue_documents_document_uq ON issue_documents (document_id);

-- 8. issue_inbox_archives
CREATE TABLE IF NOT EXISTS issue_inbox_archives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  issue_id UUID NOT NULL REFERENCES issues(id),
  user_id TEXT NOT NULL,
  archived_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS issue_inbox_archives_company_issue_user_idx ON issue_inbox_archives (company_id, issue_id, user_id);

-- 9. execution_workspaces
CREATE TABLE IF NOT EXISTS execution_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_workspace_id UUID REFERENCES project_workspaces(id) ON DELETE SET NULL,
  source_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  mode TEXT NOT NULL,
  strategy_type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  cwd TEXT,
  repo_url TEXT,
  base_ref TEXT,
  branch_name TEXT,
  provider_type TEXT NOT NULL DEFAULT 'local_fs',
  provider_ref TEXT,
  derived_from_execution_workspace_id UUID,
  last_used_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  opened_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP WITH TIME ZONE,
  cleanup_eligible_at TIMESTAMP WITH TIME ZONE,
  cleanup_reason TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS execution_workspaces_company_project_status_idx ON execution_workspaces (company_id, project_id, status);

-- 10. workspace_operations
CREATE TABLE IF NOT EXISTS workspace_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  execution_workspace_id UUID REFERENCES execution_workspaces(id) ON DELETE SET NULL,
  heartbeat_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  phase TEXT NOT NULL,
  command TEXT,
  cwd TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  log_store TEXT,
  log_ref TEXT,
  log_bytes BIGINT,
  log_sha256 TEXT,
  log_compressed BOOLEAN NOT NULL DEFAULT FALSE,
  stdout_excerpt TEXT,
  stderr_excerpt TEXT,
  metadata JSONB,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspace_operations_company_run_started_idx ON workspace_operations (company_id, heartbeat_run_id, started_at);

-- 11. workspace_runtime_services
CREATE TABLE IF NOT EXISTS workspace_runtime_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  project_workspace_id UUID REFERENCES project_workspaces(id) ON DELETE SET NULL,
  execution_workspace_id UUID REFERENCES execution_workspaces(id) ON DELETE SET NULL,
  issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  service_name TEXT NOT NULL,
  status TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  reuse_key TEXT,
  command TEXT,
  cwd TEXT,
  port INTEGER,
  url TEXT,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  owner_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  started_by_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  last_used_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMP WITH TIME ZONE,
  stop_policy JSONB,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspace_runtime_services_company_workspace_status_idx ON workspace_runtime_services (company_id, project_workspace_id, status);

-- 12. issue_work_products
CREATE TABLE IF NOT EXISTS issue_work_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  execution_workspace_id UUID REFERENCES execution_workspaces(id) ON DELETE SET NULL,
  runtime_service_id UUID REFERENCES workspace_runtime_services(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'none',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  summary TEXT,
  metadata JSONB,
  created_by_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS issue_work_products_company_issue_type_idx ON issue_work_products (company_id, issue_id, type);

-- 13. finance_events
CREATE TABLE IF NOT EXISTS finance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID REFERENCES agents(id),
  issue_id UUID REFERENCES issues(id),
  project_id UUID REFERENCES projects(id),
  goal_id UUID REFERENCES goals(id),
  heartbeat_run_id UUID REFERENCES heartbeat_runs(id),
  cost_event_id UUID REFERENCES cost_events(id),
  billing_code TEXT,
  description TEXT,
  event_kind TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'debit',
  biller TEXT NOT NULL,
  provider TEXT,
  execution_adapter_type TEXT,
  pricing_tier TEXT,
  region TEXT,
  model TEXT,
  quantity INTEGER,
  unit TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  estimated BOOLEAN NOT NULL DEFAULT FALSE,
  external_invoice_id TEXT,
  metadata_json JSONB,
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_events_company_occurred_idx ON finance_events (company_id, occurred_at);

-- 14. budget_policies
CREATE TABLE IF NOT EXISTS budget_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  scope_type TEXT NOT NULL,
  scope_id UUID NOT NULL,
  metric TEXT NOT NULL DEFAULT 'billed_cents',
  window_kind TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  warn_percent INTEGER NOT NULL DEFAULT 80,
  hard_stop_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS budget_policies_company_scope_active_idx ON budget_policies (company_id, scope_type, scope_id, is_active);

-- 15. budget_incidents
CREATE TABLE IF NOT EXISTS budget_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  policy_id UUID NOT NULL REFERENCES budget_policies(id),
  scope_type TEXT NOT NULL,
  scope_id UUID NOT NULL,
  metric TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_start TIMESTAMP WITH TIME ZONE NOT NULL,
  window_end TIMESTAMP WITH TIME ZONE NOT NULL,
  threshold_type TEXT NOT NULL,
  amount_limit INTEGER NOT NULL,
  amount_observed INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  approval_id UUID REFERENCES approvals(id),
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS budget_incidents_company_status_idx ON budget_incidents (company_id, status);

-- 16. plugins
CREATE TABLE IF NOT EXISTS plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_key TEXT NOT NULL,
  package_name TEXT NOT NULL,
  version TEXT NOT NULL,
  api_version INTEGER NOT NULL DEFAULT 1,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  manifest_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed',
  install_order INTEGER,
  package_path TEXT,
  last_error TEXT,
  installed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS plugins_plugin_key_idx ON plugins (plugin_key);
CREATE INDEX IF NOT EXISTS plugins_status_idx ON plugins (status);

-- 17. plugin_config
CREATE TABLE IF NOT EXISTS plugin_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_config_plugin_id_idx ON plugin_config (plugin_id);

-- 18. plugin_company_settings
CREATE TABLE IF NOT EXISTS plugin_company_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_company_settings_company_plugin_uq ON plugin_company_settings (company_id, plugin_id);

-- 19. plugin_entities
CREATE TABLE IF NOT EXISTS plugin_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  external_id TEXT,
  title TEXT,
  status TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS plugin_entities_plugin_idx ON plugin_entities (plugin_id);

-- 20. plugin_jobs
CREATE TABLE IF NOT EXISTS plugin_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  job_key TEXT NOT NULL,
  schedule TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_run_at TIMESTAMP WITH TIME ZONE,
  next_run_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_jobs_unique_idx ON plugin_jobs (plugin_id, job_key);

-- 21. plugin_job_runs
CREATE TABLE IF NOT EXISTS plugin_job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES plugin_jobs(id) ON DELETE CASCADE,
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  duration_ms INTEGER,
  error TEXT,
  logs JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMP WITH TIME ZONE,
  finished_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS plugin_job_runs_job_idx ON plugin_job_runs (job_id);

-- 22. plugin_logs
CREATE TABLE IF NOT EXISTS plugin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  meta JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS plugin_logs_plugin_time_idx ON plugin_logs (plugin_id, created_at);

-- 23. plugin_state
CREATE TABLE IF NOT EXISTS plugin_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  namespace TEXT NOT NULL DEFAULT 'default',
  state_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS plugin_state_plugin_scope_idx ON plugin_state (plugin_id, scope_kind);

-- 24. plugin_webhook_deliveries
CREATE TABLE IF NOT EXISTS plugin_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  webhook_key TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  duration_ms INTEGER,
  error TEXT,
  payload JSONB NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMP WITH TIME ZONE,
  finished_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS plugin_webhook_deliveries_plugin_idx ON plugin_webhook_deliveries (plugin_id);

-- 25. routines
CREATE TABLE IF NOT EXISTS routines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal_id UUID REFERENCES goals(id) ON DELETE SET NULL,
  parent_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  assignee_agent_id UUID NOT NULL REFERENCES agents(id),
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'active',
  concurrency_policy TEXT NOT NULL DEFAULT 'coalesce_if_active',
  catch_up_policy TEXT NOT NULL DEFAULT 'skip_missed',
  created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_by_user_id TEXT,
  updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  updated_by_user_id TEXT,
  last_triggered_at TIMESTAMP WITH TIME ZONE,
  last_enqueued_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS routines_company_status_idx ON routines (company_id, status);

-- 26. routine_triggers
CREATE TABLE IF NOT EXISTS routine_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  routine_id UUID NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cron_expression TEXT,
  timezone TEXT,
  next_run_at TIMESTAMP WITH TIME ZONE,
  last_fired_at TIMESTAMP WITH TIME ZONE,
  public_id TEXT,
  secret_id UUID REFERENCES company_secrets(id) ON DELETE SET NULL,
  signing_mode TEXT,
  replay_window_sec INTEGER,
  last_rotated_at TIMESTAMP WITH TIME ZONE,
  last_result TEXT,
  created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_by_user_id TEXT,
  updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  updated_by_user_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS routine_triggers_company_routine_idx ON routine_triggers (company_id, routine_id);
CREATE UNIQUE INDEX IF NOT EXISTS routine_triggers_public_id_uq ON routine_triggers (public_id);

-- 27. routine_runs
CREATE TABLE IF NOT EXISTS routine_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  routine_id UUID NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  trigger_id UUID REFERENCES routine_triggers(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  triggered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  idempotency_key TEXT,
  trigger_payload JSONB,
  linked_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  coalesced_into_run_id UUID,
  failure_reason TEXT,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS routine_runs_company_routine_idx ON routine_runs (company_id, routine_id, created_at);

-- 28. cli_auth_challenges
CREATE TABLE IF NOT EXISTS cli_auth_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_hash TEXT NOT NULL,
  command TEXT NOT NULL,
  client_name TEXT,
  requested_access TEXT NOT NULL DEFAULT 'board',
  requested_company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  pending_key_hash TEXT NOT NULL,
  pending_key_name TEXT NOT NULL,
  approved_by_user_id TEXT,
  board_api_key_id UUID REFERENCES board_api_keys(id) ON DELETE SET NULL,
  approved_at TIMESTAMP WITH TIME ZONE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cli_auth_challenges_secret_hash_idx ON cli_auth_challenges (secret_hash);
