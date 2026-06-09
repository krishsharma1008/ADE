# ADE Live-Test Hardening Round — Final Testing Report

**Branch:** `central-db` · **Company:** `b405dc3d` (Lending) · **Repo under test:** `krish-buku/fs-brick-service-test`
**Scope:** End-to-end agentic flow (ticket → EM delegation → engineer implementation → PR → external merge → context capture → retrieval), plus this round's 4 prior fixes, an adversarial re-verification of each, the multi-phase continuation gap, the agent's code output for PR #1, and tool-call efficiency.
**State:** Changes staged in working tree, **not committed** (per rules). All typechecks and relevant suites green (see §7).

---

## 1. Executive Summary & End-to-End Flow Result

The end-to-end ADE flow **worked through the merge, but did not close out**. A real ticket was scoped by the EM, implemented by an engineer, shipped as PR #1, merged on GitHub, and the verified PR-approval memory was captured into the context DB. Where it broke: the merged sub-task **froze in `in_review`** and the EM was **never woken** to evaluate the next phase. This was a *continuation/completion* failure, not a code-correctness or context-capture failure.

| Stage | Result | Notes |
|---|---|---|
| Ticket → EM scoping | **Worked** | EM produced a precise 3534-char handoff on PINB405-4 with exact file paths + line numbers (e.g. `dispatchIntentMode` 148–229). 30 turns / 782s / $0.95. |
| EM → engineer delegation | **Worked** | Backend-1 (IC) picked up the sub-task. |
| Engineer implementation | **Worked, high quality** | 28-turn impl run + a 13-turn cleanup session. Full end-to-end dead-code removal (see §4). |
| PR #1 created + merged | **Worked** | Merged directly on GitHub (merge commit `621bab4`), branch `feat/PINB405-4/deprecate-repayment-intent-add-credit-path`. |
| External-merge reconcile (HOOK 2) | **Partially worked** | Manual `/reconcile` fired, captured the **verified pr-approval** into the context DB. |
| Context capture → retrieval | **Worked** | Verified pr-approval memory landed and is retrievable. |
| **Issue close-out (`in_review`→`done`)** | **FAILED** | HOOK 2 captured memory but never transitioned the issue. PINB405-5 stuck in `in_review`. |
| **Parent/EM completion cascade** | **FAILED (never triggered)** | Cascade is keyed off a child status *change* to `done`, which never happened, so the EM was never woken to evaluate Phase 2/3. |

**Bottom line:** the agentic pipeline is sound up to and including merge + memory capture. The two failures were both downstream of a single asymmetry: the external-merge path did not mirror the in-app merge path's close-out. This round fixes that asymmetry and adds a backstop; the next-phase *initiation* is deliberately left as a human decision (see §5).

---

## 2. Issues Found This Round & Their Fixes

Two classes of work: **(a)** the 4 prior fixes carried into this round (A–D), and **(b)** the continuation/completion fixes implemented now.

### 2a. The 4 prior fixes (adversarially re-verified — verdicts in §3)

| ID | Fix | Commit | Verdict |
|---|---|---|---|
| A | Issue lookup by identifier (`getById` accepts uuid-or-identifier; regex widened to `/^[A-Z0-9]+-\d+$/i`) | `691bf80` | **Incomplete** (live 500 on plan routes) |
| B | Q&A capture: under a question-section header, a line counts as a question if it *contains* `?` (not only ends-with) | `e3469cf` | **Buggy** (false positives) |
| C | UI "review in progress" cyan banner on the PR card | `933be63` | **Incomplete** (scope mismatch + duplication) |
| D | GitHub integration configured for Lending so reconcile can poll + run HOOK 2 | (config) | **Incomplete** (reconcile not autonomous) |

### 2b. Continuation/completion fixes implemented this round

The primary fix and the carry-forward fixes for A, B, C were all implemented this round in the working tree:

- **Primary (continuation gap):** `server/src/services/issue-pull-requests.ts` — external-merge reconcile now (1) closes the issue to `done` via `issueService.update()` (which auto-fires the parent-wake cascade) and (2) records accepted-work + wakes the EM — both reachable **without an active heartbeat**. Plus a **backstop sweeper** `sweepMergedOpenIssues()` for already-merged-but-open issues. *Verified present in source:* `closeMergedTrackedIssue` (line 252), `recordExternalMergeAcceptedWork` (line 202), `sweepMergedOpenIssues` (line 674, wired into `dispatchFeedbackForCompany` at line 732, exported at line 991). Detail in §5.
- **Fix A carry-forward:** `server/src/routes/issue-plans.ts` — all `planSvc` calls use the resolved UUID `issue.id` instead of the raw identifier. **Live-verified:** `GET /api/issues/PINB405-3/plan` now returns `404 {"error":"No plan found for this issue"}` instead of **500**.
- **Fix B carry-forward:** `packages/shared/src/agent-question-parser.ts` — new `hasSentenceQuestion(line)` helper: a mid-line `?` counts only when sentence-terminating (followed by whitespace/end), **not** inside a URL query string (`://…?`), and **not** inside an unclosed `(`. Rejects the confirmed false positives; still captures the real EM escalation.
- **Fix C carry-forward:** `ui/src/pages/IssueDetail.tsx` — banner copy softened to issue-scoped neutral text; rendered once (`prIndex === 0`) to stop per-PR duplication; amber "agents are holding" banner no longer suppressed by `hasLiveRuns` (so the two no longer contradict).

---

## 3. Adversarial Fix-Verification Verdicts

Honest verdicts on the 4 prior fixes **as they shipped** (the carry-forward remediation above is separate and lands this round).

### Fix A — issue lookup by identifier → **INCOMPLETE (live-confirmed 500)**
- **Confirmed break:** `GET /api/issues/PINB405-3/plan` returned **HTTP 500**. `issue-plans.ts` passes the **raw identifier** to `planSvc.getPlan(issueId)` / `createPlan({issueId})` etc. `issuePlans.issueId` is `uuid NOT NULL`, so Postgres throws `invalid input syntax for type uuid`. The commit's claim that "every caller is robust regardless of prefix" was **false** — `issue-plans.ts` had zero identifier handling. Affects `GET/POST/submit/approve/reject /issues/:issueId/plan` for any identifier caller (e.g. the EM creating the 3-phase plan via identifier). POST would even try to INSERT a non-uuid into a uuid FK column.
- **Mitigating:** `IssueDetail.tsx` passes the already-resolved `issue.id` to `<PlanEditor>`, so the UI page itself did **not** hit the 500 — only agents/direct API callers.
- **Lower-confidence latent gap (not closed):** `documents` service (`listIssueDocuments`/`getIssueDocumentByKey`) is UUID-only; its HTTP routes are plugin-served and not in `server/src/routes`, so identifier resolution there is **unconfirmed**. Flagged for audit.
- **Status now:** remediated this round (resolved UUID used everywhere) and **live re-verified to return 404, not 500**.

### Fix B — Q&A capture "contains `?`" → **BUGGY (false positives, empirically reproduced)**
- Running the parser on crafted inputs confirmed false positives under a `## Open questions` header:
  - URL query string: `- Check the schema at https://api.example.com/v1/intent?fields=id,status …` → wrongly captured.
  - Parenthetical aside: `- We removed the legacy endpoint (was it ever called? unclear from logs) …` → wrongly captured.
  - Inline note: `- Migration ran clean; rollback tested? yes, verified on staging.` → wrongly captured.
  - Multi-question section: a real question is captured (good) but `- Done: dropped FK (was it referenced anywhere? no).` is **also** captured as a spurious second question.
- **True positive still works:** the real EM escalation (`…no longer calling the repayment intent endpoints (POST /repayment/intent)? …`) is correctly captured. The **header-less fallback** stayed strict on `endsWith('?')` and is sound.
- **Impact:** noisy escalations could spawn junk question-comments, push an issue to `awaiting_user` on a non-question, and consume the `maxQuestions=10` budget, crowding out real questions.
- **Status now:** remediated this round via `hasSentenceQuestion`. Residual: the genuinely ambiguous `rollback tested? yes` case remains hard to disambiguate without NLP — **accepted residual risk**.

### Fix C — UI "review in progress" banner → **INCOMPLETE (scope mismatch, duplication, inverted message)**
- **Scope mismatch (most likely real-world misfire):** `hasLiveRuns` is true for **any** active run on the issue, but the banner copy hard-asserts the agent is "addressing the requested review/changes … then Merge unlocks." If the run is actually Phase 2 implementation or answering a manager question, the user is told their review feedback is being addressed when it is not.
- **Per-PR duplication:** banner rendered inside `pullRequests.map(...)`, so with multiple PRs the identical "working on THIS PR right now" banner shows on every card, though the agent works on at most one.
- **`awaiting_human` inversion:** the amber "agents are holding" banner is suppressed when `hasLiveRuns`; if an **unrelated** run is active, the user sees "agent is addressing your review" — the opposite of reality.
- **Non-issue verified:** `agentName` is reliably present (server join + non-optional TS types + `?? 'An agent'` fallback).
- **Status now:** remediated this round — copy neutral/issue-scoped, rendered once, amber banner no longer inverted.

### Fix D — GitHub integration for Lending → **INCOMPLETE (reconcile is not autonomous)**
- **Root of observed gap (2):** the verified HOOK 2 capture lives **inside** `reconcile()`, which is only called from `sendFeedback()` and `merge()`. **No standalone periodic reconcile loop exists** (`grep` of `index.ts` `setInterval` blocks shows no PR reconcile timer). With heartbeats **OFF**, nothing reconciles until an agent is manually woken or the user clicks Refresh. Fix D made *manual* reconcile work but did not make external-merge capture autonomous.
- **Throttle starvation (even with heartbeats on):** `dispatchFeedbackForCompany` filters out `mergeStatus='merged'`; the feedback path is throttled to once / 2 min per company; the independent accepted-work `maybeReconcileGitHubCompany` path is throttled to **once / 12 hours** and produces an **unverified** agent-claim, not the verified pr-approval.
- **HOOK 2 first-reconcile edge case (still latent):** if a PR is tracked for the **first time** while already merged, `createOrUpdateMergeApproval(updated)` may create the approval and persist `approvalId`, but the in-memory `updated` object is **not refreshed**, so `updated.approvalId` is still null at the HOOK 2 guard — verified capture is **skipped on that poll**. The session worked only because the PR had a pre-existing approval before merge. **This edge case was intentionally NOT fixed** (see §8); the *status close-out + EM wake* now fire regardless of `approvalId`, so the stuck-issue/EM-wake symptoms are covered even on an approval-less first reconcile.
- **Non-issues verified:** token/owner/repoPath resolution is solid (owner `krish-buku`, token present, `enabled=true`); `repoPath` handles both bare repo name and full slug; transition guard `row.mergeStatus !== 'merged'` + `(company, source)` dedup make HOOK 2 capture-once and idempotent against the in-app `merge()` path.
- **Status now:** observed gap (2) closed via the in-line close-out reachable on the manual `/reconcile` route **plus** the `dispatchFeedbackForCompany` backstop sweep — **without** adding an always-on timer (deliberate; see §8).

---

## 4. Agent Code-Output Assessment — PR #1

**Verdict: GOOD.** PR #1 (merge `621bab4`) is correct, safe, and a clean, plan-consistent Phase 1.

**What was removed (8 files, +5 / −812):** end-to-end deletion of the dead repayment-intent consumption chain — the dispatch-service field + intent branch + helpers (`dispatchIntentMode`, `determineAllocableLoanAmount`, `parseDate`, `readAmount`, `findAvailableAmountForDueDate[Optional]`), the orphaned `LAN_REPAYMENT_SCHEDULE_SUCCESS_CODE` constant, all newly-unused imports, the whole `RepaymentIntentConsumptionService` class, `RepaymentIntentQueryService.findConsumableIntent` (interface + impl), the underlying `RepaymentIntentRepository.findConsumableByVirtualAccountForUpdate` query, and all corresponding tests (deleted/updated, mocks + `verifyNoInteractions` cleaned, a test renamed to match new behavior).

| Dimension | Finding |
|---|---|
| Correctness | Removal is clean and self-consistent. Behavior change is purely elimination of the intent-mode branch, which always fell through to `dispatchDueMode` when no consumable intent existed. |
| Safety (checked out `621bab4`, grepped tree) | **Zero dangling references** in main **or** test sources to any removed symbol. Production entry `dispatchForBorrowerCallback` still wired (called by `EscrowCreditService`, 2 sites). Remaining `getLanRepaymentSchedule` hits belong to unrelated legitimate callers — no collateral damage. |
| Completeness | Phase 1 complete and slightly broader-than-minimal in a good way — left **no dead code on the consumption side**. |
| Phase boundary | Producer side (`RepaymentIntentRegistrationServiceImpl` still writes `PENDING`) and entity consumed-state fields / `CONSUMED` enum are **intentionally** left for Phases 2/3 — dormant (no writer now) but harmless. Correct scope, not a gap. |

**Findings / caveats:**
- **Task-text typo (not a defect):** the class is `VeefinAddCreditDispatchService`, not "VerifyAddCreditDispatchService" — same class; the diff targeted it correctly.
- **Risk — build not run:** a full Gradle compile/test was **NOT** executed (sandbox has only JDK 25, no verified wrapper/network). "Compiles" is asserted via exhaustive static reference analysis on the merged tree, **not** a green build. **CI is the final word.**
- **Product risk (intended, not a code defect):** with the consumption branch gone, any `RepaymentIntentEntity` rows still written `PENDING` will **never** be consumed/transitioned to `CONSUMED`; intent-mode per-loan allocation is skipped and all payments go through due/customer-mode. This is the intended deprecation effect and is exactly what the EM's FE-readiness escalation gates. `veefin.add-credit.enabled` defaults to **false** — confirm the path was already dark before Phases 2/3 land.

---

## 5. Multi-Phase Continuation — Root Cause, Fix, and the Human Design Decision

### Root cause (three reinforcing failures, one underlying asymmetry)

1. **External-merge reconcile captured memory but never closed the issue.** Two merge paths are **not symmetric**: in-app `merge()` does the full close-out (`issuesSvc.update(..., {status:'done'})` + accepted-work upsert + manager wake). The external-merge HOOK 2 block ran **only** `captureApprovalMemory` + a context-trace write. PINB405-5's PR was merged on GitHub (`621bab4`) and reconciled, so the verified approval landed — but the issue stayed `in_review`. Nothing else closes it: `dispatchFeedbackForCompany` excludes merged PRs; the heartbeat auto-close path only runs at the end of an active run (there was none).
2. **The parent/EM cascade is keyed off the child's status *change*, which the external path never produced.** `notifyParentOnChildStatus` posts a handoff digest and wakes the parent assignee (the EM) — but only for transitions into `{done, blocked, awaiting_user}` and only when the status actually changed, and it is invoked **only** from inside `issueService.update()`. Since the external merge never called `update()`, the cascade **never fired**. It didn't fail — it was never triggered.
3. **The existing EM-wake-on-external-merge poller only runs inside an active heartbeat run, and heartbeats are OFF.** `acceptedWork.reconcileGitHubCompany` → `upsertMergedPull` → `resolveManager` (prefers the **parent** issue's assignee = the EM) → wake exists, but it is embedded in `prepareRunContext` and only executes mid-run. With heartbeats OFF, no run drives it. The manual `/reconcile` route ran reconcile + captured memory but called `dispatchFeedbackToAssignee`, **not** the accepted-work upsert/manager-wake — memory without a wake.

### What was fixed this round (working tree, verified present in source)

- **Close-out + parent-wake on external merge.** In `reconcile()`'s external-merge block, the `&& updated.approvalId` sub-condition was moved so **memory capture** stays gated on `approvalId` but **status close + EM wake** fire on the merged transition regardless. The new `closeMergedTrackedIssue(updated, pr)` (source line 252) calls `issuesSvc.update(issueId, {status:'done'}, {parentNotificationActor:{actorType:'system', actorId:'issue-pr-reconcile'}})` (best-effort `.catch`), which — routing through `issueService.update()` — **auto-fires the parent-wake cascade**, fixing both the stuck-`in_review` and EM-not-woken symptoms.
- **EM wake reachable without a heartbeat.** `recordExternalMergeAcceptedWork(updated, pr)` (source line 202) calls `acceptedWorkSvc.upsertMergedPull(...)` and, when `shouldWakeManager`, wakes `event.managerAgentId` via `heartbeatService.wakeup(reason:'accepted_work_merged_pr')` + `markWakeRequested`. Try/catch wrapped (a wake failure never fails reconcile); idempotent via `(company,repo,pull)` dedup + `wakeupRequestedAt` guard.
- **Backstop sweeper.** `sweepMergedOpenIssues(companyId)` (source line 674) selects `mergeStatus='merged'` PRs whose linked issue is NOT in `(done,cancelled)`, batch-limited to 50, soft-fails per row, runs the same idempotent close-out, and logs `issue_pr.swept_merged_open_issue_to_done` for one-time visibility. Wired first into `dispatchFeedbackForCompany` (line 732, behind `.catch`). This is what remediates the already-merged PINB405-5 **without a manual DB edit**.
- **Tests:** extended external-merge reconcile test (`in_review`→`done`, `completedAt` set, idempotent on re-reconcile); new `external-merge close-out` describe block (full parent/EM scenario: child→done, parent handoff digest, EM woken, accepted-work event with `managerAgentId===EM` + `accepted_work_merged_pr` wake, idempotent); `sweepMergedOpenIssues` closes a pre-merged stuck issue and wakes the EM with **no** GitHub poll. A test-pollution fix targets the memory-write insert spy at the `memoryEntries` table specifically. Parser: 4 new cases (URL, parenthetical, mixed section, balanced-paren-then-`?`).

### ⚠️ THE DESIGN DECISION THE HUMAN MUST MAKE — auto-continue next phase vs. ask first

This round **deliberately stops at "close the child + inform the EM."** It does **NOT** auto-start Phase 2/3. This is a genuine policy choice, not an oversight:

- There is **no** next-phase / sibling auto-advance logic anywhere in the codebase (confirmed). The `notifyParentOnChildStatus` digest already advises the coordinator to "continue the parent workflow / assign the next step," but **whether the EM should auto-start Phase 2/3 vs. ask the human is intentionally not automated.**
- **For PINB405 specifically, auto-continuation would be WRONG:** Phases 2–3 are gated on an FE-readiness question the EM escalated, which is now `awaiting_user`. Auto-kicking off the next phase would bypass a real human gate.

**Recommendation:** keep "wake + inform the EM" (this fix) as the default, and keep next-phase *initiation* a judgment call surfaced to the EM/human. **If** the team wants auto-advance, it should be an **explicit, opt-in "phase plan" feature**, not a side effect of merge detection — and the verification gate (review/QA state before hard-closing) should be applied to **both** merge paths identically rather than diverging. The product owner needs to decide which world ADE should live in before any auto-advance is built.

---

## 6. Tool-Call Efficiency & Ticket/Context Recommendations

**Data source:** Ops Postgres (`heartbeat_runs`: 14 ADE runs for `b405dc3d`; `prompt_budget_json`; `result_json.num_turns`). `agent_terminal_sessions` empty; transcripts are adapter-level only.

**Headline numbers (successful runs):** ~160 turns total, **~$5.51**, ~50 min wall, ~60k output tokens, **~7.0M cached input tokens**. Time is ~100% model/API time (infra overhead 0–9s/run) — **cost is driven by turn count and re-cached input, not latency.** CEO 36+23; EM scoping 30 turns/782s/$0.95; Backend-1 impl 28 turns/167s/$0.60 then a 13-turn/$0.31 session; EM follow-ups 10/7/7/6 turns.

**Where the waste is:**
- **The EM and the engineer each discovered the same code from scratch.** The repayment-intent footprint is large (30 `RepaymentIntent*` files). The EM's 30-turn scope run produced exact file+line pointers — yet Backend-1 spent **28 turns re-walking the same graph** to re-derive them, because the EM's plan was delivered as a plain **comment**, not a first-class injected context section (`focused_small` profile includes only `[issueContextRefs, focus, projects]`, never `coordinator`/EM-plan).
- **No codebase map exists** — only generic Spring boilerplate READMEs. Both EM and engineer paid full cold-start discovery for a 30-file feature.
- **Cross-run prompt cache is never chained:** `previousCachePrefixHash` is **null on all 14 runs**; `cachePrefixHash` changes run-to-run. The ~7M cached tokens were largely paid as **cache writes**, not 90%-discount reads. `cacheHit:true` appears only on same-session resumes.
- **Sessions are keyed per leaf `focusIssueId`:** Backend-1 had two separate sessions (PINB405-4 and PINB405-5), discarding warm exploration when moving to cleanup → partial re-discovery.
- **Failed runs were infra, not agent inefficiency:** the 4 interrupted/cancelled runs carry `process_lost` / "Cancelled by control plane" from this dev session — argues for **resumable/idempotent runs**, not a model problem.
- **Under-specified ticket was costly:** PINB405-3 named the behavior but pointed at no entrypoint. The single most expensive turn-sink (the EM's 30-turn discovery) is exactly what a few file/symbol pointers would eliminate.

**Recommendations (ranked; first two tie directly to "product team writes better tickets"):**

| # | Change | Owner | Expected saving |
|---|---|---|---|
| 1 | **Required "Entry points / Code pointers" ticket field** — at minimum primary class/file + symbol(s) to change (e.g. `VeefinAddCreditDispatchService.dispatchForBorrowerCallback`) + target service. | **Product team / ticket template** | Eliminates the bulk of the EM's 30-turn/$0.95 scope run (~20–25 turns; ~$0.7–0.8 and ~10 min per such ticket). Scales to every well-specified ticket. |
| 2 | **Promote the EM plan to a first-class context section** — store as a structured `implementation_plan` artifact (file/line/symbol) and inject into the engineer's `focused_small` profile, instead of a comment the engineer must re-read + re-verify. | Eng (composer) | Cuts engineer re-discovery ~28 → ~12–15 turns (~half the $0.60 impl run + the 13-turn follow-up) per hand-off. |
| 3 | **Generate a per-project codebase map/manifest** once, kept warm (module tree, service entrypoints, feature→file index), built on clone, refreshed on merge. | Eng | Removes cold-start graph discovery for EM + engineer; est. 8–15 turns saved per agent per ticket on a mapped area. |
| 4 | **Chain the cross-run prompt cache** — emit a deterministic stable prefix (persona + project + codebase-map), pass prior `cachePrefixHash` to hit the 90%-discount read path. | Eng | Converts ~7M write/miss input tokens toward reads; ~30–60% input-token cost cut on repeated short EM follow-up runs. |
| 5 | **Key engineer sessions by issue-tree/parent, not leaf `issueId`; make runs resumable after `process_lost`.** | Eng | Collapses the 13-turn second session toward incremental work; avoids re-discovery after each interruption. |
| 6 | **Phased-workflow state machine** — auto-close the merged sub-task and have the EM ask the user once (single `/ask-user`) whether to start Phase 2, instead of repeated near-no-op heartbeat runs reloading 400–800k cached tokens to conclude "still blocked." | Eng (gated on §5 decision) | Removes 3–4 near-no-op EM runs (6–10 turns, ~$0.5 each) and fixes the governance gaps. **Note: the auto-close half is shipped this round; the auto-`/ask-user` half is gated on the §5 design decision.** |

---

## 7. Verification Gate Results

All commands exited **0**. Working tree, branch `central-db`. (Changed-files set confirmed: 6 files, +539/−50.)

### Typechecks
| Command | Result |
|---|---|
| `pnpm --filter @combyne/server typecheck` (`tsc --noEmit`) | **PASS** |
| `pnpm --filter @combyne/shared typecheck` (`tsc --noEmit`) | **PASS** |
| `pnpm --filter @combyne/ui typecheck` (`tsc -b`) | **PASS** |

### Vitest — server (changed-area suites)
| Command | Result |
|---|---|
| `vitest run issue-pull-requests.test.ts issues-agent-comment-question-extract.test.ts` | **PASS** — 2 files, 13 tests (12 + 1) |
| `vitest run issues-answer-wake / issues-delegate-handoff-race / heartbeat-auto-close / heartbeat-latest-message` | **PASS** — 4 files, 21 tests |

### Vitest — shared
| Command | Result |
|---|---|
| `pnpm --filter @combyne/shared test` | **PASS** — 3 files, 21 tests (incl. `agent-question-parser.test.ts` 11) |

**Total: 55 tests, 0 failures.** The implementation report's broader tally (issue-pull-requests 12/12, parser 11/11, plus accepted-work / parent-notifications / delegation-policy / self-block-sweep / close-cleanup / merge-integration = 104/104) was reported green by the implementer but is **wider than the gate commands re-confirmed above** — treat the 55-test gate as the independently re-run figure and the 104 as implementer-reported. `ERROR` lines in server output (`simulated memory write failure`, `CONNECTION_ENDED`, `Process adapter missing command`) are intentional in-test fault injections / expected teardown noise; every file passed.

**Not verified by any gate:** the Java/Gradle build of PR #1 (sandbox limitation — CI is the final word), and the live HTTP behavior beyond the one `GET /api/issues/PINB405-3/plan` 404 check.

---

## 8. Remaining Follow-Ups & What Still Needs Live Re-Testing

### Intentionally NOT done this round (design/ambiguous or out of surgical scope)
- **No auto-start of Phase 2/3** — left as a human judgment call (see §5). **Requires a product decision before any build.**
- **No standalone autonomous `setInterval` reconcile loop** in `index.ts` (Fix D option 1). The backstop sweep in `dispatchFeedbackForCompany` + the in-line close-out via manual `/reconcile` close observed gap (2) without an always-on GitHub-polling timer, which is a broader ops/autonomy change. **If heartbeats stay OFF long-term, revisit:** without a heartbeat *or* a manual reconcile/dispatch, the backstop sweep still won't run on its own — an always-on timer (or a cron) is the only fully-autonomous option.
- **HOOK 2 first-reconcile `approvalId`-refresh edge case** — left alone. Status close-out + EM wake now fire regardless of `approvalId`, so the stuck-issue/EM-wake symptoms are covered; only the **verified-memory capture** still (correctly) requires the approval to exist on the same poll. A first-time-tracked-already-merged PR will still **skip verified-memory capture on that one poll** and only capture on the next reconcile — a real, knowingly-deferred gap.

### Still-open latent gaps to audit
- **`/issues/:issueId/documents` (plugin-served):** `documents` service is UUID-only; identifier resolution at the route layer is **unconfirmed**. Audit and either resolve identifier→UUID at the route or make the service accept either.
- **`rollback tested? yes` Q&A ambiguity:** accepted residual risk (no NLP); monitor for false positives in real escalations.
- **PR #1 Gradle CI:** must go green before relying on "compiles."

### What needs live re-testing on a fresh ticket (waking the agents)
The fixes are unit-verified but the **end-to-end autonomous close-out has not been re-run live.** A fresh-ticket run should confirm:
1. **External-merge close-out:** merge a PR on GitHub, trigger `/reconcile` (manual, heartbeats OFF), and confirm the sub-task transitions `in_review`→`done`, the parent gets a handoff digest, **and the EM is actually woken** (`accepted_work_merged_pr` wake event present) — the exact path that failed for PINB405-5.
2. **Backstop sweep on the historical case:** confirm `sweepMergedOpenIssues` retroactively closes the already-merged PINB405-5 on the next `dispatchFeedbackForCompany` pass and logs `issue_pr.swept_merged_open_issue_to_done` — i.e. PINB405-5 reaches `done` **without a manual DB edit**.
3. **EM behavior after wake:** verify the woken EM **informs/asks** rather than auto-advancing (the §5 boundary holds in practice), and that PINB405's `awaiting_user` FE-readiness gate is respected.
4. **Fix A live:** an agent/API caller creating a plan **by identifier** (`POST /issues/PINB405-3/plan`) succeeds (not 500) — the GET 404 path is verified; the create/submit/approve/reject paths are code-fixed but not yet live-exercised.
5. **Fix C live:** with a non-feedback run active on an issue that has a PR card, confirm the banner reads issue-scoped/neutral, renders once across multiple PRs, and the amber hold banner is not inverted.