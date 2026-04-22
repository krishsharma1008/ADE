# Context Management Deep Plan — Phase 6 (dual-scope summarizer) + Phase 7 (TBD post-soak)

This plan covers everything still missing to make agent context management work end-to-end for autonomous ticket completion. It supersedes the sketch in `06-context-budget.md` for Phases 6 and 7.

**Version 2** — 2026-04-23. Revised after round of Q&A; key changes from v1:
- Per-issue AND per-agent summaries (dual scope), not agent-only.
- Summarization **off by default**; opt-in via per-agent UI toggle + budget control.
- Adapter coverage limited to claude-local + codex-local this phase (plan Round 4 for the rest).
- Calibration ratio snapshotted per-run to preserve cache stability.
- Fixtures scraped from real pilot transcripts (no redaction).
- UI ships with Phase 6 (context-budget card + summarization toggle).
- Phase 7 deferred: design after Phase 6 soaks on real tickets (BUK-23, BUK-16, BUK-13).

**Version 2.1** — 2026-04-23. Revised after Codex adversarial critique; delta from v2 is captured in §0 below — the rest of the document stands but is read through the lens of §0. Any future change must reconcile against §0 first.

## 0. Codex critique (2026-04-23) — design deltas that supersede v2

Codex raised 9 concrete issues against v2. Their full report lives in the conversation log for this PR. Summary of the design changes:

### 0.1 BLOCKER — `seq` is not a durable per-agent cursor
`agent_transcripts.seq` resets to 1 per run (`heartbeat.ts:1472`) and per terminal session (`terminal-sessions.ts:1004-1065`). `cutoff_seq` therefore cannot work as a monotonic watermark across runs. **Fix:** migration 0039 adds a BIGSERIAL `ordinal` column to `agent_transcripts`, backfilled in `(company_id, created_at, id)` order. All summarization-cursor logic in this phase switches from `seq` to `ordinal`. `seq` is retained for per-run/per-session display ordering. `transcript_summaries.cutoff_seq` (column name kept for drizzle compatibility) now stores the `ordinal` of the last-summarized transcript row.

### 0.2 HIGH — `SummarizerQueue` is not multi-replica safe
The in-process Map of `inFlight` + `lastRunAt` protects a single process only. **Fix:** add a PG advisory-lock tier above the in-process map:
  - Key: `hashtext(format('summarizer/%s/%s/%s', agentId, scope, scopeIdOrZero))`.
  - Acquire via `pg_try_advisory_lock(int, int)` (split the 64-bit hash). Non-blocking — loser returns `skipped_lock`.
  - Released in `finally` via `pg_advisory_unlock`.
  Cooldown also moves to DB: `SELECT created_at FROM transcript_summaries WHERE ... ORDER BY created_at DESC LIMIT 1`. Process-local map stays as a cheap fast-path to skip obvious dupes before we touch the DB.

### 0.3 HIGH — Summary sections are not integrated with the composer yet
`buildPreambleSectionsFromContext` in `context-budget-telemetry.ts:229-329` handles bootstrap/handoff/memory/focus/queue/projects only. **Fix:** extend it to emit `standing` (stable, priority 3, `maxTokens=3_000`) and `working` (vary, priority 2 — below focus/recentTurns, above queue, `maxTokens=6_000`). Also emit `recentTurns` and `toolResults` from the new context fields. Corresponding allowlist entries must be added to the composer's `stableOrder`/`varyOrder` arrays (currently `["system","bootstrap","handoff","skills","projects","memory","workspace"]` / `["focus","recentTurns","queue","toolResults"]` at `composer.ts:151-152`). `standing` goes into the stable tier by accepting an occasional cache-bust (once per cooldown window, ~10 min) in exchange for the cross-wake caching benefit the rest of the time. `working` stays in vary because it changes with ticket progression.

### 0.4 HIGH — Issue scoping does not catch `issueId IS NULL` transcript rows
Transcript rows can have `issueId = NULL` (bootstrap preambles, terminal-session chunks, adapter.invoke meta). **Fix:** `loadTranscriptSince` takes two modes:
  - `issueId=X` → load `issue_id = X` rows AND null-issue rows from runs whose `issues.id = X` (join `heartbeat_runs` → `issues`). This captures per-issue work that wasn't tagged.
  - `issueId=null` (standing path) → load all rows since the standing cutoff, across issues. Standing schema's `activeTickets[]` validator drops tickets with closed/cancelled state before rendering, preventing stale cross-issue references from leaking back.

### 0.5 HIGH — Harness scope mismatch
Fixture scraping aggregates by agentId but eval drives per-issue summarization. **Fix:** scrape fixtures bound to an (agentId, issueId) pair; fixture meta line records `{ fixtureId, agentId, issueId, totalTokens, scrapedAt }`. Cutoff selection picks 3 ordinals within the fixture's ordinal range. Per-issue eval runs `summarizeAgentTranscript(scope="working", issueId=meta.issueId)`. Separate fixtures can test the standing path with `scope="standing", issueId=null`.

### 0.6 MED — `unsummarizedTokensFor` counting contract
v2 never defined what fields count. **Fix:** count only the `content` JSON of `role IN ('user','assistant','tool_result','system_directive')` entries, excluding `contentKind IN ('adapter.invoke','adapter.result')`. Measurement uses `countTokens(JSON.stringify(content), adapter.modelName, { calibrationRatio })`. The exclusion list avoids the 32KB `adapter.invoke` payload inflating the counter. Document the contract in `agent-transcripts.ts` alongside the new helper.

### 0.7 MED — Acceptance threshold needs anchors
The 0.80 gate is unanchored. **Fix:** the harness always computes three scores per fixture:
  - `control`: feed full transcript (no summary) — this is the ceiling.
  - `baseline`: feed no context (just the question) — this is the floor.
  - `summary`: feed `standing + working + last 5 raw turns` — the system under test.
  
  Report all three. Gate: `summary_score >= 0.85 * control_score AND summary_score > baseline_score + 0.10`. This is a defensible relative metric.

### 0.8 MED — Persistent-failure quarantine
v2 retries forever. **Fix:** track consecutive failures per `(agent, scope, scopeId)` key in a new lightweight table `summarizer_failures`:
  ```sql
  CREATE TABLE summarizer_failures (
    agent_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_id uuid,
    consecutive_failures int NOT NULL DEFAULT 0,
    last_error text,
    quarantined_until timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, scope_kind, COALESCE(scope_id, '0000...0000'::uuid))
  );
  ```
  After 3 consecutive failures, set `quarantined_until = now() + interval '24 hours'`. Queue checks the row before enqueueing. UI widget surfaces quarantine state with an "unquarantine" action.

### 0.9 MED — Migration 0039 is partially redundant
Migration 0037 already created the COALESCE UNIQUE index on `transcript_summaries`. **Fix:** migration 0039 now focuses on the genuinely-new schema:
  - `agent_transcripts.ordinal BIGSERIAL` column + index.
  - `summarizer_failures` table (per §0.8).
  - Ordinal backfill: `UPDATE agent_transcripts SET ordinal = DEFAULT WHERE ordinal IS NULL;` — runs inside the migration because BIGSERIAL default fires only on INSERT. Solution: `ALTER TABLE agent_transcripts ADD COLUMN ordinal BIGINT NOT NULL GENERATED BY DEFAULT AS IDENTITY`, then a deterministic backfill query that reads existing rows in `(company_id, created_at, id)` order and assigns monotonic ordinals via `ROW_NUMBER() OVER (ORDER BY ...)`.

### 0.10 LOW — `memoryIssueId` flip risk (Codex probe 7)
Codex found no evidence of mid-wake flips; `memoryIssueId` is frozen at enqueue via `heartbeat.ts:1150-1151` and the row lock on the issue is taken before run start. No design change. Captured as invariant: "issue scope is fixed at enqueue/start."

### 0.11 Summary of revised file list

Beyond v2:
- Migration `0039_summarizer_ordinal_and_failures.sql` NOW has real content (replaces the "redundant UNIQUE" migration).
- New file `packages/db/src/schema/summarizer_failures.ts`.
- `SummarizerQueue` gains advisory-lock pg calls.
- `buildPreambleSectionsFromContext` extended to emit 4 new sections.
- `composer.ts` stableOrder/varyOrder allowlists extended with `standing` (stable), `working` (vary). `standing` slot: between `memory` and `workspace`.
- Eval harness fixture meta + scoring changed per §0.5/§0.7.
- Counting contract in §0.6 codified as helper in `agent-transcripts.ts`.

## 1. What "context management" must actually solve

The north-star use case: **an agent picks up a ticket and completes it to done without a human having to intervene between wakes.** Round 3 feedback names the specific failure modes:

| Failure mode | Root cause | How dual-scope summaries fix it |
|--------------|-----------|---------------------------------|
| Agent forgets what it already tried | No durable per-issue working state | Per-issue summary includes `attemptsMade[]` |
| Agent re-reads the same file on every wake | No durable per-issue "known state" | Per-issue summary includes `filesExamined[]` |
| Context bleeds across issues (Anurag #2) | One big transcript shared across tickets | Wake on issue X loads only X's working summary + X's raw tail |
| Agent loses track of completed steps | No checklist persistence | Per-issue summary includes `decisionsMade[]` / `nextStepPlan` |
| Agent ignores user feedback from earlier threads | User prefs live inside the transcript that gets pruned | Per-agent **standing** summary captures `userPreferences[]` and is always included |
| Tickets stall because agent waits on stale context | No visible "current status" that survives wakes | Per-issue summary's `currentStatus` + `blockers[]` survive every prune |

This is why the Phase 6 design has **two** summary scopes that both ship together:
- **per-agent "standing"** — cross-ticket facts that never go stale (user prefs, repo conventions, skills exercised).
- **per-issue "working"** — scoped state for one ticket (attempts, files, decisions, blockers, next step).

One without the other doesn't close the loop: agent-only summaries reinforce the cross-ticket bleed; issue-only summaries lose cross-cutting user preferences.

## 2. Current state (unchanged from v1)

Shipped on `round3/integration`:
- Phase 3 tokenizer — `@combyne/context-budget` with per-family counting + calibration store.
- Phase 4 composer shadow — `composeBudgetedPreamble()` with per-section budgets + cache-prefix hashing; logs `context_budget.shadow_composition`.
- Phase 5 composer enabled — gated by `COMBYNE_CONTEXT_BUDGET_ENABLED=1`; writes budgeted content back into `context.combyne*` fields.

Tests: 36 context-budget + 65 server-service tests green.

## 3. Gap analysis — what's still broken

Same as v1; listed here for completeness:
1. `recentTurns` section is never populated — the adapter's transcript state is whatever its SDK session carries.
2. `toolResults` section is never populated — tool output bloat is unmanaged.
3. No summarizer exists.
4. Calibration samples are written but never consumed by the composer.
5. Cache hit rate is uninstrumented — we can't verify our cache-prefix hash actually hits.
6. Operators have no UI to see or control any of this.

## 4. Phase 6 architecture

```
                ┌────────────────────────────────────────────────────────┐
                │ Heartbeat wake (issue X)                               │
                │                                                        │
                │  1. Load standing summary for agent (if any)           │
                │  2. Load working summary for (agent, issue X) (if any) │
                │  3. Load raw transcript:                               │
                │       for issue X: seq > issue_X_summary.cutoff_seq    │
                │       (other issues' raw turns NOT loaded)             │
                │  4. Render summaries + turns → context.combyne*        │
                │  5. Run composer with calibration ratio snapshot       │
                │  6. Invoke adapter                                     │
                │                                                        │
                └────────────────────────┬───────────────────────────────┘
                                         │
                                         ▼
                ┌────────────────────────────────────────────────────────┐
                │ Heartbeat post-run:                                    │
                │                                                        │
                │  A. Append new transcript entries from this run        │
                │  B. Enqueue standing re-summarization if:              │
                │       - agent opted-in                                 │
                │       - unsummarized agent-wide tokens > 50k           │
                │       - cooldown (> 10 min since last)                 │
                │  C. Enqueue working re-summarization for issue X if:   │
                │       - agent opted-in                                 │
                │       - unsummarized tokens for X > 20k                │
                │       - cooldown (> 10 min since last for X)           │
                │                                                        │
                └────────────────────────┬───────────────────────────────┘
                                         │
                                         ▼
                ┌────────────────────────────────────────────────────────┐
                │ SummarizerQueue (per-agent mutex)                      │
                │  - coalesces concurrent triggers for same agentId      │
                │  - rate-limits per scope key                           │
                │  - runs summarizer with cost-gate                      │
                │  - writes row; UNIQUE (agent, scopeKind, scopeId, cut) │
                └────────────────────────────────────────────────────────┘
```

## 5. Sub-deliverables and file map

| # | Deliverable | New / Modified |
|---|-------------|----------------|
| A | `loadTranscriptSince(db, { sinceSeq, issueId? })` | Modify: `server/src/services/agent-transcripts.ts` |
| B | `recentTurns` + `toolResults` sections populated (claude-local, codex-local only) | Modify: `context-budget-telemetry.ts`, `heartbeat.ts`; adapter injection in claude-local + codex-local `execute.ts` |
| C | `transcript-summarizer.ts` with dual-scope support (`standing` + `working`) | New |
| D | `summarizer-queue.ts` — per-agent + per-scope-key mutex | New |
| E | `cost-table.ts` — model → $/Mtok; default gate $0.50/run | New |
| F | Summary rendering templates (two schemas, two renderers) | In `transcript-summarizer.ts` |
| G | Composer consumes summaries additively (no pruning Phase 6) | Modify: `context-budget-telemetry.ts` |
| H | Calibration ratio snapshot per-run: `rollingMedianRatio()` called once pre-compose; stored in `prompt_budget_json.calibrationRatioUsed`; same value used by composer and later by post-run calibration insert | Modify: `context-budget-telemetry.ts`, `heartbeat.ts` |
| I | Per-agent summarization toggle (`agents.adapterConfig.summarizer`) + cost cap | Modify: `agents` schema (no DB change — lives in JSON), UI |
| J | Quality harness with scraped fixtures + auto-generated oracle questions | New: `scripts/eval-summaries.ts`, `scripts/scrape-fixtures.ts`, `tests/fixtures/summarizer/*.jsonl` |
| K | Ops telemetry: per-section tokens, cache-hit rate, summarizer costs | Modify: `heartbeat.ts` |
| L | UI widget: `AgentContextBudgetCard` on AgentDetail | New: `ui/src/components/AgentContextBudgetCard.tsx`, `ui/src/api/agents.ts`; new route `GET /agents/:id/context-budget-summary` |
| M | UI: summarization toggle + budget input in agent settings | Modify: existing AgentDetail settings area |

## 6. Detailed design

### 6.1 recentTurns + toolResults sections (A, B)

New loader:

```ts
export async function loadTranscriptSince(db: Db, opts: {
  companyId: string;
  agentId: string;
  issueId?: string | null;   // filter by issue (for per-issue context)
  sinceSeq?: number | null;  // strictly greater than
  maxRows?: number;          // default 200, hard cap 500
  excludeKinds?: string[];   // e.g. ["bootstrap_preamble", "handoff_brief"]
}): Promise<TranscriptSince>;
```

Rendering (`renderTranscriptForPrompt(entries)`) produces two strings:
- `main` — user/assistant/system turns joined with role headers.
- `tools` — tool_call + tool_result entries, joined separately so the composer can budget them independently (20% of total budget, middle-truncation).

`buildPreambleSectionsFromContext` gains:
```ts
if (combyneRecentTurns?.body) push({ name:"recentTurns", priority:2, cacheStable:false, strategy:"head" });
if (combyneToolResults?.body) push({ name:"toolResults", priority:4, cacheStable:false, strategy:"middle", maxTokens: floor(budget * 0.2) });
```

Adapter consumption — **claude-local and codex-local only**. Each adapter's `execute.ts` appends the two new sections to its preamble. Scope-limit rationale: the other 4 adapters don't inject `combyneAssignedIssues` today either, so widening that coverage is a Round 4 item. Add `logger.debug("adapter.recent_turns_unused", { adapterType })` when a non-covered adapter sees a populated section, so ops can spot the gap later.

### 6.2 Summarizer service (C, F)

File: `server/src/services/transcript-summarizer.ts`.

**API:**

```ts
export type SummaryScope = "standing" | "working";

export interface SummarizeInput {
  companyId: string;
  agentId: string;
  scope: SummaryScope;
  issueId?: string | null;  // required when scope === "working"
  maxInputTokens?: number;  // default 80_000
  maxCostUsd?: number;      // default from agent config, fall back 0.50
  summarizerModel?: string; // default from agent config, fall back per-adapter table
}

export interface SummarizeResult {
  status: "created" | "skipped_below_trigger" | "skipped_cost_gate" |
          "skipped_parse_retry_exhausted" | "skipped_rate_limit" | "failed";
  summaryId?: string;
  cutoffSeq?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}

export async function summarizeAgentTranscript(db: Db, input: SummarizeInput): Promise<SummarizeResult>;
```

**Scope → schema mapping:**

`standing` schema (cross-ticket):
```json
{
  "activeTickets":     [{ "ticketId": "BUK-23", "title": "...", "status": "..." }],
  "userPreferences":   ["..."],
  "repoConventions":   ["..."],
  "infraQuirks":       ["..."],
  "skillsExercised":   ["..."],
  "recentFacts":       ["..."],
  "narrative":         "..."
}
```

`working` schema (per-ticket):
```json
{
  "ticketId":       "BUK-23",
  "title":          "...",
  "currentStatus":  "in_progress | awaiting_user | blocked | in_review",
  "attemptsMade":   [{ "approach": "...", "outcome": "...", "reason": "..." }],
  "filesExamined":  ["path/to/a.ts"],
  "filesModified":  ["path/to/b.ts"],
  "commandsRun":    ["pnpm build"],
  "decisionsMade":  ["..."],
  "blockers":       ["..."],
  "openQuestions":  ["..."],
  "nextStepPlan":   "...",
  "lastUserMessage": "...",
  "narrative":      "..."
}
```

Both rendered via deterministic markdown templates. Same structured JSON always produces identical rendered text → composer's cache-prefix hash stays stable.

**Model selection (per-adapter defaults):**

| Agent adapter | Default summarizer model | Fallback |
|---------------|-------------------------|----------|
| claude-local (Opus) | claude-haiku-4-5 | agent model |
| claude-local (Sonnet) | claude-haiku-4-5 | agent model |
| codex-local | gpt-4o-mini | agent model |
| cursor-local | agent model | — |
| gemini-local | gemini-2.5-flash | agent model |
| pi-local | agent model | — |
| opencode-local | agent model | — |

Overrides: `agent.adapterConfig.summarizer.model` > `COMBYNE_SUMMARIZER_MODEL_<ADAPTER>` > default.

**Cost gate (`cost-table.ts`):**

Flat table with input/output USD-per-million. Shipping defaults:

```ts
export const COST_TABLE = {
  "claude-haiku-4-5":  { input: 0.80,  output: 4.00 },
  "claude-sonnet-4-6": { input: 3.00,  output: 15.00 },
  "claude-opus-4-7":   { input: 15.00, output: 75.00 },
  "gpt-4o-mini":       { input: 0.15,  output: 0.60 },
  "gemini-2.5-flash":  { input: 0.075, output: 0.30 },
};
export function estimateCost(model: string, inputTokens: number, expectedOutputTokens: number): number {
  const row = COST_TABLE[model] ?? { input: 0.50, output: 2.50 }; // unknown-model fallback
  return (inputTokens * row.input + expectedOutputTokens * row.output) / 1_000_000;
}
```

Gate: if `estimateCost(...) > maxCostUsd`, skip with `skipped_cost_gate`, log `transcript_summary.skipped { reason: "cost_gate", estimatedCost, maxCostUsd }`. This is surfaced in the UI widget so operators can raise the cap or intervene.

**Parse-retry protocol:**
- Attempt 1: run as-is.
- Attempt 2 (if JSON parse throws): prepend `Your previous response was not valid JSON. Return ONLY the JSON object.` to user message.
- No attempt 3. Emit `transcript_summary.skipped { reason: "parse_retry_exhausted" }`, don't write row, composer falls back to raw tail next wake.

**Idempotency:**
- UNIQUE `(agent_id, scope_kind, scope_id, cutoff_seq)` on `transcript_summaries` prevents duplicate rows.
- Loser of a race logs `transcript_summary.race_lost` and returns the winner's row.
- `scope_id` is `NULL` for `standing`, `issueId` for `working`. `NULL`s don't collide in PG unique index by default — **we need the UNIQUE to treat NULLs as equal.** Fix: add a UNIQUE partial index in migration 0039 with `COALESCE(scope_id, '00000000-...')` as the collision key, or use PG 15+ `NULLS NOT DISTINCT`. This is a Phase 6 migration add (see §9).

### 6.3 Summarizer queue (D)

File: `server/src/services/summarizer-queue.ts`.

```ts
class SummarizerQueue {
  private inFlight = new Map<string, Promise<SummarizeResult>>();  // "agentId:scope:scopeId" → promise
  private lastRunAt = new Map<string, number>();                   // same key → ms epoch
  private cooldowns = {
    standing: 10 * 60_000,
    working:  10 * 60_000,
  };

  async maybeEnqueue(db: Db, input: SummarizeInput): Promise<SummarizeResult | null> {
    const key = `${input.agentId}:${input.scope}:${input.issueId ?? ""}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const last = this.lastRunAt.get(key) ?? 0;
    if (Date.now() - last < this.cooldowns[input.scope]) {
      return { status: "skipped_rate_limit" };
    }
    const p = summarizeAgentTranscript(db, input).finally(() => {
      this.inFlight.delete(key);
      this.lastRunAt.set(key, Date.now());
    });
    this.inFlight.set(key, p);
    return p;
  }
}
```

Non-durable (no Redis). Server restart re-fires on next wake. Acceptable because pruning is additive Phase 6 — the fallback is "use raw tail."

### 6.4 Heartbeat integration (B, G, H)

Pre-run (before composer runs):

```ts
// Load standing summary (if any)
const standing = await latestSummary(db, { agentId, scope: "standing", scopeId: null });
// Load working summary for THIS issue (if any)
const working = memoryIssueId
  ? await latestSummary(db, { agentId, scope: "working", scopeId: memoryIssueId })
  : null;

// Load raw transcript: only for this issue, past its working cutoff
const rawSince = working?.cutoffSeq ?? null;
const transcript = await loadTranscriptSince(db, {
  companyId: agent.companyId,
  agentId: agent.id,
  issueId: memoryIssueId ?? null,
  sinceSeq: rawSince,
  excludeKinds: ["bootstrap_preamble", "handoff_brief"],
});

const rendered = renderTranscriptForPrompt(transcript.entries);
if (standing) context.combyneStandingSummary = { body: renderStanding(standing), cutoffSeq: standing.cutoffSeq };
if (working)  context.combyneWorkingSummary  = { body: renderWorking(working), cutoffSeq: working.cutoffSeq, issueId: memoryIssueId };
if (rendered.main)  context.combyneRecentTurns = { body: rendered.main, count: transcript.totalCount };
if (rendered.tools) context.combyneToolResults = { body: rendered.tools };

// Snapshot calibration ratio — used by composer AND by later post-run calibration insert
const calibrationRatio = await rollingMedianRatio(db, snapshot.tokenizerFamily);
context.combyneCalibrationRatio = calibrationRatio;

// Compose (existing Phase 5 path, now with calibrationRatio)
composeAndApplyBudget(context, { ..., calibrationRatio });
```

Post-run (after result arrives):

```ts
// Append the run's new turns to agent_transcripts (already done today)
// Enqueue summarization if opted-in
const cfg = agent.adapterConfig?.summarizer;
if (cfg?.enabled) {
  const maxCostUsd = Number(cfg.maxCostUsdPerRun ?? 0.50);
  // Standing — cross-ticket
  const standingUnsummarized = await unsummarizedTokensFor(db, { agentId, scope: "standing" });
  if (standingUnsummarized > SUMMARY_TRIGGER_STANDING_TOKENS) {
    queue.maybeEnqueue(db, { companyId, agentId, scope: "standing", scopeId: null, maxCostUsd });
  }
  // Working — per-issue
  if (memoryIssueId) {
    const workingUnsummarized = await unsummarizedTokensFor(db, { agentId, scope: "working", issueId: memoryIssueId });
    if (workingUnsummarized > SUMMARY_TRIGGER_WORKING_TOKENS) {
      queue.maybeEnqueue(db, { companyId, agentId, scope: "working", issueId: memoryIssueId, maxCostUsd });
    }
  }
}

// Cache-hit telemetry
if (result.usage?.cacheReadInputTokens != null) {
  logger.info({
    runId, cachePrefixHash, cacheReadTokens: result.usage.cacheReadInputTokens,
    cacheCreationTokens: result.usage.cacheCreationInputTokens ?? 0,
    hitRate: (cacheReadTokens / (cacheReadTokens + cacheCreationTokens)) || 0,
  }, "context_budget.cache_status");
}
```

Trigger thresholds (tunable via env):
- `SUMMARY_TRIGGER_STANDING_TOKENS = 50_000`
- `SUMMARY_TRIGGER_WORKING_TOKENS = 20_000`

### 6.5 Calibration ratio snapshot (H)

Per answer to question 5: the calibration ratio is read ONCE per run (pre-compose), stored in `prompt_budget_json.calibrationRatioUsed`, and reused by the composer and by the later post-run calibration-sample insert. This means:
- A run's token estimates are consistent within the run.
- Cache prefix stays stable even when the global calibration median shifts mid-day.
- The post-run insert `recordCalibrationSample` writes the ratio that WAS applied, not what would be applied now — so we can analyze drift.

### 6.6 Summarization opt-in UI (I, M)

Agent config additions (in `agent.adapterConfig.summarizer`, no DB schema change):

```json
{
  "summarizer": {
    "enabled": false,                 // default OFF
    "maxCostUsdPerRun": 0.50,
    "model": null,                    // null = use adapter default
    "scopes": ["standing", "working"] // allow turning off just one
  }
}
```

UI (on AgentDetail → Settings area):
- **Toggle** "Enable transcript summarization (uses additional model tokens)" — off by default.
- Numeric input "Max USD per summarization run" — default 0.50.
- Dropdown "Summarizer model" — `(default for adapter)`, `haiku`, `sonnet`, `gpt-4o-mini`, `gemini-flash`.
- Two checkboxes: "Standing summaries" / "Working summaries" — both default on when toggle flips on.
- Helper text: "Disabled summarization means agents lose older context when it exceeds the token budget. Summaries preserve decisions, attempts, and user preferences across wakes."

Cost visibility inline: shows last 7 days of `transcript_summary.created` rows for this agent: total spend, count, average cost/call.

### 6.7 Quality harness (J)

Per answer to question 4: fixtures scraped from real pilot transcripts, **no redaction**. Two scripts:

**`scripts/scrape-fixtures.ts`:**
1. Query `heartbeat_runs` for the 50 most-recent completed runs.
2. For each, load all `agent_transcripts` rows by `runId`.
3. Group by `agentId` — one fixture per agent, aggregating runs until the fixture hits ~40–200k tokens.
4. For each fixture, auto-generate via summarizer-model:
   - 5 canonical comprehension questions (e.g. "Which files did the agent modify for BUK-23?", "What was the last user instruction?", "What decision was made about X?").
   - Oracle answers produced by feeding full transcript + question to the same model.
5. Write `tests/fixtures/summarizer/<fixtureId>.jsonl`:
   ```
   {"kind":"meta", "fixtureId":"...", "agentId":"...", "totalTokens":N}
   {"kind":"entry", "seq":1, "role":"user", "content":{...}}
   {"kind":"entry", "seq":2, ...}
   ...
   {"kind":"question", "q":"...", "oracleAnswer":"..."}
   ```
6. Commit fixtures to the repo. No PII redaction.

Run once to seed; re-run quarterly to refresh.

**`scripts/eval-summaries.ts`:**
1. For each fixture:
   a. Pick 3 cutoff points: 40%, 60%, 80% of the transcript.
   b. For each cutoff, call `summarizeAgentTranscript(scope="working", issueId=...)` on entries up to the cutoff.
   c. Compose: `standing + working + last-5-raw-turns`.
   d. For each of the 5 questions, feed `composed + question` to the agent model. Capture answer.
   e. Score each answer vs oracle via LLM-as-judge (same model, temperature 0, "Does answer B convey the same material facts as answer A? Respond with SCORE: 1 or 0.").
2. Aggregate: fixtures × cutoffs × questions = 10 × 3 × 5 = 150 trials.
3. Emit `eval-summaries-report.json`:
   ```json
   { "overall": 0.83, "byFixture": { ... }, "byCutoff": { "40%": 0.85, "60%": 0.82, "80%": 0.81 }, "runId": "..." }
   ```
4. Exit non-zero if overall < threshold (0.80 for Phase 6 additive mode).

**Stub mode** — `--stub` flag runs a deterministic fake summarizer + judge for CI dry-run.

### 6.8 UI widget (L)

Component: `ui/src/components/AgentContextBudgetCard.tsx`.

Data endpoint: `GET /agents/:id/context-budget-summary` returns:
```ts
{
  recentRuns: [                     // last 10 runs, newest first
    { runId, startedAt, totalTokens, dropped, truncated, cachePrefixHash, calibrationRatioUsed, cacheHitRate? }
  ],
  latestSummaries: {
    standing: { id, cutoffSeq, createdAt, summarizerModel, costUsd },
    working:  [{ issueId, issueTitle, cutoffSeq, createdAt, costUsd }]
  },
  spend: {
    last7Days:  { totalUsd, calls, avgUsd },
    last30Days: { totalUsd, calls, avgUsd }
  },
  budget: { perAdapterDefault: 160_000, override: 50_000 }
}
```

Card renders:
- Sparkline of `totalTokens` across last 10 runs.
- Stacked bar of per-section tokens for most recent run.
- Cache hit rate (mean across runs that reported it).
- Latest standing summary timestamp (link to view).
- Table of per-issue working summaries.
- 7-day spend.

No editing from card — settings live in the Settings area described in §6.6.

## 7. Risk register (v2)

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Working summary hallucinates file paths or commands | High — agent acts on wrong state | Post-parse validation: `filesExamined`/`filesModified` entries that don't exist in the workspace are logged as `summary.stale_file_ref` and dropped from rendered output (kept in `structured_json` for audit). |
| Standing summary "activeTickets" drift (lists tickets since closed) | Med | Validate each `ticketId` against current `issues.identifier`; drop closed/cancelled from rendered template (keep in JSON). |
| Summarizer model returns markdown-fenced JSON | Med | Strip leading/trailing ```json fences + surrounding prose before parsing. Retry on failure. |
| Summary gets promoted to cache-stable prefix, then mutation busts cache every wake | High — kills prompt caching | Keep summary in `recentTurns` (vary), NOT stable. Do not move to stable until a measurement phase proves stability. Dev-mode hash assertion catches accidental drift. |
| Dual-scope costs balloon for heavy-issue agents | Med | Cost-table gate + opt-in default off + 10-min cooldown per scope-key. UI surfaces cumulative spend. Ops can disable working summaries while keeping standing. |
| UNIQUE constraint doesn't treat NULL scope_ids as equal (PG default) | High — duplicate standing rows | Migration 0039 adds `CREATE UNIQUE INDEX ... (agent_id, scope_kind, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), cutoff_seq)`. |
| Concurrent heartbeats for same agent both trigger standing summarization | Med | `SummarizerQueue.inFlight` map coalesces; UNIQUE index protects DB. |
| Adapter doesn't consume new sections (cursor/gemini/opencode/pi) | Known | Claude + codex only this phase; log `adapter.recent_turns_unused` for others. Round 4 scope. |
| LLM-as-judge inconsistent run-to-run | Med | Temperature 0; fixed random seed for cutoff selection; 150 trials per eval; track variance across 3 runs of the harness and require stddev < 0.03. |
| Fixture scraping pulls stale data that no longer represents production | Low | Re-scrape quarterly; keep fixture creation timestamp in `{kind:"meta"}` line. |
| Agent opts-in but has no activity — budget wasted on repeated skips | Low | `skipped_below_trigger` is logged but doesn't count against spend caps. Noop. |
| Phase 6 soak on real pilot surfaces a failure mode we didn't predict | Expected | Phase 7 design explicitly deferred until we have evidence (per answer to Q7). |

## 8. Test plan

Unit:
- `transcript-summarizer.test.ts`: both schemas parse correctly; cost-gate skips; parse-retry-once works; markdown-fence stripping; null scope_id goes to standing; UNIQUE collision returns winner's row.
- `summarizer-queue.test.ts`: concurrent same-key coalesces; different keys run in parallel; cooldown enforced; standing+working for same agent run concurrently.
- `cost-table.test.ts`: known models compute correctly; unknown falls back to default.
- `recent-turns-rendering.test.ts`: role ordering; tool split; deterministic.
- `context-budget-shadow.test.ts`: extend with standing+working sections, calibration snapshot path.

Integration (uses embedded-postgres):
- Seed: agent A with 50 transcript entries across issues X, Y. Run post-run trigger for issue X's wake.
- Assert: exactly 1 `standing` row AND 1 `working` row for (A, X) inserted. Neither inserted for issue Y.
- Second wake on Y: composer's `combyneWorkingSummary` is null for Y (no summary yet); `combyneStandingSummary` is present. No raw turns from X loaded.
- Race test: spawn 3 concurrent standing-summarize calls for A. Assert exactly 1 row.

E2E (dev server + manual):
- Enable summarizer on one agent via UI. Wake it 5 times on the same issue. After wake 3, assert working summary row exists. After wake 5, assert its `cutoff_seq` advanced.
- Inspect `adapter.invoke` event payload.prompt → contains "## Prior working summary" block AND "## Standing knowledge" block.

Soak (the real validation):
- Pick three real pilot tickets: BUK-23, BUK-16, BUK-13.
- Configure a test agent with summarizer enabled.
- Drive 20 wakes per ticket over 48 hours.
- Success criteria:
  - Zero `context_budget.fallback` events.
  - ≥ 1 working summary per ticket, ≥ 1 standing summary.
  - Mean cache hit rate within 5 pp of pre-flag baseline (baseline to be captured with flag off for 24h first).
  - Qualitative: did tickets advance? Did the agent repeat itself? Did operator have to intervene? (Hand-graded.)
- This is the evidence Phase 7 design will be based on (per answer to Q7).

Eval harness:
- CI gate on `pnpm eval:summaries`: overall ≥ 0.80 before Phase 6 can merge.
- Track per-fixture scores; regressions on ≥2 fixtures block merge.

## 9. Migration (one new migration)

`0039_summarizer_null_scope.sql`:

```sql
-- Phase 6 — teach the UNIQUE on transcript_summaries to treat NULL scope_id
-- as equal (PG default is "NULL ≠ NULL" which lets duplicate standing rows
-- sneak in under racy triggers). Using COALESCE into a zero-UUID.
DROP INDEX IF EXISTS transcript_summaries_unique_idx;
CREATE UNIQUE INDEX transcript_summaries_unique_idx ON transcript_summaries (
  agent_id,
  scope_kind,
  COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
  cutoff_seq
);
```

This replaces (or adds — the original 0037 only added a lookup index, not UNIQUE) the de-duplication contract.

## 10. PR sequence

1. **PR 6.1** — migration 0039 + `loadTranscriptSince` + recentTurns/toolResults sections (no summarizer yet). Behind existing `COMBYNE_CONTEXT_BUDGET_ENABLED`. Adapter injection for claude-local + codex-local.
2. **PR 6.2** — cost-table + transcript-summarizer + summarizer-queue. Service-only, no triggers yet. Unit tests.
3. **PR 6.3** — heartbeat integration: pre-run summary load + post-run trigger. Opt-in flag in adapterConfig.
4. **PR 6.4** — calibration-ratio snapshot per-run + cache-hit telemetry.
5. **PR 6.5** — quality harness: `scrape-fixtures.ts` + `eval-summaries.ts` + 10 fixtures. CI gate.
6. **PR 6.6** — UI: `AgentContextBudgetCard` + summarization settings + new API route.
7. **Soak 6** — 48h on real pilot tickets. Capture metrics. Write Phase 7 design doc based on findings.
8. **PR 7.x** — to be designed after soak.

## 11. Phase 7 — explicitly deferred

Per answer to Q7, **no Phase 7 design in this document.** After Phase 6 soaks on BUK-23, BUK-16, BUK-13 for 48 hours, we write `PHASE7-postsoak.md` based on evidence:
- Did tickets complete without intervention?
- Where did the agent get stuck?
- Did summaries preserve the right state?
- Do we need aggressive pruning, better summaries, a different composition strategy, or something else entirely?

The question Phase 7 answers isn't "should we prune raw turns?" — it's "what's still preventing autonomous completion?"

## 12. Open questions remaining

- **Working-summary seed when no prior summary exists** — does the first working summary cover ALL of the issue's history, or should there be a cold-start window (e.g. first summary only covers entries 500+)? Current plan: all history, bounded by `maxInputTokens = 80k`. If issue has > 80k history, we lose the oldest — acceptable edge case.
- **What happens when an issue changes ownership** — if agent A summarized issue X's working state, then X is reassigned to agent B, does B inherit A's summary? Current plan: no. B starts fresh. A's summary row stays (audit trail). Add `summary.inherited_from_agent` field in Round 4 if needed.
- **Rate limit tier-ups** — if an agent legitimately needs more than 1 summary/10min (e.g. rapid-fire wakes during a demo), how do operators override? Current plan: UI cooldown is informational-only; actual enforcement is in `summarizer-queue.ts` constants. Round 4: add `agent.adapterConfig.summarizer.cooldownMs` override.
