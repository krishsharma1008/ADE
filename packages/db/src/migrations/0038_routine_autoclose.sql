-- Round 3 Phase 1 — routine auto-close
-- Optional per-routine threshold after which routine-origin issues auto-close.
-- NULL means "never auto-close" (default/backward compat).
-- See docs/plans/round3/08-routine-origin-filter.md.

ALTER TABLE "routines"
    ADD COLUMN IF NOT EXISTS "auto_close_after_ms" bigint;
