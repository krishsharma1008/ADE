# Adaptive Turn-Budget — Design & Implementation

## 1. Problem

The per-run turn cap is a single fixed ceiling: `withSmallCodingTaskControls` clamps every run's
`--max-turns` to `min(agentConfig, COMBYNE_SMALL_TASK_MAX_TURNS=50)`. That cap is the task's *only*
budget, so when a large-but-simple task needs more than 50 turns it does not get split, paused, or
continued — it **hard-fails**. The cap was sized for cost control on small tasks, but it doubles as
the task-level limit, which is the wrong lever for a task that is genuinely progressing.

A second, compounding fault is a **mis-report**. A max-turns exit had no first-class error code.
Claude can emit partial output on the way to hitting `--max-turns`, and that partial output can trip
the auth-detection regex, so the run inherited `claude_auth_required`.

**Live evidence:** `LendingTwoFAController` was a large-but-simple controller task. The run hit the
50-turn cap mid-implementation, was blocked, and was surfaced to the EM as
`claude_auth_required` — a false "the agent needs to log in" signal for what was really
"the agent ran out of turns while making real progress." Two failures in one: it should not have
blocked (it was progressing), and it should not have claimed an auth problem.

## 2. Root cause

- **Mis-flag (error code).** `packages/adapters/claude-local/src/server/execute.ts` — the original
  errorCode expression was `authErrorCode ?? (loginMeta.requiresLogin ? "claude_auth_required" : null)`
  (the line now occupied by the `resolveAdapterErrorCode(...)` call at **execute.ts:719**). A max-turns
  exit had no branch of its own, so when partial output set `loginMeta.requiresLogin`, it fell through
  to `claude_auth_required`.
- **Hard block.** `server/src/services/heartbeat.ts` — a `claude_max_turns`/failed run had no
  continuation path and went straight to the outcome classifier → `markIssueBlockedAfterFailedRun`
  (`heartbeat.ts:517`, invoked from the failed-outcome block around `heartbeat.ts:6527`). The per-run
  cap (`withSmallCodingTaskControls`) being the only budget meant exhaustion == terminal block.
- **Session destruction.** `execute.ts` also OR-ed `clearSessionForMaxTurns` into `clearSession`
  (the line now at **execute.ts:752**), nulling the warm session on a max-turns exit — which would
  make any resume replay the pre-run session and lose progress.

## 3. Chosen solution + why

**Chosen:** a minimal *max-turns continuation engine* that mirrors the already-proven usage-pause
engine almost 1:1, plus a one-line adapter error-code fix. On a `claude_max_turns` outcome, if the
run made real (git-measured) progress **and** the task is under a per-issue round/turn budget,
re-enqueue a warm continuation run on the same issue instead of blocking it. Otherwise fall through
to the **existing** `markIssueBlockedAfterFailedRun` escalation, unchanged. The new engine is gated
behind `COMBYNE_MAX_TURNS_CONTINUATION_ENABLED` (**default OFF**) and is driven by `enqueueWakeup`
(no new poller).

**Why this one:**

- The usage-pause engine already solved the hard parts: park a non-terminal run, preserve the warm
  session keyed by `taskKey=issueId`, re-dispatch through the existing queued pipeline, keep the issue
  lock, bound retries, and escalate cleanly when exhausted. Copying that discipline (errorCode-as-channel,
  upsert-guarded budget table, exhaustion → `markIssueBlockedAfterFailedRun`, feature flag) gives a
  generalized solution with near-zero novel risk.
- The git-delta progress gate is deterministic, LLM-free, and **degrades to NOT-continue** when
  ambiguous — so genuinely stuck tasks still terminate.
- A cheap complexity heuristic scales only the *round* budget within a hard ceiling, so worst-case
  cost can never exceed the cap × ceiling.

**Rejected alternatives:**

- **Raise/remove the per-run cap.** Rejected — the cap is intentional per-round cost control; removing
  it gives every run unbounded turns, the opposite of bounded continuation.
- **Time-based resume poller** (mirroring `resumeUsagePausedRuns`). Rejected as over-built — max-turns
  has no provider reset time to wait for; it should continue *immediately*. `enqueueWakeup` off the
  completion block reuses the existing queued → `startNextQueuedRunForAgent` pipeline.
- **Reuse the `usage_pause_windows` table.** Rejected — conflates two distinct lifecycles (a paused run
  vs. a finalized run that spawns a fresh continuation run) and would corrupt the usage-pause poller's
  selection. A separate per-issue table isolates risk.
- **LLM-based progress judgment** ("did you make progress?"). Rejected — violates cheap+deterministic,
  adds cost/latency, and is gameable by a looping agent.
- **Just fix the error code, keep blocking.** Rejected — solves the mis-flag but not the core problem;
  a progressing large-but-simple task still hard-fails at 50.
- **Per-run round counter on `heartbeat_runs`.** Rejected — a continuation spawns a *new* run, so a
  per-run counter resets each round and can't bound the *task*. The budget must live on a durable
  per-issue row.
- **Auto-scale the per-round `--max-turns` by complexity.** Rejected as higher-risk — it raises
  single-round worst-case cost. Scaling the round *count* within a hard ceiling keeps each round
  capped while granting more total budget.

## 4. Mechanism

### Progress-vs-stuck gate
Cheap, deterministic, LLM-free. Per round, in the resolved run cwd via the existing `git-state.ts`
helpers (`git status --porcelain=v1 --untracked-files=all`, `git rev-parse HEAD`):

```
filesChanged = dirtyFileCount + untrackedFileCount
headAdvanced = currentHeadSha != window.headShaAtLastRound
progressed   = filesChanged > 0 || headAdvanced
```

The window stores `headShaAtLastRound`, so successive rounds compare against the *prior round's* sha
(a true cross-round signal, not just same-round dirtiness). **Ambiguity default:** cwd unresolved, not
a git repo, or git throws → `progressed=false` → block. This guarantees a stuck/looping task always
terminates while a large-but-simple task that actually wrote files continues.

### Round / total budget
Two layered budgets, stored on a `max_turns_continuation_windows` row keyed UNIQUE to the issue:

- **Per-round (unchanged):** `withSmallCodingTaskControls` still caps each run's `--max-turns` at
  `min(agentConfig, COMBYNE_SMALL_TASK_MAX_TURNS=50)`. This stays the per-round cost control.
- **Per-task (new):** `roundCount` (capped by `maxRounds`, default `3`) and `cumulativeTurns`
  (sum of `num_turns` across rounds, capped by `maxTotalTurns`, default `200` — the **hard ceiling**
  that bounds total cost even if every round shows tiny progress).

Continuation fires only when **`progressed && roundCount < maxRounds && cumulativeTurns < maxTotalTurns`**.

### Continuation path
On CONTINUE: persist the POST session into the task session (so the warm Claude conversation survives,
`taskKey=issueId`), bump `roundCount` / `cumulativeTurns` / `headShaAtLastRound` on the window, finalize
this run normally, release the issue lock, then `enqueueWakeup(reason "max_turns_continuation",
idempotencyKey "max_turns_continuation:<issueId>:<roundCount>")`. The `executeRun` finally block
(`heartbeat.ts:6562`) calls `startNextQueuedRunForAgent(agent.id)`, which picks up the freshly-queued
continuation wake; the new run **re-acquires** the lock through the normal queued pipeline (not coalesced,
not double-held) and resumes the warm session with a fresh per-round `--max-turns` cap.

### Hard ceiling
`cumulativeTurns >= maxTotalTurns` (default 200) blocks even when a round shows 1-file progress, so a
tiny-progress loop can never run unbounded. The round budget can be scaled *up* by the complexity
heuristic but **never above `HARD_MAX_ROUNDS` (5)**.

### Error-code fix
`packages/adapters/claude-local/src/server/execute.ts`:
- **execute.ts:719** — errorCode is now computed by the pure, exported
  `resolveAdapterErrorCode({ authErrorCode, isMaxTurns: clearSessionForMaxTurns, requiresLogin })`.
  Precedence: genuine MCP 401 (`authErrorCode`) > `claude_max_turns` > `claude_auth_required` > null.
  `isMaxTurns` reuses the already-computed `clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed)`
  (**execute.ts:663**).
- **execute.ts:752** — `clearSession` dropped the `clearSessionForMaxTurns ||` term; it is now
  `Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId)`, so a max-turns exit with a
  resolvable session **preserves** it for resume. The missing-session fallback is untouched.
- `packages/shared/src/agent-error-codes.ts` — a `claude_max_turns` entry (severity `retry`) so the UI
  renders a real card instead of the unknown fallback; it auto-flows into `KNOWN_AGENT_ERROR_CODES` and
  `resolveAgentErrorCode`.

The new error code flows untouched through `setRunStatus`; the continuation guard
(`heartbeat.ts:5816`) branches on `adapterResult.errorCode === "claude_max_turns"`.

## 5. Files changed + tests added

**Source / schema**

| File | Change |
|---|---|
| `packages/adapters/claude-local/src/server/execute.ts` | execute.ts:719 — `resolveAdapterErrorCode(...)` call (own `claude_max_turns` code, correct precedence). execute.ts:752 — drop `clearSessionForMaxTurns \|\|` so a resolvable session is preserved for resume. |
| `packages/adapters/claude-local/src/server/parse.ts` | New exported pure `resolveAdapterErrorCode(...)` encapsulating the precedence (unit-testable without a child process). |
| `packages/shared/src/agent-error-codes.ts` | New `claude_max_turns` taxonomy entry (severity `retry`). |
| `packages/db/src/schema/max_turns_continuation_windows.ts` (NEW) | Per-task budget table mirroring `usage_pause_windows`, UNIQUE on `issueId`: `roundCount`/`maxRounds`, `cumulativeTurns`/`maxTotalTurns`, `headShaAtLastRound`, `sessionIdToResume`, `sessionCwd`, `runId`. |
| `packages/db/src/schema/index.ts` | Export `maxTurnsContinuationWindows`. |
| `packages/db/src/migrations/0061_max_turns_continuation_windows.sql` (NEW) + `meta/_journal.json` | Idempotent `CREATE TABLE IF NOT EXISTS` + indexes + `UNIQUE(issue_id)`, journaled as idx 61 so `migratePostgresIfEmpty` applies it in prod and the embedded test DB. |
| `server/src/services/heartbeat.ts` | `maxTurnsContinuationEnabled()` (heartbeat.ts:395); constants + pure `maxTurnsRoundBudget(issueText)` (heartbeat.ts:427, clamps to `[3,5]`); `computeMaxTurnsProgress(cwd, prevHeadSha)`; `handleMaxTurnsContinuation(...)` (heartbeat.ts:3764) with idempotency early-return, progress+budget gate, window upsert, POST-session persist, `enqueueWakeup`, `appendRunEvent`+log; `cleanupMaxTurnsContinuationWindowForIssue`; the guard above the outcome classifier (heartbeat.ts:5816) that sets the continuation-planned flag and skips `markIssueBlockedAfterFailedRun` (heartbeat.ts:6527) when planned. Per-run cap and acceptedWork scoping left intact. |

**Tests added**

- `packages/adapters/claude-local/src/server/parse.test.ts` — 5 cases: max-turns → `claude_max_turns`;
  max-turns text that *also* trips the auth regex still → `claude_max_turns` (not `claude_auth_required`);
  genuine MCP 401 keeps top precedence; login-required → `claude_auth_required`; ordinary failure → null.
- `packages/shared/src/agent-error-codes.test.ts` — `claude_max_turns` resolves to a real retry-severity
  card (not the unknown fallback) and is in the live-codes inventory guardrail.
- `server/src/services/__tests__/max-turns-continuation.test.ts` (NEW, 11 tests) — progress + under
  budget → CONTINUE (window bumps, POST session persisted, issue NOT blocked); no progress → DECLINE →
  `markIssueBlockedAfterFailedRun` still blocks + posts the "Agent run failed" comment; round budget
  exhausted → DECLINE; cumulative-turn hard ceiling → DECLINE even with progress; no-issue-scope →
  DECLINE; idempotency (duplicate completion does not double-bump); flag-gate parity; `maxTurnsRoundBudget`
  clamp; `computeMaxTurnsProgress` dirty/clean/non-repo.

## 6. Verification gate results — GREEN

- **`pnpm -r typecheck`** — all packages clean (server + `@combyne/adapter-claude-local` via
  `tsc --noEmit`, exit 0, no errors).
- **Server services suite** — 71 files / 518 tests pass, including the changed-area regression suites
  (usage-pause ×3, small-task-budget, integration-auth-failure — 49 tests). The embedded test DBs apply
  migration 0061 successfully (the new test inserts into the table).
- **Heartbeat + continuation suites** — 12 files / 106 tests pass, including
  `max-turns-continuation.test.ts` (11). (`ERROR`/`WARN`/`failed: 1` strings in stdout are intentional
  failure-path fixture logs, not vitest failures.)
- **`@combyne/adapter-claude-local`** — 38 tests pass (incl. the 5 new `parse.test.ts` precedence cases).
- **`@combyne/shared`** — 22 tests pass (incl. the `claude_max_turns` taxonomy test).

**Caveats:** there is no `execute`-level test suite in claude-local (`execute.ts` has no `.test.ts`); the
precedence logic is covered via the extracted pure `resolveAdapterErrorCode` in `parse.test.ts`. Work was
done on branch `central-db` (not `main`); no commit was made.

## 7. Behavior by scenario

| Scenario | What happens |
|---|---|
| **Simple-but-large task (continues)** | Run hits the 50-turn cap → `claude_max_turns`. Git delta shows new/changed files (`progressed=true`) and the task is under `maxRounds` and `maxTotalTurns`. The POST session is persisted into the task session, the window bumps, the finishing run releases the issue lock, and a warm continuation wake is enqueued. The next round resumes the same conversation with a fresh per-round cap. The issue is **NOT** blocked. This is the `LendingTwoFAController` fix. |
| **Genuinely stuck task (blocks)** | Run hits the cap → `claude_max_turns`, but git shows zero new dirty files and no HEAD advance vs. the prior round's sha (`progressed=false`) — or the cwd is unresolved / not a repo / git throws (degrades to `progressed=false`). Continuation DECLINES, the window is deleted, control falls through to the **unchanged** classifier → outcome `failed` → `markIssueBlockedAfterFailedRun` (existing "Agent run failed" comment + parent notification). |
| **Budget exhaustion (escalates)** | `roundCount >= maxRounds` **or** `cumulativeTurns >= maxTotalTurns` (the hard ceiling — blocks even with fresh progress). Continuation DECLINES, the window is cleaned up, and the same unchanged `markIssueBlockedAfterFailedRun` escalation runs, surfacing to the EM. |

## 8. Config knobs + safe defaults

| Env var | Default | Effect |
|---|---|---|
| `COMBYNE_MAX_TURNS_CONTINUATION_ENABLED` | **OFF (false)** | Master gate. OFF ⇒ behavior is byte-identical to today (max-turns blocks at the cap). The error-code fix ships regardless as a pure correctness improvement. |
| `COMBYNE_MAX_TURNS_MAX_ROUNDS` | `3` | Default per-task round budget (`maxRounds`), scalable up to `HARD_MAX_ROUNDS` by the complexity heuristic. |
| `COMBYNE_MAX_TURNS_MAX_TOTAL` | `200` | Hard cumulative-turn ceiling (`maxTotalTurns`) — the absolute backstop against tiny-progress loops. |
| `HARD_MAX_ROUNDS` (constant) | `5` | Upper clamp for `maxTurnsRoundBudget`; the complexity heuristic can never exceed it. |
| `COMBYNE_SMALL_TASK_MAX_TURNS` (existing) | `50` | Per-round `--max-turns` cap via `withSmallCodingTaskControls` — unchanged, the per-round cost control. |

**Flag-off parity** is the safe default: with `COMBYNE_MAX_TURNS_CONTINUATION_ENABLED` unset, the system
blocks at 50 exactly as before, and the only live change is the correct `claude_max_turns` error code
(no longer a false `claude_auth_required`). Worst-case cost with the flag ON is bounded by
`min(maxRounds, HARD_MAX_ROUNDS)` rounds × the per-round cap, hard-capped by `maxTotalTurns`.
