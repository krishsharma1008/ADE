-- 0057 — Global-source uniqueness for instance-wide global memory (M3).
--
-- Global rows (layer='global') carry company_id = NULL, so the 0049
-- (company_id, source) partial unique index never collides for them — NULLs are
-- distinct in SQL, so promoting the SAME source twice produced TWO global rows.
-- This partial unique index keys global rows on `source` alone (the
-- company-agnostic natural key, e.g. 'global-promotion:<sourceId>'), making
-- promotion idempotent. Scoped to company_id IS NULL AND source IS NOT NULL so it
-- only governs the global layer and never an un-sourced row.
CREATE UNIQUE INDEX "memory_entries_global_source_uniq"
  ON "memory_entries" ("source")
  WHERE "company_id" IS NULL AND "source" IS NOT NULL;
