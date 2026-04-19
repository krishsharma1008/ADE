ALTER TABLE "agent_transcripts"
  ADD COLUMN IF NOT EXISTS "terminal_session_id" uuid REFERENCES "agent_terminal_sessions"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "agent_transcripts_terminal_session_seq_idx"
  ON "agent_transcripts" ("terminal_session_id", "seq");
