# ADE Pilot Feedback — Round 3 Plan Index

Filed by Anurag on 2026-04-22 after evaluating BUK-23. Master plan lives at
`~/.claude/plans/delegated-sprouting-goblet.md`; the per-item files below are
the sub-plans carved out of it for implementation.

## Phases (see master plan for gates between phases)

- **Phase 0** — `OPEN_STATUSES` drift fix + plan scaffolding.
- **Phase 1** — Migrations bundle (0035–0038).
- **Phase 2** — Focus directive + queue digest (Item #2).
- **Phase 3** — Context budget Layer 1: tokenizer (Item #6.1).
- **Phase 4** — Context budget Layer 2: composer in shadow mode (Item #6.2).
- **Phase 5** — Composer enabled (Item #6.3).
- **Phase 6** — Summarizer Layer 3 (Item #6.4).
- **Phase 7** — Aggressive pruning A/B (Item #6.5).
- **Phase 8** — Stuck-lock fix (Item #7).
- **Phase 9** — Transcript UI (Item #3).
- **Phase 10** — Skills scoping (Item #4).
- **Phase 11** — Project delete UI (Item #5).
- **Phase 12** — Routine filter + optional auto-close (Item #8).
- **Phase 13** — Docs + final integration.

## Sub-plan files

| File | Item | Status |
|------|------|--------|
| `01-direct-chat.md` | #1 | Deferred to Round 4 |
| `02-focus-directive.md` | #2 | Phase 2 |
| `03-transcript-ui.md` | #3 | Phase 9 |
| `04-skills-scoping.md` | #4 | Phase 10 |
| `05-project-delete-ui.md` | #5 | Phase 11 |
| `06-context-budget.md` | #6 | Phases 3–7 |
| `07-stuck-locks.md` | #7 | Phase 8 |
| `08-routine-origin-filter.md` | #8 | Phase 12 |

## Guardrails (from Codex second-opinion pass)

- Never unlock on `executionLockedAt` age alone — verify referenced run is non-live.
- Summary pruning requires a durable `cutoff_seq` watermark; never drop raw turns without it.
- Project delete must count ALL issues (open + closed).
- Skills scoping is a runtime-surface change — treat adapter injection as part of the compat contract.
- Transcript route must be company-scoped via run lookup, not query params.
- Landing order: migrations → server → UI.
