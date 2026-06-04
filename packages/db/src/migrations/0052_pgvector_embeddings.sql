-- PR-11 — Embedding columns for the managed-API embedding swap
-- (MEMORY_UI_AND_QUALITY_PLAN §1.6, CENTRAL_CONTEXT_DB_PLAN §9 decision 1).
--
-- Adds the plain bookkeeping columns the embedder writes on every storage
-- path — embedding_model, embedding_dim, content_hash — alongside the existing
-- jsonb `embedding` (the hash-64 fallback + permanent test oracle) and
-- `embedding_version` (already landed in 0049). DOES NOT build an HNSW index:
-- the vector column ships nullable, the re-embed backfill fills it, and the
-- CREATE INDEX CONCURRENTLY … USING hnsw is a later, separate step once dim is
-- validated against real-corpus recall.
--
-- pgvector availability is NOT assumed. The embedded-postgres dev/test rig does
-- NOT ship the `vector` extension, and a bare `CREATE EXTENSION vector` would
-- THROW inside the migration transaction and break the entire suite. The
-- extension + the `embedding_vec vector(1536)` column are therefore created
-- ONLY when pg_available_extensions reports `vector`; otherwise the migration
-- raises a NOTICE and proceeds with the jsonb oracle alone. All code tolerates
-- embedding_vec being absent (vectorSearchEnabled stays false on such a rig).
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "embedding_model" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "embedding_dim" integer;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
    EXECUTE 'ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "embedding_vec" vector(1536)';
    RAISE NOTICE 'pgvector available: embedding_vec vector(1536) column added (HNSW index built later, not here)';
  ELSE
    RAISE NOTICE 'pgvector NOT available: skipping CREATE EXTENSION vector and embedding_vec column; jsonb embedding remains the fallback + oracle';
  END IF;
END
$$;
