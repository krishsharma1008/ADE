-- Migration: Per-agent interactive terminal sessions
CREATE TABLE IF NOT EXISTS agent_terminal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE,
  log_ref TEXT,
  opened_by TEXT
);

CREATE INDEX IF NOT EXISTS agent_terminal_sessions_agent_idx
  ON agent_terminal_sessions (agent_id, started_at);
