-- 0056 — Backfill embedding_version for legacy null-version embeddings (M1).
--
-- Before embedding versioning landed, the hash embedder wrote a real `embedding`
-- but left `embedding_version` NULL. The cosineSimilarity version guard now treats
-- a NULL entry version as the hash space ('hash-64:64') so a null-version vector
-- can never silently cross-score a real-model query. This migration makes the
-- stored data match that semantic: any row with an embedding but no version is the
-- hash space, so stamp it 'hash-64:64'. Idempotent (only touches NULL rows).
UPDATE "memory_entries"
  SET "embedding_version" = 'hash-64:64'
  WHERE "embedding" IS NOT NULL AND "embedding_version" IS NULL;
