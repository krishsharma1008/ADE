-- Round 3 Phase 6 PR 6.1 — durable transcript cursor + summarizer quarantine.
--
-- Codex surfaced that `agent_transcripts.seq` resets per run and per terminal
-- session, so it cannot be used as a monotonic per-agent watermark for
-- summarization. This migration adds a global `ordinal` column backed by a
-- sequence, backfilled in `(created_at, id)` order. The existing `seq` column
-- stays for per-run/per-session display ordering.
--
-- Also adds `summarizer_failures`: a small table that quarantines a
-- (agent, scope, scopeId) key after 3 consecutive summarizer failures so
-- retries stop costing tokens forever.

-- 1. Global ordinal on agent_transcripts --------------------------------------

ALTER TABLE "agent_transcripts"
    ADD COLUMN IF NOT EXISTS "ordinal" bigint;

CREATE SEQUENCE IF NOT EXISTS agent_transcripts_ordinal_seq
    AS bigint
    OWNED BY agent_transcripts.ordinal;

-- Backfill existing rows. Deterministic order: (created_at, id). Runs inside
-- a CTE so we can assign one ordinal per row even with duplicate timestamps.
DO $$
DECLARE
    backfill_count bigint;
BEGIN
    SELECT COUNT(*) INTO backfill_count FROM agent_transcripts WHERE ordinal IS NULL;
    IF backfill_count > 0 THEN
        WITH ordered AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
              FROM agent_transcripts
        )
        UPDATE agent_transcripts t
           SET ordinal = ordered.rn
          FROM ordered
         WHERE t.id = ordered.id;
    END IF;
END $$;

-- Advance sequence past the backfilled max so future inserts never collide.
SELECT setval(
    'agent_transcripts_ordinal_seq',
    GREATEST(COALESCE((SELECT MAX(ordinal) FROM agent_transcripts), 0), 1),
    true
);

ALTER TABLE "agent_transcripts"
    ALTER COLUMN "ordinal" SET DEFAULT nextval('agent_transcripts_ordinal_seq');

ALTER TABLE "agent_transcripts"
    ALTER COLUMN "ordinal" SET NOT NULL;

-- Lookup indexes: the summarizer reads "all entries for agent X since
-- ordinal N" and "all entries for (agent X, issue Y) since ordinal N".
CREATE INDEX IF NOT EXISTS "agent_transcripts_agent_ordinal_idx"
    ON "agent_transcripts" ("agent_id", "ordinal");

CREATE INDEX IF NOT EXISTS "agent_transcripts_issue_ordinal_idx"
    ON "agent_transcripts" ("issue_id", "ordinal")
    WHERE "issue_id" IS NOT NULL;

-- 2. Summarizer failure quarantine --------------------------------------------

CREATE TABLE IF NOT EXISTS "summarizer_failures" (
    "agent_id" uuid NOT NULL,
    "scope_kind" text NOT NULL,
    "scope_id" uuid,
    "consecutive_failures" integer NOT NULL DEFAULT 0,
    "last_error" text,
    "quarantined_until" timestamptz,
    "updated_at" timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
    ALTER TABLE "summarizer_failures"
        ADD CONSTRAINT "summarizer_failures_agent_id_fk"
        FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- PG treats NULL as distinct by default, so the primary-key-like unique uses
-- COALESCE to collapse NULL scope_id into a fixed zero-uuid.
CREATE UNIQUE INDEX IF NOT EXISTS "summarizer_failures_pk_idx"
    ON "summarizer_failures"(
        "agent_id",
        "scope_kind",
        COALESCE("scope_id", '00000000-0000-0000-0000-000000000000'::uuid)
    );

CREATE INDEX IF NOT EXISTS "summarizer_failures_quarantined_idx"
    ON "summarizer_failures" ("quarantined_until")
    WHERE "quarantined_until" IS NOT NULL;
