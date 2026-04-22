-- Round 3 Phase 1 — context-budget telemetry + summarizer storage
-- See docs/plans/round3/06-context-budget.md for the architecture.

ALTER TABLE "heartbeat_runs"
    ADD COLUMN IF NOT EXISTS "prompt_budget_json" jsonb;

CREATE TABLE IF NOT EXISTS "transcript_summaries" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "agent_id" uuid NOT NULL,
    "scope_kind" text NOT NULL,
    "scope_id" uuid,
    "cutoff_seq" bigint NOT NULL,
    "content" text NOT NULL,
    "structured_json" jsonb,
    "source_input_tokens" integer,
    "source_turn_count" integer,
    "summarizer_model" text NOT NULL,
    "input_tokens" integer,
    "output_tokens" integer,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
    ALTER TABLE "transcript_summaries"
        ADD CONSTRAINT "transcript_summaries_company_id_fk"
        FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "transcript_summaries"
        ADD CONSTRAINT "transcript_summaries_agent_id_fk"
        FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Durable cutoff watermark. Uniqueness prevents duplicate summaries under
-- concurrent triggers (Codex P0).
CREATE UNIQUE INDEX IF NOT EXISTS "transcript_summaries_cutoff_uq"
    ON "transcript_summaries"("agent_id", "scope_kind", COALESCE("scope_id", '00000000-0000-0000-0000-000000000000'::uuid), "cutoff_seq");

CREATE INDEX IF NOT EXISTS "transcript_summaries_lookup_idx"
    ON "transcript_summaries"("agent_id", "scope_kind", "scope_id", "cutoff_seq" DESC);

CREATE TABLE IF NOT EXISTS "tokenizer_calibration" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "model_family" text NOT NULL,
    "ratio" numeric(10,4) NOT NULL,
    "observed_at" timestamptz NOT NULL DEFAULT now(),
    "run_id" uuid,
    "estimated_tokens" integer,
    "actual_tokens" integer
);

CREATE INDEX IF NOT EXISTS "tokenizer_calibration_family_observed_idx"
    ON "tokenizer_calibration"("model_family", "observed_at" DESC);
