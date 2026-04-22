# Item #6 — Context Budget (tokenizer + composer + summarizer)

Phases 3–7 of Round 3. Highest-risk item. **See master plan §"Item 6" for full architecture.**

## TL;DR

Three layers, dark-launched via feature flags:

1. **Tokenizer** (`packages/context-budget`): per-family counting (Anthropic, OpenAI, Gemini, heuristic) + rolling calibration vs adapter-reported `inputTokens`.
2. **Composer** (`ContextBudgeter`): section-model preamble assembler with priority-based truncation, cache-stable prefix ordering, tool-result middle-truncation.
3. **Summarizer** (`transcript-summarizer.ts` + new table `transcript_summaries`): triggers on unsummarized-token watermark; writes structured-JSON summary; composer consumes it.

## Phased flags (see master plan for per-phase gates)

| Phase | Flag | Behavior |
|-------|------|----------|
| 3 / 6.1 | `context_budget.tokenizer` | Telemetry only. No behavior change. |
| 4 / 6.2 | `context_budget.composer_shadow` | Composer runs alongside byte caps; logs would-be output. |
| 5 / 6.3 | `context_budget.composer_enabled` | Composer replaces byte caps. Byte caps stay as hard floor. |
| 6 / 6.4 | `context_budget.summarizer_enabled` | Summarizer writes rows; composer consumes additively. |
| 7 / 6.5 | `context_budget.aggressive_pruning` | Composer excludes raw turns ≤ `latest_summary.cutoff_seq`. |

## Critical design guardrails (from Codex)

- **Durable cutoff.** `transcript_summaries.cutoff_seq` is the ONLY basis for excluding raw turns. "A summary exists" is not enough.
- **Never silently drop raw turns.** On summarization failure, composer falls back to raw tail.
- **Preserve prompt cache.** Stable-section prefix must be bit-identical across wakes with unchanged upstream. Runtime hash assertion in dev mode.
- **Tool results budget independently.** 20% of total budget, middle-truncate with omission marker.

## Per-adapter input budgets

| Adapter | Model family | Input budget | Output reserve |
|---------|--------------|--------------|----------------|
| claude-local | Sonnet 4.6 / Opus 4.7 (200k) | 160_000 | 8_192 |
| codex | GPT-5 / 4o (400k) | 320_000 | 16_384 |
| cursor | Various (200k) | 160_000 | 8_192 |
| gemini | 2.5 Pro (2M) | 800_000 | 32_768 |
| opencode | GPT-4o-mini (128k) | 100_000 | 4_096 |
| pi | Inflection 2.5 (32k) | 24_000 | 4_096 |

Override precedence: `adapterConfig.contextBudgetTokens` > `COMBYNE_<ADAPTER>_CONTEXT_BUDGET_TOKENS` env > default.

## Shipping status (updated per phase)

- Phase 3 (Tokenizer): **shipped** via `round3/phase3-tokenizer`. Telemetry-only. `@combyne/context-budget` exposes `countTokens`, `tokenizerInfo`, calibration store. heartbeat.ts persists `heartbeat_runs.prompt_budget_json` + writes to `tokenizer_calibration` after each run.
- Phase 4 (Composer shadow): **shipped** via `round3/phase4-composer`. Greedy composer with per-section truncation + cache-prefix hashing. heartbeat.ts logs `context_budget.shadow_composition` with composed-vs-actual comparison on every run. No adapter behavior change.
- Phase 5 (Composer enabled): **shipped** via `round3/phase5-composer-enabled`. Feature-gated by `COMBYNE_CONTEXT_BUDGET_ENABLED=1`. When on, `composeAndApplyBudget` writes token-budgeted content back into `context.combyne*` fields before the adapter assembles its prompt. Byte caps (16k memory, 8k queue, 32k stdout) remain as a hard floor.

## Env flags (ops reference)

| Env var | Default | Purpose |
|---------|---------|---------|
| `COMBYNE_CONTEXT_BUDGET_ENABLED` | unset (false) | Enable composer-applied budgeting. Telemetry always on. |
| `COMBYNE_CLAUDE_LOCAL_CONTEXT_BUDGET_TOKENS` | 160000 | Override per-adapter budget. |
| `COMBYNE_CODEX_LOCAL_CONTEXT_BUDGET_TOKENS` | 320000 | Same. |
| `COMBYNE_PI_LOCAL_CONTEXT_BUDGET_TOKENS` | 24000 | Same. |
| `COMBYNE_GEMINI_LOCAL_CONTEXT_BUDGET_TOKENS` | 800000 | Same. |

Per-agent override: set `adapterConfig.contextBudgetTokens` on the agent row.

## Quality harness

`scripts/eval-summaries.ts` — 10 canonical transcript fixtures, summarize → feed `summary + last_5_turns` to model → ask 5 canonical questions → judge vs oracle. Accuracy must stay ≥ 0.75 (additive mode) and ≥ 0.72 (aggressive mode).

## Failure modes (explicitly handled)

| Mode | Handling |
|------|---------|
| Tokenizer panic | fallback to heuristic; log `tokenizer.panic`. |
| Calibration diverged | if ratio > 2× for 24h, page. |
| Bad summarizer JSON | retry once; fall back to raw tail. |
| Cache prefix busted | log + dev-mode throw. |
| Budget < stable minimums | shrink memory → skills → projects; if still too small, page. |
