# Deep Pre-Handoff Audit — 2026-06-10

Scope: four parallel sweeps over the bug *class* the E2E round exposed — (1) wake/notification delivery, (2) PR/approval lifecycle consistency, (3) central-DB memory flows, (4) UI state surfacing. Each finding verified in code before being accepted.

## Validation of earlier fixes
- All six "wake swallowed at call site" candidates (answer, mention, delegate, parent-notify, approval-unblock, checkout) are **covered centrally** by the F5 fix: `enqueueWakeup` persists the skipped row for every caller and resume re-delivers. No per-site patches needed.
- "Automated PR feedback blocked by review hold" is **by design** (human-gated "Let agents fix"), not a bug.
- Lifecycle-only transcripts are a design choice (live events + run logs carry streaming); only the UI empty-state wording needed fixing.
- Memory team isolation: **PASS** (assertPinnedCompany on all 27 memory routes; global-layer promotion gated).

## Fixed in this audit batch (11)
| # | Area | Fix |
|---|------|-----|
| B1 (critical) | PR closed WITHOUT merge stranded everything | reconcile now: tracking → `closed` (terminal), approval rejected, system comment, assignee woken |
| B3 (high) | Multi-PR issue closed on first merge | closeMergedTrackedIssue skips issue-close while a sibling tracked PR is open (comment instead); last merge closes |
| B2 (high) | Force-push "head changed" blocker never cleared | reconcile refreshes row.expectedHeadSha while the approval is still pending (decided approvals keep their frozen SHA) |
| B4 (med) | Abandoned PRs burned sweep GitHub calls forever | sweep excludes terminal `closed` rows |
| B5 (med) | Reject/revision never woke the requesting agent | both approval routes now wake `requestedByAgentId` |
| A1 (high) | Company resume lost company-paused wakes | company resume consumes skipped `company.*` rows + wakes each affected/assigned agent once |
| A2 (high) | Usage-pause resume ignored work that arrived while paused | usage resume consumes `agent.not_invokable*` rows + enqueues one rescan wake |
| C2 (critical) | Verified pr-approval memory froze transient blocker text (root cause of the stale d3ac602c entry) | capture body now keeps only durable content: decision note + changes-requested review bodies + accepted pattern |
| C1 (high) | Memory ttlDays never enforced (decay manual-only) | daily decay pass per active company wired into the scheduler tick (`COMBYNE_MEMORY_DECAY_INTERVAL_MS`) |
| C5 (med) | Passdown relevance floor 0.15 let noise into packets | MIN_SCORE raised to 0.25 (matches memory.ts hash-path floor) |
| D1+D5+D7 (high/med/low) | Inbox badge counted awaiting_user but the page never listed them; New-tab count mismatch; misleading transcript empty-state | Inbox "Awaiting Your Input" section + category filter + newItemCount; transcript message clarified |

Tests added: pr-merge-sweep.test.ts +3 (closed-unmerged, multi-PR guard, durable capture body); existing suites re-run green.

## Deferred follow-ups (documented, not blocking handoff)
1. **GitHub rate-limit backoff** (B8): parse X-RateLimit headers, per-company backoff in the sweep. Sweep is already capped (20 rows/company, 5-min cadence, oldest-first) so exposure is bounded.
2. **Verified-entry conflict detection** (C3): listConflicts only groups human-answer entries; extend to verified-vs-verified contradictions.
3. **Outbox visibility** (C4): context-capture outbox depth/poison rows have no badge; add outbox-status endpoint + sidebar surface.
4. **Auto-distill scheduling** (C6): high-reuse facts only promote when a board manually triggers auto-distill.
5. **allowedMergeBases UI editor** (D3): server honors `project_workspaces.metadata.allowedMergeBases`; no UI editor yet (API/config only). Default-branch auto-allow covers the common case.
6. **Usage-pause distinction in UI** (D4/D10): budget-paused agents look identical to manually-paused ones.
7. **Direct human unblock doesn't wake assignee** (A10): PATCH status blocked→in_progress by a user relies on the agent's next scheduled wake.
8. **Re-embed backlog warning** (C7): warn before enabling ANN if >10% of entries await re-embedding.
9. **Live cleanup**: correct/retract stale verified memory entry `d3ac602c` (and the PINB405-9-era notes citing "staging not merge-allowed") via the board memory edit API — scheduled for the round-2 live session.

## WS-D QA sweep (2026-06-10 afternoon, post-WS-A/B/C build)

Swept 17 app pages + all 9 memory tabs on :3100 via the browse daemon.
- **Console**: zero errors at rest on every page. Only artifact: benign "WebSocket closed before connection established" warnings during rapid page-to-page navigation (teardown of the in-flight live-updates socket; zero recurrence during 20s dwell). Cosmetic.
- **Integrations (WS-B live)**: capability checkboxes seed from effective values (read/push/raise ✓, merge ✗), Test shows "REST API verified" + "gh CLI authenticated as krish-buku", save round-trip persists toggles with the stored token untouched, defaults restorable.
- **Model catalog (WS-A live)**: claude_local dropdown serves the new lineup, Fable 5 first.
- **Memory live eval (WS-C checklist)**: all tabs load clean; Confirm→verified→leaves-inbox cross-tab consistency verified; **corrected all 4 stale verified pr-approval entries** (frozen blocker text from the since-fixed capture bug; bodies now record only the durable decision with a correction note); drained the capture inbox (5 confirms); resolved the 4 pending accepted-work events as "ignored" (their pr-approval memory already exists — creating more would duplicate).
- **Ops finding during sweep**: an orphaned older server held :3100 while the fresh stack silently bound :3101 — the UI was serving STALE code (looked like the new features were broken). Killed the orphan, restarted one stack. Lesson for the setup guide: the server logs "Requested port is busy; using next free port" — check for it after restarts.
