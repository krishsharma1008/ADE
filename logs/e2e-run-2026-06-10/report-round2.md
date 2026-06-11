# E2E Round 2 — Report (2026-06-10 → 06-11)

Round 2 ran three graduated tickets through the fixed build (post round-1 fixes + WS-A…E),
with the user probing live (merging mid-fix, watching badges, checking the inbox).
Effort level: xhigh. Everything observable on the UI; user merged all PRs.

## Ticket outcomes

| Ticket | Complexity | Outcome |
|---|---|---|
| T1 PINB405-16 — PefindoAdapter cleanup (fs-brick) | small | **Fully autonomous.** EM delegated with a recall-correct passdown, Backend-1 implemented, PR #3 tracked, issue in_review; user merged; issue auto-closed; verified pr-approval memory captured. Zero manual intervention. |
| T2 PINB405-17 — 2FA audit trail + PIN status endpoint (fs-bnpl) | medium | **One-click.** Same flow; dashboard merge (button fixed by #16); human-decided memory capture with decision note. |
| T3 PINB405-18/-20 — BmuLoan unified error envelope (fs-brick) | medium-large + chaos probes | **Recovered.** This ticket absorbed every probe and infrastructure failure (below) and still landed: fix-forward PR #6 merged from the dashboard on 06-10 19:22, staging handlers restored, issue done, verified memory captured, EM woken with the accepted-work brief. |

## Memory/context recall (a round-2 design goal)

- **Scoped recall bug found & fixed live:** scoped retrieval silently excluded
  company-wide (`service_scope IS NULL`) entries — the highest-trust human answers.
  Both retrieval paths fixed; regression test `memory-scope-recall.test.ts`.
- **Small-tier passdown starvation found & fixed live:** `small` tier read only the
  `shared` layer and served stale global copies (reproduced on the PINB405-16 packet).
  Tier now reads `shared+workspace`; `em-passdown` test extended.
- **Memory-informed delegation observed:** EM's T3 delegation cited prior work —
  "Backend-1 … authored the original … ensuring pattern continuity."
- T3 packet correctly ranked Pefindo + bnpl pattern entries; the repayment-intent
  human answer was not recalled because the EM's rewrite dropped that vocabulary —
  corpus/usage note, not a logic bug (curated-pin is the designed remedy).

## Findings #15–#27 — resolution

| # | Finding | Resolution |
|---|---|---|
| 15 | Server restart orphans runs, nothing requeues | **Fixed + tested.** Reaper re-delivers interrupted runs (wake carries the original context); 3-strikes/15-min loop guard pauses retries and marks the agent error. `reaper-redelivery.test.ts`. |
| 16 | Merge button never enabled on CI-less repos | **Fixed + live-verified.** UI trusts server `mergeStatus`; both round-2 dashboard merges used it. |
| 17 | "Run needs review" banner with no actionable question | **Documented** (banner copy / parent-parking behavior); low risk, deferred with owner. |
| 18 | EM retry created duplicate subtasks (PINB405-19/-20) | **Fixed + tested.** Natural-key dedup guards on delegate AND generic create; retry returns the existing subtask (`deduplicated: true`). Delegate-route tests added. |
| 19 | Single GitHub identity blocks formal request-changes | **Documented** in DEVELOPER_SETUP (second reviewer identity); ADE-native board-comment loop verified as the fallback. |
| 20 | Stale agent status (error/running) survives restarts | **Fixed.** Boot resets stranded `running` agents before the reaper pass; run start sets `running` (clears stale error). |
| 21 | Merge allowed while agent actively revising (user probe — stranded fix commit) | **Fixed + tested.** `reconcile()` gates the merge while the tracked issue is back `in_progress`; unlocks on return to review (updated PR or no-change reply). Gate is merge-only — a new `agentBlockers` field keeps it out of agent feedback. |
| 22 | Dashboard agents strip showed "No recent agent runs" during a live run | **Fixed + live-verified** (5s poll). |
| 23 | Issue auto-closed while its fix PR was open; no attribution | **Fixed + tested + live-verified.** Single chokepoint in `issueService.update`: non-human done-transitions refused while a tracked PR is open (system comment + activity entry); unattributed status changes are stamped (`issue.status_changed`) — today's close of PINB405-20 is fully attributed in the activity log. Companion: successful runs with an OPEN tracked PR now hand off to `in_review` instead of closing past the merge gate. |
| 24 | Cross-DB FK violation on accepted_work_events.memory_entry_id | **Fixed.** Migration 0062 drops the FK (column stays a logical reference, 0053 convention); applied live. |
| 25 | Central-DB outage hung runs pre-spawn (no run log), reap loop burned tokens | **Fixed + tested.** Client-side deadline (20s, env-tunable) on every rail call; on timeout the pool is evicted and health flips to unreachable; runs fail fast and #15 re-delivers. UI run-log empty state now explains never-spawned runs and shows the run error. `context-db-deadline.test.ts`. |
| 26 | Ready-to-merge PR missing from Inbox | **Root-caused, fixed + tested + live-verified.** The F14 dangling-approval resolver auto-approved the LIVE sibling PR's approval on multi-PR issues (PR #6's approval died 46s after creation), hiding the card AND bricking the dashboard merge. Resolver now skips approvals attached to open tracked PRs; reconcile self-heals machine-decided approvals (human decisions never touched). Live: PR #6's approval self-healed to pending, the inbox card appeared, the merge button enabled, and the user merged from the dashboard. |
| 27 | Rebase dropped the requested fix; failing tests merged (no CI) | **Fixed forward + merged.** Cherry-pick branch restored the global handlers + corrected the flawed test (9/9 green); PR #6 merged 06-10 19:22 — staging is healthy. Systemic mitigations: #21 merge gate + F11 recommendation (enable CI on mirrors). |

Earlier findings F1–F14 were all fixed with tests in the post-round-1 batch (see report.md / audit-report.md).

## Live close-out evidence (06-10 evening)

- PR #6 approval: `pending → user merged from dashboard → approved` with decision note
  "Merged from Combyne dashboard after server-side checks passed" — captured as a
  **verified** pr-approval memory entry on the central DB.
- Activity log: `issue.status_changed in_review→done (system/issue-service)` — the
  attribution gap that made finding #23 undiagnosable is closed.
- Central context rail recovered (265 entries, health probe OK); EM resumed — the
  resume rescan immediately redelivered the missed accepted-work wake (F5 fix working).

## Goal-set verdict

> "Human engineers add the tickets and they all get resolved with high quality
> automatically — all small/medium tasks at least."

- **Small (T1): met.** Zero-touch from ticket to merged PR; only the merge itself is
  human (by design — the trust spine requires it).
- **Medium (T2): met.** One dashboard click; context captured to the shared rail.
- **Stress case (T3): resilient.** Duplicate delegation, a mid-fix merge, a server
  reload, a central-DB outage, and a dropped rebase all hit one ticket; every failure
  produced a now-tested fix, and the ticket still landed correct code on staging.
- Residual risks for production hand-off: enable CI on the mirrors (F11/#27), use a
  second GitHub identity for formal reviews (#19), keep the audit playbook cadence
  (docs/AUDIT_PLAYBOOK.md).

## Verification gates (this batch)

Full suite 183 files / 1251 tests green; typecheck clean; UI build clean.
New tests: post-round2-fixes (7), reaper-redelivery (2), context-db-deadline (4),
delegate dedup (2), auto-close open-PR handoff (2). Migration 0062 applied live.

*Report written 2026-06-11; covers the round-2 window 2026-06-10T09:00Z → 06-10T19:25Z.*
