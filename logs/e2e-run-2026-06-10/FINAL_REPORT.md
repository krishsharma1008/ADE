# ADE (Combyne) — Final Engagement Report
**Window:** 2026-06-10 → 06-11 · **Company:** Lending (`PINB405`) · **Human gate:** Krish · **Effort:** xhigh

## Executive summary

Two live end-to-end rounds (4 real tickets through board → EM → engineer → PR → human
merge → closure), two deep audits, a full page/flow QA sweep, and a cold-start setup
validation produced **27 findings. All 27 are now fixed-with-test, fixed-and-live-verified,
or documented with an owner** — none open. The final state was proven live: the last
ticket family closed end-to-end through the repaired pipeline, including an EM that
autonomously verified acceptance criteria and closed its parent ticket with zero human
input after recovering from a real central-DB outage.

**Verdict against the goal — "human engineers add the tickets and they get resolved
automatically with high quality, all small/medium tasks at least": MET for small and
medium tickets**, with the human holding exactly one gate (the merge — by design).
Round-1's verdict was "not hand-off ready"; every gap behind that verdict is closed
and regression-tested.

Production hand-off carries two recommendations (not blockers): enable CI on the
repo mirrors (#11/#27 — today local JDK-17 Gradle is the only automated verification)
and add a second GitHub identity if formal request-changes review gating is wanted (#19).

## What was tested

| Activity | Scope |
|---|---|
| Round-1 live E2E | 1 refactor ticket (PINB405-12/-13), full pipeline + context-DB reads/writes |
| Post-round-1 fix batch | F1–F14 fixed across 8 phases, each with tests |
| Deep audits ×2 | Behavioral flows, state machines, idempotency, chaos/restart, identity constraints, oracle probes → methodology codified in `docs/AUDIT_PLAYBOOK.md` |
| Workstreams A–E | Model catalog refresh; agent capability controls (GitHub/Jira, REST+MCP+CLI shim); memory page eval; full UI QA sweep; one-page `docs/DEVELOPER_SETUP.md` validated by an actual cold start (fresh clone → isolated env → boot → join Lending team → green test) |
| Round-2 live E2E | 3 graduated tickets (T1 small / T2 medium / T3 medium-large) + user-designed chaos probes, with recall verification |
| Post-round-2 fix batch | Findings #15–#27 fixed with tests; verified live on the UI and DB |

## Round 1 (PINB405-12 → -13) — recap

The pipeline core worked and self-healed twice, but four high-severity gaps would have
hurt a real team immediately: silent wake loss while paused (F5), EM delegation
bypassing the curated context passdown (F6), out-of-band GitHub merges stranding
pipeline state (F13/F8), and an artifact gate that missed genuinely pushed work (F9) —
all compounded by notification blind spots (F7/F10/F14). Code quality on the produced
PR: 6/7 acceptance items pass, 1 partial (path-segment URL encoding) → follow-up filed.
**All 14 findings fixed with tests** (wake re-delivery on resume, passdown on every
delegation path, per-workspace merge-base allowlist + external-merge sweep + approval
batch-resolve, GitHub artifact cross-check, awaiting-user badges/inbox, doc-lint guard
on the agent skill docs, JDK 17 installed and documented).

## Round 2 (T1/T2/T3) — outcomes

- **T1 PINB405-16 (small, Pefindo cleanup): fully autonomous.** Delegation carried a
  recall-correct passdown; implementation, PR, in_review — zero touch; user merged.
- **T2 PINB405-17 (medium, 2FA audit trail): one click.** Dashboard merge (button fixed
  by #16); human decision note captured into verified memory.
- **T3 PINB405-18/-20 (medium-large, BmuLoan error envelope): the stress case.** It
  absorbed a duplicate delegation (#18), a user-probe merge mid-fix (#21), a dev-server
  reload orphaning runs (#15), a real central-DB outage (#25), and a rebase that dropped
  the requested fix and merged failing tests on a CI-less mirror (#27) — and still
  landed: the agent self-recovered with a fix-forward PR (9/9 tests green under JDK 17),
  the user merged it from the repaired dashboard path, and the resumed EM verified
  acceptance criteria on staging and closed the parent itself (run exit 0, no human input).

### Recall (a round-2 design goal)
Two live recall bugs were found by oracle probes and fixed with regression tests:
scoped retrieval silently dropped company-wide null-scope entries (the highest-trust
human answers), and the small-tier passdown read only the shared layer, serving stale
global copies. Post-fix probes recalled their target entries; the EM's T3 delegation
visibly used memory ("Backend-1 … authored the original … ensuring pattern continuity").

### Findings #15–#27 — all resolved

| # | Finding (short) | Resolution |
|---|---|---|
| 15 | Restart orphans runs, nothing requeues | Fixed+tested — reaper re-delivers with original context; 3-strikes/15-min loop guard |
| 16 | Merge button dead on CI-less repos | Fixed+live-verified — UI trusts server verdict |
| 17 | "Needs review" banner w/o a question | Documented (copy/parking), deferred with owner |
| 18 | EM retry duplicated subtasks | Fixed+tested — natural-key dedup on both delegation paths |
| 19 | Single GitHub identity blocks request-changes | Documented — second identity recommended; board-comment loop verified |
| 20 | Stale agent status across restarts | Fixed — boot reset + run-start status |
| 21 | Merge allowed while agent revising (user probe) | Fixed+tested — merge gate while issue is in_progress; never leaks into agent feedback |
| 22 | Dashboard live-runs strip stale | Fixed+live-verified — 5s poll |
| 23 | Issue closed past open PR; no attribution | Fixed+tested+live-verified — single close chokepoint + activity-log stamping; auto-close hands open-PR issues to in_review |
| 24 | Cross-DB FK violation (accepted work ↔ memory) | Fixed — migration 0062, applied live |
| 25 | Central-DB outage hung runs pre-spawn (no logs) | Fixed+tested — 20s client deadline, pool eviction, fail-fast + re-delivery; run-log UI explains never-spawned runs |
| 26 | Ready-to-merge PR invisible in Inbox | Root-caused+fixed+tested+live-verified — dangling-approval resolver was killing LIVE sibling approvals; now scoped + self-healing. Live: card reappeared, merge unbricked, user merged |
| 27 | Rebase dropped fix; failing tests merged | Fixed forward+merged — staging restored; systemic mitigations #21 + CI recommendation |

## Central context DB — verdict

- **Reads:** every agent wake retrieved scored entries; `requireVerified` held
  throughout (no unverified entry was ever served); service-scope boosting and the two
  recall fixes verified by probes.
- **Writes:** strictly human/system-gated end to end — zero agent-minted entries across
  both rounds; verified entries came only from PR-approval captures and human
  confirmations. Multi-team isolation held (team sees only its rail; global layer read-only).
- **Resilience:** a real mid-round rail outage is now survivable — calls fail fast
  (client deadline), health is surfaced, interrupted work re-delivers, and a loop guard
  stops token burn; on recovery the EM resumed and the missed wakes re-delivered
  automatically (observed live).

## Verification gates

- Full suite: **183 test files / 1251 tests green**; typecheck and UI build clean.
- New regression tests this engagement: ~20 files (wake loss, passdown, allowlist,
  sweep/approvals, artifact cross-check, badges, capabilities/command-guard, recall,
  delegate dedup, revision merge gate, close chokepoint, approval survival/self-heal,
  reaper re-delivery, context deadline, auto-close handoff, capstone lifecycle integration).
- `docs/DEVELOPER_SETUP.md` validated by an actual cold start (two guide errors found
  and fixed during validation). `docs/AUDIT_PLAYBOOK.md` codifies the audit classes
  that the missed findings mapped to, with the "never downgrade without an empirical
  test" rule.

## Remaining recommendations (owners: dev team)

1. **Enable CI on the repo mirrors** — the only finding class that merged bad code
   (#27) had no automated net; local JDK-17 Gradle is currently the only verification.
2. **Second GitHub identity** (PAT or App) if formal request-changes gating is wanted (#19).
3. Banner copy for the no-question review checkpoint (#17, cosmetic).
4. Keep the audit cadence: full class set before each release; classes B+C on any PR
   adding a status value or mutating endpoint.

## Artifact index (`logs/e2e-run-2026-06-10/`)

`report.md` (round-1) · `report-round2.md` (round-2 detail) · `findings.md` (all 27)
· `audit-report.md` · `pr2-code-review.md` + `pr2-diff.patch` · `timeline.log`
· `baseline-*` · this file. Guides: `docs/DEVELOPER_SETUP.md`, `docs/AUDIT_PLAYBOOK.md`.
