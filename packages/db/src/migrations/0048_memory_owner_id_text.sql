-- PR-1 — memory_entries.owner_id: uuid -> text.
--
-- Personal-layer memory entries are owned by a principal whose id is not
-- always a uuid (e.g. the local board principal 'local-board', service-account
-- handles, etc.). Widen owner_id to text so non-uuid owners can be stored and
-- owner-fenced exactly. The owner index is dropped and recreated because an
-- ALTER COLUMN ... TYPE on an indexed column would otherwise be rejected /
-- left on the old type.
DROP INDEX IF EXISTS "memory_entries_owner_idx";--> statement-breakpoint
ALTER TABLE "memory_entries" ALTER COLUMN "owner_id" TYPE text USING "owner_id"::text;--> statement-breakpoint
CREATE INDEX "memory_entries_owner_idx" ON "memory_entries" ("company_id","owner_type","owner_id");
