-- 0062 — Finding #24 (e2e-run-2026-06-10 round 2): 0053 decoupled the memory
-- tables' outbound FKs for the separate context DB but missed the REVERSE edge:
-- accepted_work_events (main DB) references memory_entries(id), and the captured
-- entry can now live on the central context DB. Stamping memory_entry_id after a
-- central-rail capture violated the FK and failed the accepted-work close-out.
-- Drop the constraint; the column keeps its value as a logical reference into
-- whichever DB holds the entry (same convention as the 0053 decoupled columns).
ALTER TABLE "accepted_work_events" DROP CONSTRAINT IF EXISTS "accepted_work_events_memory_entry_id_memory_entries_id_fk";
