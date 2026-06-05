# Improvement Plan — retrieval & agent-behavior fixes (post live-test)

Branch `central-db`. Five phases, each surgical + independently shippable, each keeping the ~866-test
server suite + the retrieval-quality CI gate green. Designed and **adversarially verified** against the
real code (a design workflow caught two unsound items — see "Dropped").

## Dropped after verification (do NOT ship)
- **Global-layer candidate gating** (removing the `OR layer='global'` re-add at `memory.ts:869-871`/`964`):
  would turn **test M2** RED (`memory-service.test.ts:1133` asserts a global row IS returned under
  `layers:[workspace,shared]`) and silently strip org-wide global governance facts from EM passdown
  packets (`PASSDOWN_TIERS` list only shared/workspace). The Phase-1 relevance floor already drops
  irrelevant force-fetched global rows on the real path — the suite-safe expression of the fix.
- **Periodic PR auto-reconcile poller**: redundant. `reconcile()` (incl. the HOOK-2 external-merge
  capture) already runs ~every 2 min via `dispatchFeedbackForCompany`→`sendFeedback`→`reconcile` off
  `heartbeat.ts:4030`. A manual GitHub merge is already captured. (Optional 1-line fairness tweak only.)

---

## Phase 1 — Retrieval relevance floor (real-embedding path only)  ·  `memory.ts`
Stop recency-only / semantically-irrelevant rows (incl. force-fetched global fixtures) from surfacing on
the **real-embedding** path, leaving the hash-64 oracle path (the suite) byte-identical.

**Changes**
- `memory.ts ~184` (by `LAYER_WEIGHT`): add `DEFAULT_MIN_RELEVANCE_SCORE = 0.25`, an `envNumber` helper
  (copy `memory-sufficiency.ts:111-116`), and **exported** `minRelevanceForVersion(version)`:
  `undefined` or `=== HASH_EMBEDDING_VERSION` → `{mode:'signal', floor:0}`; else
  `{mode:'score', floor: envNumber('COMBYNE_MIN_RELEVANCE_SCORE', 0.25)}`.
- `queryRanked`: after `queryEmbedding` is computed (`~1013`), resolve
  `const floor = minRelevanceForVersion(queryEmbedding?.version)` and replace the `~1035` filter with
  `floor.mode==='score' ? r.score >= floor.floor : (r.lexical>0 || r.semantic>0.05)`.
- `~1075`: comment-only — document that `deduped.slice(0,limit)` MUST stay AFTER the floor (so returned
  count is already `min(limit, count-above-floor)`; no code change).
- **Do NOT touch** `869-871`/`955`/`964` (global re-add) — global stays an eligible candidate, now
  competing on score.

**Tests**: hash-path regression (archivedSentinel still surfaces — proves `mode:'signal'` unchanged);
real-embedding floor via the `memoryService(db, fakeEmbedder)` seam (`memory.ts:483`, `embedder.enabled=false`,
entries seeded with `embeddingVersion:'test-real:8'`): relevant row returned, fresh-but-orthogonal noise
EXCLUDED, all-orthogonal corpus → 0 items; pure `minRelevanceForVersion` unit test (`memory-ranker.test.ts`).
**Do NOT** add a "global-not-returned" test (inverse of M2).

---

## Phase 2 — Done-needs-artifact guard for code tickets  ·  `heartbeat.ts`
A code ticket that finishes successfully with **no PR and no changed files** routes to `awaiting_user`
instead of silently auto-closing to `done`.

**Changes**
- `heartbeat.ts ~712`: add optional `requiresArtifact?: boolean` to `autoCloseIssueAfterSuccessfulRun`
  input (default false → backward compatible).
- Insert a guard **after** the `unresolvedQaFeedback` return (`~817`, before `manual_auto_close_disabled`):
  if `requiresArtifact && originKind!=='routine_execution'` and `artifactPresent` is false
  (`changedFiles.length>0` OR a tracked `issuePullRequests` row for the issue) → post a **`kind:'system'`**
  advisory (NOT `'question'` — would trip the open-questions early-return forever), set
  `status:'awaiting_user'` + `latestUserFacingAgentMessage`, `logActivity('issue.auto_close_blocked')`,
  return `{closed:false, reason:'no_artifact'}`.
- Call site `~5882`: `requiresArtifact = resolvedWorkspace.source==='project_primary' || …==='execution_workspace' || Boolean(resolvedWorkspace.projectId) || Boolean(resolvedWorkspace.repoUrl)`; pass it.

**Tests** (`heartbeat-auto-close.test.ts`): A) no artifact → `awaiting_user`, `kind:'system'` advisory,
no "Run completed successfully", comment kind ≠ `question`; B) `changedFiles` → `done`; C) tracked PR row
(seed the NOT-NULL cols) → `done`; D) non-code (no `requiresArtifact`) → `done`; E) `routine_execution`
carve-out → `done`.

---

## Phase 3 — Wake-on-answer + stale self-block sweep  ·  `approvals.ts`, `issues.ts`, `index.ts`
Wake a blocked-on-agent issue when its approval is granted or its board question is answered; auto-clear
a stale free-text agent self-block once its blockers are gone. (Periodic reconcile DROPPED.)

**Changes**
- **Optional fairness tweak**: `issue-pull-requests.ts:573` `asc(updatedAt)` → `asc(lastReconciledAt)`
  (oldest-reconciled PRs fair under the limit-50 cap). 1 line; only residual of the dropped poller.
- **(b1) Approval-grant wake** — `routes/approvals.ts` after the requester-wake (`181-204`), **route-level**
  (not in `approvalService.approve` — circular-import + double-handles in-app merge). For each linked
  issue, re-load via `getById` (the `listIssuesForApproval` projection omits `blockedSource`); if
  `status==='blocked' && blockedSource==='agent'`, clear the block with the exact field set from
  `agent-question-routing.ts:490-501` (raw `db.update`) + wake assignee `reason:'approval_approved'`.
  De-dupe when `assignee===requester` (one wake).
- **(b2) Board-question wake** — `routes/issues.ts ~1088`: sibling branch to the `remaining===0 && awaiting_user`
  block: `else if (status==='blocked' && blockedSource==='agent')` → clear block + wake `reason:'user_responded'`.
- **(c) Stale self-block sweep** — new `reEvaluateStaleAgentSelfBlocks(now)` on the issue service, wired
  into the `index.ts ~899` routine block with its own `lastSelfBlockSweepAt` gate. Select
  `status='blocked', blockedSource='agent', blockedAt > COMBYNE_SELF_BLOCK_REEVAL_MS` (default 30min) and
  **all four** auto-close blocker probes absent (open question/manager_question, open child issues,
  unresolved PR feedback, **unresolved QA feedback** — the input design omitted QA; it is required).
  On clear: same field set + `kind:'system'` comment + wake `reason:'self_block_recovered'`. Inject
  `now`/threshold for deterministic tests.

**Tests**: `approvals-wake.test.ts` (approve → linked agent-self-blocked issue unblocked + assignee woken;
assignee==requester → one wake); issues route (b2: answer a blocked+agent question → unblock + wake; negative
awaiting_user still takes the old branch); `issues.ts` unit (c: stale no-blockers → unblock+comment+wake;
stale with open question OR open QA feedback → untouched; fresh → untouched). Re-use the existing
external-merge idempotency assertion as the reconcile regression anchor (no new reconcile test).

---

## Phase 4 — Global eval-fixture cleanup (operational script)  ·  new script (non-destructive default)
Reversibly remove the leftover embedding-eval-fixture rows polluting the global layer; no ranker code.

**Changes**
- **Prereq**: `embedding-eval-code.ts:19` `const ENTRIES` exports nothing — add
  `export const EVAL_CODE_SUBJECTS = ENTRIES.map(e => e.subject);` (the 14 fixture subjects already export
  as `EVAL_ENTRIES`).
- New `server/scripts/cleanup-global-fixtures.ts` with an **exported** predicate builder
  (`buildFixtureCleanupFilter`/`selectFixtureRows`/`deleteFixtureRows`) over declared drizzle cols only
  (never `embedding_vec`). Predicate: `isNull(companyId) AND layer='global' AND status='active' AND
  subject IN ALLOWLIST AND (source IS NULL OR source NOT LIKE 'global-promotion:%')` — the `(IS NULL OR
  NOT LIKE)` form is required (bare NOT LIKE skips NULL-source rows). ALLOWLIST = `EVAL_ENTRIES ∪
  EVAL_CODE_SUBJECTS` imported from source (30 subjects).
- Flags: `--db` (default `COMBYNE_CONTEXT_DATABASE_URL ?? DATABASE_URL`), `--dry-run` **default true**
  (`--apply` required), `--export <path>` (JSON bundle before delete). One transaction; assert
  `deleted===previewed`; refuse `--apply` if any matched subject is outside the allowlist or count >50.
  `db:cleanup-global-fixtures` script alias. Rollback = `db:memory-import --in <bundle>`.

**Tests** (`cleanup-global-fixtures.test.ts`, startTestDb): seed 4 global + 1 company row — allowlist+NULL
source → matched; allowlist but `source='global-promotion:…'` → NOT matched; non-allowlist → NOT matched;
company-scoped allowlist subject → NOT matched; after delete only fixtures gone. Pin allowlist size === 30.
Assert `deleted===previewed` (not a hardcoded 24).

> **I will build the script + test but NOT run `--apply` against your shared Cloud SQL without your OK.**

---

## Phase 5 — Merge-PR UI copy polish  ·  `ApprovalPayload.tsx`, `ApprovalCard.tsx`, `ApprovalDetail.tsx`
Make all three surfaces verb-consistent so approving never reads like it merges.

**Changes**
- `ApprovalPayload.tsx:9` `typeLabel.merge_pr` → **"PR ready — open & merge in PR panel"** (drives both the
  inbox card title and the detail header).
- `ApprovalPayload.tsx:96-100` note: add the literal **"Approving records your sign-off only and does not
  merge"** (keep `<strong>not</strong>`, keep the PR-panel/GitHub direction).
- `ApprovalCard.tsx:84` → **"Open PR panel to merge"**.
- `ApprovalDetail.tsx:266` → **"Open PR panel to review & merge"**. Leave the GitHub "Open pull request"
  deep link + the merge_pr-never-wires-onApprove behavior unchanged.

**Tests**: new `ui/src/components/__tests__/ApprovalPayload.test.tsx` (mkdir the dir; follow
`MemoryEntryCard.test.tsx` `renderToStaticMarkup`; `vi.mock('@/lib/router', {Link})` ABOVE the import).
Assert the new strings, the absence of the old escaped phrase `Review &amp; merge in PR panel`, the note
phrases, no `>Approve<`, and the preserved deep link. UI suite is separate (`ui/vitest.config.ts`, jsdom).

---

## Re-test playbook (after the fixes land)
- **Suite**: `pnpm --filter @combyne/server test` after Phases 1-4 (~866 green incl. M2 + retrieval-quality);
  `cd ui && npx vitest run` after Phase 5 (25 + the new UI test).
- **T1 floor** (real embedder set): the off-topic global/eval row that previously appeared now scores <0.25
  and is excluded; an all-low query returns 0 items. Hash-64 dev rig unchanged. Tune `COMBYNE_MIN_RELEVANCE_SCORE`.
- **T2 done-needs-artifact**: a code ticket succeeding with no PR/changed-files lands in `awaiting_user` with
  a `system` advisory + `issue.auto_close_blocked` activity, no "Run completed successfully"; re-run with a PR
  → `done`; a research/Q&A ticket still auto-closes.
- **T3 reconcile/wake**: merge a tracked PR directly on GitHub, wait one ~2min cycle → captured once (no
  duplicate); grant an approval on a blocked+agent issue → unblock + assignee woken; answer a board question
  on a blocked+agent issue → unblock + woken; idle a stale self-block >30min with no blockers → swept clear.
- **T4 cleanup**: `pnpm db:cleanup-global-fixtures` (dry-run) prints matches, writes nothing;
  `--export <b> --apply` deletes only allowlisted non-governed global rows (deleted===previewed); board query
  no longer surfaces the fixture subjects; rollback via `db:memory-import`.
- **T5 copy**: card/detail read "PR ready — open & merge in PR panel"; buttons "Open PR panel to merge" /
  "…to review & merge"; the note says approving records sign-off only and does NOT merge; GitHub link works.

## Sequencing
Phase 1 → 2 → 3 → 4 → 5. All five are file-disjoint and independently shippable; only Phase 4's runtime
benefit is conceptually downstream of Phase 1. Keep the suite green at every phase boundary.
