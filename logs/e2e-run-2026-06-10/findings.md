# Findings log (fix after testing completes)

## Finding #1 — Stale PR tracking state
PINB405-9's PR (fs-bnpl-service-test#2) was merged on GitHub 2026-06-09T09:31Z but ADE tracking still showed state=open/mergeStatus=pending a day later. No background reconcile job; manual POST /api/issue-pull-requests/:id/reconcile fixed it. Issue also sat in_review although its PR was merged.

## Finding #2 — Docs teach premature parent closure (user-reported)
skills/combyne/references/api-reference.md, Manager heartbeat worked example (~line 194-200): step 6 creates subtasks then immediately `PATCH /api/issues/issue-30 { "status": "done" }`. Conflicts with server policy and desired EM behavior: parent must stay open (in_progress) until children complete. Fix: example should leave parent in_progress with a delegation comment, and close only on a children-complete wake.

## Finding #3 — IC heartbeat example skips the PR/review gate
skills/combyne/references/api-reference.md ~line 122-150 (Worked Example: IC Heartbeat): a *coding* task ("Fix rate limiter bug", step 4 "write code, run tests") goes straight in_progress -> done with no branch/PR/in_review step. Contradicts SKILL.md GitHub workflow (engineer code work must end at in_review with a tracked PR; board merges; "do not close the issue as done yourself"). Fix: make the IC example a code task that ends with PR tracking + in_review, or switch it to a clearly non-code task.

## Finding #4 — Quick-reference table offers agents a merge endpoint
skills/combyne/SKILL.md line ~473 (Key Endpoints table): "GitHub: merge PR | PUT /api/companies/:companyId/integrations/github/repos/:repo/pulls/:number/merge" is listed as an available action, directly contradicting line 221 ("Agents must never merge pull requests") and the proxy table ("Merge PR | Board/dashboard only"). Fix: remove the row or mark it board-only.

## Finding #5 — Silent wake loss when assignee is paused at issue-create (HIGH)
Creating PINB405-12 while the EM was paused (UI pause toggle) produced only a server-side WARN: enqueueWakeup 409 "Agent is not invokable in its current state" (heartbeat.ts ~6891, issues.ts wake-on-create). The create API still returned 201; nothing surfaced on the issue or UI; resume did NOT re-deliver the missed wake. The assigned todo ticket sat indefinitely until a manual /agents/:id/wakeup. Fix candidates: on agent resume, scan for assigned todo/in_progress issues with missed wakes (or persist pending wakeups); surface failed wakes on the issue timeline.

## Finding #6 — EM delegation bypasses the central-DB passdown rail (HIGH)
EM created subtask PINB405-13 via plain POST /companies/:companyId/issues (server log 04:44:05) instead of POST /issues/:id/delegate. Only the delegate endpoint awaits createHandoff() -> buildPassdownPacket() (agent-handoff.ts:170-200, issues.ts:1374-1387), so NO agent_handoffs row and NO vetted passdown packet was produced (verified: agent_handoffs count=0 for issue 0f7835b5). Root cause: skills/combyne/SKILL.md Step 9 explicitly teaches "Create subtasks with POST /api/companies/{companyId}/issues" — the path that skips the PR-9 context rail. Fix candidates: (a) update the skill to teach /issues/:id/delegate for assigned subtasks, and/or (b) make plain issue-create with parentId+assigneeAgentId also build the passdown packet server-side.

## Finding #7 — Inbox notification persists after PR merge + issue closure (user-reported)
Screenshot 2026-06-10 11:43: the "PR feedback for krish-buku/fs-bnpl-service-test#2" inbox notification remains visible after the PR was merged (2026-06-09), the tracking row was reconciled to merged, and the issue was closed done. No auto-dismiss/auto-read when the underlying PR/issue resolves. Fix: clear or mark-resolved inbox items when their source PR merges or issue closes.

## Finding #8 — PR feedback generated from stale state + base-branch allowlist flags staging
The same feedback body asserts "PR is not open (closed)" for a PR that was actually MERGED, and "Base branch staging is not merge-allowed" although staging IS the default branch (origin/HEAD) of both *-test mirrors. Two sub-issues: (a) feedback composer reads stale tracking state (merged misread as closed; related to Finding #1's missing background reconcile); (b) merge-allowed base-branch config appears hardcoded to main/master — staging-default repos get spurious blocking items. Same wrong note was distilled into central-DB memory entry d3ac602c (baseline), so stale state is propagating into the context DB.

## Finding #9 — Progress gate misses real artifacts (pushed branch + open PR) and triggers a wasteful re-run loop
Backend-1's first run on PINB405-13 (87af846d, 8.7min, 26.8k output tokens) produced a pushed branch AND an open GitHub PR (fs-brick-service-test#2, created in the run's final seconds) — but exited without POSTing PR tracking, setting in_review, or commenting. The server's no-verifiable-artifact gate checks only self-reported signals (tracked PR rows / reported changed files), so it flagged a successful run as artifact-less, moved the issue to awaiting_user, and the EM automation re-queued it (new Backend-1 run ce5ef2bb) — duplicate-work risk + token waste. Two facets: (a) agent dropped the workflow tail (likely turn budget exhausted mid-workflow); (b) gate should cross-check git/GitHub state (workspace branches, open PRs by head branch) before declaring no artifact. Also: no execution_workspaces row — agent worked directly in the shared parent clone (multi-repo worktree isolation never engaged; single-engineer case so no collision this round, but parallel rounds would conflict).

## Finding #10 — awaiting_user is invisible at the notification level (user-reported)
When PINB405-13 went awaiting_user (11:52:52), nothing surfaced: GET /companies/:id/sidebar-badges returns only {inbox, approvals, failedRuns, joinRequests, memory} — no awaiting-user/needs-response count — and no inbox item is generated for the transition. The UI has a per-row IssueNeedsResponseBadge + status colors, but you only see it if already on the issues list. Compounding: EM automation re-queued the issue ~80s later, so the state vanished before a human could notice. Fix: add awaiting_user count to sidebar-badges (side tab), generate an inbox notification on awaiting_user transitions, and consider whether EM auto-requeue should leave a visible trace for the board.

## Finding #11 — Java toolchain gap blocks local test verification (environment)
fs-brick-service-test needs Gradle 7.4-compatible Java (8-17); host has only Homebrew OpenJDK 25 -> `./gradlew test` fails to start (same incompatibility the agent reported on PINB405-9: "spotlessApply skipped locally"). Consequence: neither agents nor reviewers can run Java tests locally, and the test mirrors have ciStatus=unknown (no CI configured), so NO automated verification exists anywhere in the loop for Java code. Fix: install JDK 11/17 on the host (or configure Gradle toolchains + org.gradle.java.home), and/or enable CI on the *-test mirrors.

## Finding #12 — Automation wake churn on in_review issues (minor)
12:04: automation/system woke Backend-1 on PINB405-13 although the issue was in_review with a tracked PR and zero new context since 04:53. The run was a correct 20s no-op (no comment, no git change), but the wake itself is wasted budget. The skill's blocked-task dedup rule prevents exactly this for blocked issues; in_review needs the same guard (don't wake the assignee absent new comments/feedback opt-in/merge).

## Finding #12 — CORRECTION
The 12:04 Backend-1 wake was the feedback-opt-in ("Let agents fix") wake, not random churn — and the no-op was CORRECT behavior since the human approved instead of requesting changes. Residual minor point: an opt-in with zero pending feedback could skip the wake server-side.

## Finding #13 — Out-of-band GitHub merges strand the pipeline (HIGH, ties #1+#8)
User merged fs-brick-service-test#2 directly on GitHub (05:04:38Z; no /issue-pull-requests/:id/merge call in server log) — likely FORCED to, because the dashboard merge gate rejects base branch `staging` (Finding #8) even though staging is the repo's default branch. Consequences of any out-of-band merge: tracking row stays open/pending, issue stays in_review indefinitely, no pr-approval memory entry, no agent wake — the exact stale-state pattern of Finding #1, now reproduced live. Fixes: (a) make merge-allowed base branches configurable per repo/workspace (staging-default repos exist); (b) background reconcile poller or GitHub webhook so external merges are detected; (c) reconcile endpoint should also drive downstream effects (close issue / wake / memory), not just the tracking row.

## Finding #14 — merge_pr approval cards never resolve after merge (user-reported)
Screenshot 12:06: "Approvals needing action" still shows "PR ready — open & merge in PR panel" cards as Pending for fs-brick-service-test#2 (merged 12:04, reconciled, issue done) and for yesterday's fs-bnpl PRs. API confirms 3 pending merge_pr approvals all pointing at resolved work (issue 8708ef4a). Reconcile/merge does not resolve the linked approval, so the approvals queue and its sidebar badge accumulate stale action items. Fix: resolve/auto-approve merge_pr approvals when their PR reaches merged (incl. via reconcile), and backfill-clean existing stale ones.

## Finding #15 — Server restart orphans queued/in-flight agent runs without auto-requeue (round 2)
A tsx-watch hot reload mid-round marked both in-flight Backend-1 runs interrupted_recoverable ("Process lost — server may have restarted"); the QUEUED run (T2) never started and nothing requeued it — the issue sat in_progress with no run until a manual wake. Fix candidate: on boot (or in the orphan reaper), requeue interrupted_recoverable runs / re-wake their agents. Operational lesson recorded: don't hot-edit server code while agent runs are in flight.

## Finding #16 — Dashboard merge button permanently disabled on CI-less repos (user-reported, round 2)
IssueDetail's canMerge re-derived the merge gates client-side and required ciStatus==="passed" — on repos with no CI, ciStatus is forever "unknown", so the Merge button never enabled even when the server's mergeStatus was "ready" (zero blockers). This is what forced the human to merge on GitHub in BOTH rounds (compounding F13). Fixed: the UI now trusts the server verdict (mergeStatus==="ready" + approvalId + headSha); merge() re-validates server-side regardless.

## Finding #17 — "Run needs review" banner without an actionable question (user-reported, round 2)
When a child hits in_review, the EM's parent follow-up can park the parent in awaiting_user with a SYSTEM digest (no structured question). The UI banner then reads "No clear question was captured…" — technically true, but it gives the operator nothing to act on and reads as if the agent is stuck. Fix candidates: (a) don't park the parent in awaiting_user for the child-in-review checkpoint when there is no question (keep in_progress + comment); (b) banner copy should say what actually happens next ("agent will resume automatically after the child resolves").

## Finding #18 — Delegation is not idempotent: EM retry created duplicate subtasks (round 2)
T3 delegation produced PINB405-19 AND PINB405-20 — identical title/assignee/parent ~20s apart (a retried delegate call after a slow/ambiguous first response). Both woke the engineer; board cancelled one manually. Fix: idempotency on the delegate endpoint (e.g. reject/return-existing when an open subtask with the same parentId+title+assignee exists, or accept an Idempotency-Key from the EM skill flow).

## Round-2 recall observation (T3)
The PINB405-20 packet carried Pefindo + the two bnpl pattern entries but NOT the repayment-intent human answer — the EM's subtask rewrite dropped the repayment-intent vocabulary, so ranking was fair on the actual query text. The curated-pin path (EM pinning a known-critical entry) is the designed remedy; noted as corpus/usage guidance rather than a logic bug. Both earlier probes (T1 post-fix, T2) recalled their target entries correctly.

## Finding #19 — Single GitHub identity blocks the formal request-changes flow (round 2)
The deployment uses one PAT for both agent pushes and board actions, and GitHub forbids "Request changes" on your own PR — so the reviewStatus=changes_requested → held-feedback → "Let agents fix" path cannot fire in single-account setups. Recommend documenting a second reviewer identity (separate PAT or GitHub App) for teams that want formal review gating; the ADE-native equivalent (board comment + @mention wake) covers the fix-push loop otherwise.

## Finding #20 — Stale "error" status badge during an actively-running agent (user-reported, round 2)
Backend-1's status stayed "error" (set when the hot-reload orphaned its runs) for minutes while a new run was visibly executing — run-start does not clear a stale error status; a later checkpoint eventually flips it to running. Operator-facing confusion: the header badge says error while Live Run shows running. Fix (queued for the post-round batch with #15): clear/replace agent.status=error when a run actually starts executing for that agent.

## Finding #21 — Merge allowed while the agent is actively revising the PR (user-designed probe, round 2)
User merged PR #4 mid-fix (agent woken by review feedback, fix run in flight). Result: the merge shipped WITHOUT the requested fix — staging lacks the restored global handlers; the agent's subsequent push dangles on a merged branch. Fix (user's rule, queued): while the tracked issue is in_progress with an active assignee run post-feedback, reconcile adds an "agent actively revising" blocker (mergeStatus leaves ready, dashboard button disables); cleared when the issue returns to in_review via an updated push OR an explicit no-change-needed comment.

## Finding #22 — Dashboard agents strip showed "No recent agent runs" during a live run (user-reported, round 2)
ActiveAgentsPanel's live-runs query had no refetchInterval and depended solely on websocket invalidation; after navigation the WS can be mid-reconnect, leaving stale "no runs" while the sidebar showed 1 live. Fixed: 5s poll (issue-page tier).

## Finding #23 — Issue auto-closed while its follow-up fix PR was still open (round 2)
PINB405-20 flipped in_review→done at 16:51 while tracked PR #5 (the stranded-fix follow-up) was OPEN and ready. The B3 open-sibling guard protects closeMergedTrackedIssue, but at least one close path bypassed it — and the status transition wrote NO activity-log entry, making attribution impossible. Fix batch items: (a) move the open-sibling guard into issuesSvc.update for system-actor done-transitions on issues with open tracked PRs (single chokepoint instead of per-path), (b) log an activity entry for every system-driven status transition.

## Finding #24 — Cross-DB FK violation: accepted_work_events.memory_entry_id references local memory_entries while entries live on the central DB (round 2)
PostgresError 23503 at ~16:51: insert on accepted_work_events failed because memory_entry_id (created on the SHARED context DB) is not present in the LOCAL ops-DB memory_entries table the FK points to. In split-DB mode this FK can never hold for centrally-stored entries. Fix: drop the FK (keep the column as a soft reference) or validate existence app-side against the active memory rail.

## Finding #25 — Central context DB outage stalls agent runs pre-spawn; no timeout/degradation (round 2, HIGH)
TCP to the shared rail (34.171.242.104:5432) became unreachable mid-round. Agent wakes then hung BEFORE adapter spawn (no run log at all) on central-DB memory retrieval, hit the 5-min orphan reaper, and automation re-woke them — an EM reap-loop burning tokens until the board paused the agent. The /api/instance/context-database health endpoint also hangs. Fix: statement/connect timeouts on the context-DB pool + degrade recall to local/empty with a warning instead of blocking the run; health endpoint must time-bound its probe.

## Finding #26 — Ready-to-merge PR not surfaced in the Inbox (user-reported, round 2)
A tracked PR with mergeStatus=ready (approval pending) did not appear in the Inbox as an action item; the user had to know to open the issue's PR panel. The merge_pr approval should render in the Inbox approvals section (it counts in badges) — verify the Inbox approvals list includes merge_pr cards with a deep link to the PR panel, and add a "Ready to merge" row type if approvals are filtered.

## Finding #27 — Review-feedback fix dropped during rebase; failing tests merged with no CI to catch it (round 2, HIGH)
PR #5's final content lost commit 7cee9a4 (the requested global-handler restore) during the agent's rebase amid the outage/reap chaos; it merged only regression tests that now FAIL against staging (the global advice lacks the 3 handlers; UserLimitNotFoundException has no @ResponseStatus). Without CI on the mirror, nothing flagged it. Compounds F11 (enable CI) and #21 (merge gate); also argues for the artifact gate verifying "requested change present" on fix-PRs (diff must touch the file named in feedback).
