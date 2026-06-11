# ADE End-to-End Orchestration Test — Final Report
**Date:** 2026-06-10 · **Company:** Lending (`PINB405`) · **Conductor:** Claude (board-side) · **Human gate:** Krish

## Executive summary

One real refactor ticket ([BE] [Brick] PR-423 Updates Based on AI Review → PINB405-12) traveled the full pipeline: **board injection → EM triage → delegation → engineer implementation → PR → human merge → ticket closure**, with the central context DB read on every agent wake and written via the verified pr-approval path after merge. Code quality was good (6/7 acceptance items fully correct; the 7th — ironically the security item — structurally improved but incompletely encoded). The orchestration **self-healed twice** without human repair.

**Verdict: not hand-off ready yet.** The pipeline core works, but four high-severity gaps would hurt real developer teams immediately: silent wake loss (F5), the EM delegation path bypassing the curated context passdown (F6), out-of-band merges stranding pipeline state (F13, compounded by the staging merge-allowlist gate F8), and artifact detection that misses real pushed work (F9). Notification hygiene (F7/F10/F14) makes all of the above invisible to the human. One environment gap (F11) means no Java test can be verified anywhere in the loop.

A first round with two tickets (PINB405-10/11) was cancelled by design: both were already implemented upstream on the test mirrors — caught in pre-flight before agents burned tokens.

## Timeline

| Time | Event |
|---|---|
| 11:31 | Round 1: PINB405-10/11 injected → EM woke instantly, checked out both correctly |
| 11:36 | Round 1 cancelled (tickets already implemented upstream); EM resumed |
| 11:38 | PINB405-12 injected → **wake silently lost** (EM was UI-paused; 409 logged server-side only) [F5] |
| 11:43 | Manual `/agents/:id/wakeup` → EM checkout |
| 11:44 | EM delegated subtask PINB405-13 to Backend-1 — clean scope rewrite, parent kept open; **generic endpoint used → no passdown packet** [F6] |
| 11:44–11:52 | Backend-1 run 1 (8.7 min): implemented all items, committed `de8bbaa`, pushed branch, opened PR #2 — **but exited before tracking/comment** |
| 11:52 | Progress gate declared "no verifiable artifact" (missed the pushed branch + open PR) → `awaiting_user` [F9]; **invisible in UI** [F10] |
| 11:53 | EM auto-requeued with "re-attempt full implementation" (misdirected by the gate's false negative) |
| 11:54 | Backend-1 re-run: **detected existing branch/PR, did not duplicate work**, tracked PR, → `in_review` in 40s |
| 12:04 | Human clicked "Let agents fix" → correct no-op wake (no feedback pending); human merged PR #2 **on GitHub directly** (dashboard gate rejects base `staging`) [F8/F13] |
| 12:05 | Tracking stranded open/pending → manual reconcile → tracking `merged`, PINB405-13 `done`, **pr-approval memory entry written (verified, system path)** |
| 12:07 | EM woke, closed parent PINB405-12 `done`. Stale merge-approval cards remain pending [F14] |

## Agent scorecards

**EM** — strong. Instant wake on assignment (when not paused); checkout-before-work always; delegation within 40s of wake; subtask description was a *better* spec than the raw ticket (consolidated 7 messy items into 4 structured changes with before/after snippets, stripped Jira copy-paste noise, identified the right repo); parent kept `in_progress` until child done (no premature closure — the live agent beats its own docs, see F2); prefixed links in comments. Dings: delegated via the generic endpoint so the passdown rail never engaged (skill doc's fault, F6); "re-attempt the full implementation" re-run instruction trusted the gate's false negative instead of checking git (minor); closed the parent without a closing comment (minor).

**Backend-1** — good code, weak workflow tail in run 1, excellent recovery. Correct branch naming (`feat/PINB405-13/...`), accurate scoped commit; all guardrails respected (no merge attempt, no unsolicited reviews, pushed only to the allowlisted test remote). Run 1 dropped the final workflow steps (PR tracking, `in_review`, comment) — likely turn-budget exhaustion. Run 2 was the highlight: recognized existing work in 40s and completed only the missing steps instead of re-implementing. Worked directly in the shared parent clone — per-issue worktree isolation never engaged (no `execution_workspaces` row); harmless single-engineer, collision risk in parallel rounds (F9 note).

**Backend-2 / CEO** — not exercised (single-ticket round; parallel-delegation test still outstanding).

## Code review (PR #2 — full review in `pr2-code-review.md`)

6/7 items PASS: constants extraction (×4 strings), parameterized generics via `exchange()` + `ParameterizedTypeReference`, `buildPath` down to one `continue`. PARTIAL: URL safety — query params correctly `.encode()`d, but the three path-segment sites call `buildAndExpand()` **without** `.encode()`, so expanded IDs aren't percent-encoded and `/`-based path injection remains possible (medium; recommend follow-up ticket). Behavior nuance worth a regression test: `phoneNumber` with `+` is now percent-encoded where it previously went raw. **No automated verification was possible anywhere**: local Gradle 7.4 can't run on host Java 25, no other JDK installed, no CI on the mirror (F11).

## Central context DB

- **Reads: working.** Every agent wake (EM ×3, Backend-1 ×2) retrieved the top-4 entries with scores logged to `memory_usage`; `requireVerified` held (the unverified entry was never served); service-scope boost ranked the fs-brick entry highest for the fs-brick task. Relevance was mediocre (0.38–0.53) — honest reflection of a thin, Veefin-free corpus, not a ranking failure.
- **Writes: human/system-gated only, as designed.** Zero agent-minted entries; the only new entry was the verified `pr-approval` note for PR #2, created by the system path post-reconcile. Trust spine intact end-to-end.
- **Gaps:** the curated EM→engineer passdown packet never fired (F6 — wrong endpoint taught by the skill); a known-stale claim ("staging not merge-allowed") sits in a verified entry and was retrieved into agent context this round (F8 propagation); no agent distillation means the corpus only grows at merge time.
- Multi-team scoping verified: company sees its 5–6 entries; instance total 261 across teams; global layer (27 entries) accessible read-only.

## UI visibility (human-gate experience)

Worked: live runs, issue transitions, kanban states, run pages, "Let agents fix" opt-in. Failed: silent wake loss (F5 — nothing on the issue), `awaiting_user` absent from sidebar badges & inbox (F10), stale inbox PR-feedback cards (F7), stale "PR ready — merge" approval cards after merge (F14), dashboard merge blocked for staging-default repos forcing out-of-band merges (F8→F13).

## Fix list

14 findings (12 active; #12 corrected, qa-engineer doc cleared) in **`findings.md`** alongside this report. Priority order for hand-off readiness:
1. **F5** wake loss: re-deliver missed wakes on agent resume; surface failures on the issue.
2. **F6** passdown bypass: fix combyne SKILL.md Step 9 → `/issues/:id/delegate`, and/or build passdown on any assigned subtask create.
3. **F13+F8** merges: configurable merge-allowed base branches; background reconcile poller/webhook for external merges.
4. **F9** artifact gate: cross-check git/GitHub state before declaring no-artifact.
5. **F7/F10/F14** notification hygiene: auto-resolve inbox/approval cards; `awaiting_user` sidebar badge + inbox notification.
6. **F11** verification: JDK 11/17 on host or CI on mirrors — without this, "tests pass" is unverifiable everywhere.
7. **F2/F3/F4** doc fixes (premature parent closure, IC example skipping PR gate, merge-endpoint row in quick reference).
8. **F1** covered by F13's poller. **F12** residual: skip opt-in wake when zero feedback pending.

## Artifacts
`findings.md` · `pr2-code-review.md` · `pr2-diff.patch` · `timeline.log` · `baseline-*.{json,txt}` — all under `logs/e2e-run-2026-06-10/`.
