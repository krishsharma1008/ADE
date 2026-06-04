-- PR-2 — Canonical trust spine for memory_entries (+ a governable subset on
-- agent_memory). Adds provenance / verification_state / confidence / author_*
-- / source_ref_* / subject_key / superseded_by / verified_* / embedding_version,
-- the trust + subject-key indexes, and the idempotent-capture unique partial
-- index on (company_id, source). Then backfills the trust columns from the
-- existing source/layer signal (§3.5).
--
-- Under the locked "strict" trust model only human-sourced content is
-- authoritative; agent claims are stored but forced unverified. Existing rows
-- are classified conservatively: ex-shared + promotion lineage become verified;
-- everything agent-authored (incl. accepted_work) stays unverified/agent-claim
-- so no agent text is laundered into a trusted tier by the backfill.
ALTER TABLE "memory_entries" ADD COLUMN "provenance" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "verification_state" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "confidence" real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "author_type" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "author_id" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "source_ref_type" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "source_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "superseded_by_id" uuid REFERENCES "memory_entries"("id");--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "embedding_version" text;--> statement-breakpoint
CREATE INDEX "memory_entries_trust_idx" ON "memory_entries" ("company_id","layer","verification_state","confidence");--> statement-breakpoint
CREATE INDEX "memory_entries_subjectkey_idx" ON "memory_entries" ("company_id","subject_key");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_entries_company_source_uniq" ON "memory_entries" ("company_id","source") WHERE "source" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "provenance" text;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "author_type" text;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "confidence" real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "verification_state" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
UPDATE "memory_entries" SET "provenance" = 'verified-summary', "verification_state" = 'verified', "confidence" = 0.9 WHERE "source" LIKE 'promotion:%';--> statement-breakpoint
UPDATE "memory_entries" SET "verification_state" = 'verified' WHERE "layer" = 'shared';--> statement-breakpoint
UPDATE "memory_entries" SET "provenance" = 'agent-claim', "author_type" = 'agent', "verification_state" = 'unverified' WHERE "source" LIKE 'accepted_work:%';--> statement-breakpoint
-- Catch-all: everything still at the default unverified state with no provenance
-- becomes an agent-claim. Guarded on verification_state='unverified' so it never
-- demotes a row the shared/promotion rules above already marked verified (a
-- non-promotion shared row keeps provenance NULL but stays verified).
UPDATE "memory_entries" SET "provenance" = 'agent-claim', "verification_state" = 'unverified' WHERE "provenance" IS NULL AND "verification_state" = 'unverified';
