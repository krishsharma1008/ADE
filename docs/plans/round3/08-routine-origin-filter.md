# Item #8 — Routine Issue Origin Filter

Phase 12 of Round 3.

## Problem

`routines.ts:587` creates issues with `originKind: "routine_execution"`. Column exists + is already used in `IssueDetail.tsx` for conditional rendering. But `IssuesList.tsx` doesn't filter on `originKind`, so routine-generated issues pile up in the CEO's inbox.

## Fix

1. **Inbox default:** `IssuesList.tsx` default filter excludes `originKind = 'routine_execution'` via a toggleable `Include routine runs` pill (off by default). Persist preference in localStorage + per-user company setting.

2. **Dedicated view:** `/routines/runs` renders only routine-origin issues grouped by routine. Each routine card shows the last N executions, status chips, link to IssueDetail.

3. **Optional auto-close** (opt-in per routine): new `routines.auto_close_after_ms` column (Phase 1 migration 0038). When set, a daily cron closes routine-origin issues older than the threshold. Default off.

## Files

- Modify: `ui/src/pages/IssuesList.tsx`, `ui/src/App.tsx`, `server/src/routes/issues.ts`, `packages/db/src/schema/routines.ts`, `server/src/services/routines.ts`.
- New: `ui/src/pages/RoutineRuns.tsx`, `packages/db/src/migrations/0038_routine_autoclose.sql`.

## Tests

- Unit: `GET /issues?originKind=routine_execution` returns only those rows.
- UI: toggle pill → inbox switches.
- Auto-close: threshold 60s → routine issue auto-closes in next tick.
