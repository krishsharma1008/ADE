# Item #7 — Stuck Execution Locks (BUK-16)

Phase 8 of Round 3.

## Diagnosis

Lock lifecycle today:
- Write: `server/src/services/heartbeat.ts` sets `issues.executionRunId` + `executionLockedAt` at run start.
- Read: `wakeup()` at `heartbeat.ts:2086-2108` looks up the referenced run and clears the lock if terminal/missing — but ONLY on new wakeup arrival.
- Run-side reaper: `reapOrphanedRuns()` at `heartbeat.ts:969-1019` scans `heartbeatRuns` with status `queued|running`, `!runningProcesses.has(run.id)`, and `staleThresholdMs` elapsed. Marks the run failed + calls `releaseIssueExecutionAndPromote()`.
- Scheduler: `server/src/index.ts:677-695` — every `heartbeatSchedulerIntervalMs`, threshold 5 min.

### Failure modes leaving an issue stuck indefinitely

1. **Run lingers in `running` with fresh `updatedAt`.** Hung child that still emits events → 5-min stale never triggers. Reaper ignores.
2. **Run finished terminal but `releaseIssueExecutionAndPromote` threw.** Issue still points at the terminal run; nothing re-checks the issue until a new wakeup arrives.
3. **Server restart mid-run** (caught by startup reap at `index.ts:673`).
4. **Agent deleted while run active** — `startNextQueuedRunForAgent` no-ops; issue lock stays.

Most likely for BUK-16: mode 1 or 2.

### Diagnostic runbook query

```sql
SELECT i.id, i.key, i.execution_run_id, i.execution_locked_at,
       r.status AS run_status, r.updated_at AS run_updated_at,
       r.started_at, r.finished_at, r.error
FROM issues i
LEFT JOIN heartbeat_runs r ON r.id = i.execution_run_id
WHERE i.key = 'BUK-16';
```

- `run_status = 'running'` with fresh `updated_at` → mode 1.
- `run_status IN ('succeeded','failed','cancelled')` → mode 2 (true bug — issue-side reaper missing).
- `run_status IS NULL` → mode 2 variant.

## Fix (ship in one server-only PR)

### 7a. Issue-side reaper

New `reapOrphanedIssueLocks()` in `heartbeat.ts`, runs alongside `reapOrphanedRuns` each scheduler tick:

```sql
SELECT i.id, i.execution_run_id
FROM issues i
LEFT JOIN heartbeat_runs r ON r.id = i.execution_run_id
WHERE i.execution_run_id IS NOT NULL
  AND (r.id IS NULL OR r.status NOT IN ('queued','running'));
```

For each hit: clear `execution_run_id`, `executionAgentNameKey`, `executionLockedAt`; log `issue.lock_reaped { issueId, runStatus }`.

**Codex P0 respected:** only clears when referenced run is terminal/absent — never on lock age alone.

### 7b. Wall-clock run cap

`runHardCapMs` config (default 60 min). In `reapOrphanedRuns`, also reap runs with `now - run.startedAt > runHardCapMs`, regardless of `updatedAt`. Log `run.hard_cap_exceeded`. Catches mode 1.

### 7c. Manual force-unlock

- Route: `POST /issues/:id/force-unlock` (role: admin/CEO). Clears issue lock + writes activity `issue.force_unlocked { previousRunId, previousRunStatus }`.
- UI: "Unblock" button on `IssueDetail.tsx` shown only when `issue.executionRunId` is non-null AND referenced run is terminal OR lock is >15 min old. Confirmation modal.

## Files

- Modify: `server/src/services/heartbeat.ts`, `server/src/index.ts:677-695`, `server/src/routes/issues.ts`, `ui/src/pages/IssueDetail.tsx`, `ui/src/api/issues.ts`.

## Tests

- Unit: reaper leaves live runs alone; clears on terminal/absent.
- Unit: hard-cap reaps `running` with `startedAt > now - 61min`.
- Race: hold fake `running` row during reap → no change; flip to `failed` → next tick clears.
- Manual: run diagnostic query on Anurag's instance; force-unlock BUK-16; confirm new wake processes.

## Before shipping

Run the diagnostic query on Anurag's DB. Confirm which mode. Fix is safe for all modes; knowing which informs release notes.
