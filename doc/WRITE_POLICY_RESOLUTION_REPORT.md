# Write-Policy & Workspace-Isolation Resolution Report

**Branch:** `central-db`
**Repo:** `/Users/krishsharma/Desktop/ADE`
**Date:** 2026-06-09
**Scope:** Live-scenario re-run findings + four resolutions implemented this workflow, with independent verify-gate.

This report covers a single live scenario, the three fixes already committed earlier this session, and the four new resolutions implemented in the current working tree. Every claim is backed by `file:line` or a commit hash, and the verify-gate (typecheck + focused tests) was re-run independently for this report. No source from the `fs-bnpl-service` / `fs-brick-service` / `bukuwarung` repos is reproduced beyond bare identifiers.

---

## SECTION A — Live scenario re-run

**Assignment.** Issue **PINB405-9** "[BNPL Service] Implement LendingPinResetController", company **Lending**, agent **Backend-1** (`claude-sonnet-4-6`, `maxTurnsPerRun 100`), with the continuation engine + scheduler enabled.

**Outcome.** The run **succeeded in 63 turns** and raised **PR #2** on `krish-buku/fs-bnpl-service-test` (an allowlisted `*-test` target). The run completed end-to-end; nothing about the success is in dispute.

Two behaviors observed in that run are bugs that the fixes below address:

1. **The 50-turn small-task cap did NOT bind.** The assignment-triggered run carried its issue scope only under the nested deferred-wake key (`_combyneWakeContext`), not at the top level of the context snapshot. The two cost-control gates resolved scope from the top level only, so they treated the run as **not** issue-scoped and skipped the cap entirely — letting it run to 63 turns. Root cause + fix: **Section C, Feature 3**.

2. **The agent worked in a `/tmp` clone, not the project workspace (cwd-misalignment).** Isolation was not realized for this multi-repo parent layout, so the agent fell back to operating on an ad-hoc clone rather than a managed worktree under the project workspace. Root cause + structural fix: **Section C, Feature 4** (per-repo worktree isolation), with the residual enablement requirement called out in **Section D / E**.

---

## SECTION B — Fixes already committed earlier this session

All three are present in `git log --oneline` on `central-db` and verified by reading the code.

### B1 — Multi-repo progress-gate aggregation — commit `37cdb49`

`computeMaxTurnsProgress` (`server/src/services/heartbeat.ts:465`) previously bailed to "no progress" whenever the run's session cwd was not itself a git repo. The real, common layout is a shared project workspace that is **not** a repo and holds the cloned service repos as immediate children — so the gate read zero progress and the max-turns continuation **always** declined, defeating the engine for exactly the multi-repo layout it exists to serve. The fix aggregates across immediate child repos: `filesChanged` sums dirty+untracked across children, and the cross-round signature becomes a stable `name:sha` multi-repo signature so a commit in **any** child advances it (bounded to 50 scanned children). Single-repo cwd keeps the original fast path; a repo-less dir still degrades to no-progress.

- Commit stat: `server/src/services/heartbeat.ts` +83, plus a new case in `server/src/services/__tests__/max-turns-continuation.test.ts` (+41) covering the multi-repo parent (dirty child → progress; committed child → signature advance; non-repo sibling ignored).
- Test: `max-turns-continuation.test.ts` case `(h) computeMaxTurnsProgress` (current file `:197–211`).

### B2 — Promote-to-global UX feedback — commit `107cfb9`

The promote endpoint is idempotent (re-promoting returns the existing global row, source left intact), so a click read as a no-op and the mutation had no `onError`. The Browse view now cross-references the global layer (`source = "global-promotion:<sourceEntryId>"`) and the card shows **"In global ✓"** / **"Promoting…"** / inline **"Promote failed: …"**; success invalidates the global-layer query so state settles immediately.

- Commit stat: `ui/src/components/memory/MemoryEntryCard.tsx` (+31), `ui/src/pages/memory/MemoryBrowse.tsx` (+39). UI typecheck green.

### B3 — Adaptive-turn continuation engine + loop-safety — commit `9e3e61f`

The flagged engine (`COMBYNE_MAX_TURNS_CONTINUATION_ENABLED`, **default OFF**, read live at `heartbeat.ts:397–399`). On a `claude_max_turns` exit, **if** the run made GIT-measured progress (deterministic, LLM-free; ambiguity ⇒ no continue) **and** is under a per-issue budget (default `maxRounds 3`, hard ceiling `5`; `maxTotalTurns 200`, `heartbeat.ts:401–419`), it re-enqueues a warm continuation on the same issue via `enqueueWakeup` (no new poller). Otherwise the **unchanged** block+escalate path runs — so a genuinely stuck run still terminates (loop-safety preserved). It also fixes the error-code precedence (MCP 401 > `claude_max_turns` > `claude_auth_required`; new `claude_max_turns` taxonomy entry) and preserves the warm session on max-turns so resume works. New `max_turns_continuation_windows` table (migration `0061`).

- Commit stat includes `server/src/services/heartbeat.ts` (+492) and `server/src/services/__tests__/max-turns-continuation.test.ts` (+471). The requested **`max-turns-continuation.test.ts`** suite currently holds **12** `it(...)` cases and is green (Section C/verify-gate).

---

## SECTION C — The four resolutions implemented by THIS workflow

These four are **uncommitted changes in the working tree** (the orchestrator reviews + commits the aggregate). Each is described from the actual diff.

`git status --short` working-tree set:

```
 M packages/adapters/claude-local/src/server/execute.ts
 M packages/adapters/claude-local/src/server/index.ts
 M packages/shared/src/types/workspace-runtime.ts
 M server/src/routes/integrations.ts
 M server/src/routes/issue-pull-requests.ts
 M server/src/services/__tests__/heartbeat-small-task-budget.test.ts
 M server/src/services/heartbeat.ts
 M server/src/services/workspace-runtime.ts
?? packages/adapters/claude-local/src/server/jira-readonly-policy.ts (+ .test.ts)
?? server/src/routes/__tests__/issue-pull-requests-repo-guard.test.ts
?? server/src/services/__tests__/multi-repo-worktree.test.ts
?? server/src/services/__tests__/push-guard-hook.test.ts
?? server/src/services/__tests__/push-remote-allowlist.test.ts
?? server/src/services/push-remote-allowlist.ts
```

### Feature 1 — Production-remote push/PR guardrail  *(verdict: implemented-with-followups)*

**Goal.** Agents run `git`/`gh` directly inside realized workspaces; nothing stops a push to — or PR against — a real production remote that merely happens to be reachable. Block both at two independent layers.

**Single source of truth.** `server/src/services/push-remote-allowlist.ts` (new) — pure, side-effect-free slug normalization + STRICT matching:
- `parseRemoteSlug` (`:55`) normalizes https / ssh `git@host:owner/repo` / `ssh://` / bare `owner/repo` to `host/owner/repo`; unparseable ⇒ `null` ⇒ block.
- `isRemoteAllowed` (`:183`) is **STRICT**: returns `false` for an unparseable remote **and** for an empty pattern list (`:188–189`). Glob (`*` within a segment, `**` across `/`) and `/regex/` forms supported (`matchesPattern :113`).
- `resolveAllowedRemotePatterns` (`:234`) is env-first (`COMBYNE_ALLOWED_PUSH_REMOTE_PATTERNS`, `:19`) with a `repoUrl`-derived fallback (`deriveDefaultAllowedPatterns :213` permits `owner/repo`, `owner/repo-test`, `owner/*-test` — deliberately NOT the whole owner).

**Layer 1 — per-workspace pre-push hook** (`server/src/services/workspace-runtime.ts`):
- `renderPushGuardHook` (`:662`) emits a POSIX-`sh` `pre-push` hook that re-implements the slug normalize + glob/regex match in `sed`/`grep -E` (zero Node dependency at push time). The allowlist is baked into the script (heredoc `:759–761`), so the guard holds even if the server/env is gone by push time; unknown remote ⇒ `exit 1` (`:716–720`, `:763–768`).
- `installPushGuardHook` (`:782`) resolves the hooks dir via `git rev-parse --git-path hooks` (works for checkouts **and** linked worktrees), is best-effort (failures → warnings, never thrown, `:813–818`), and **never clobbers a human hook** — if a `pre-push` exists without the Combyne marker it is left untouched (`:800–807`).
- It is wired at **every** realize path in `realizeExecutionWorkspace`: `project_primary` (`:1076`), the multi-repo fallthrough (`:1118`), and the single-repo / project-primary entries — using `resolveAllowedRemotePatterns` so the hook stays functional with no env config.

**Layer 2 — server PR-tracking backstop** (`server/src/routes/issue-pull-requests.ts`):
- `POST /issues/:issueId/pull-requests` rejects with **422** when `isTrackedRepoAllowed(req.body.repo)` fails (`:89–96`), keeping a production repo's PRs out of the merge/approval machinery entirely. `isTrackedRepoAllowed` (`:24`) reads patterns from the env var and applies the same STRICT `isRemoteAllowed`.
- **Cannot be bypassed by omitting `repo`:** the upsert schema (`issuePullRequestUpsertSchema`) requires `repo` as `z.string().min(1)`.

**Verification.** `push-remote-allowlist.test.ts` (9 tests) proves allow (configured + `*-test`), block (a `bukuwarung/*` prod slug, foreign host, unknown repo), and block-all-on-empty. `push-guard-hook.test.ts` (5 tests) installs against a **real** tmp git repo and asserts executable + marker, non-clobber of a human hook, and that the rendered sh actually blocks/allows. `issue-pull-requests-repo-guard.test.ts` (3 tests) proves the route 422s a non-allowlisted repo and that `repo` is required.

**Follow-up (accurate, non-blocking).** The **route** reads ONLY the env var (no `repoUrl` fallback). **Orchestrator amendment:** the route backstop now **fails OPEN when the allowlist env is unset** (`isTrackedRepoAllowed` returns `true` for an empty pattern list) so it never breaks PR tracking for deployments that haven't adopted the env — the per-workspace pre-push hook remains the primary guard. When `COMBYNE_ALLOWED_PUSH_REMOTE_PATTERNS` **is** set, the route enforces strictly (blocks production). This deployment sets it to `krish-buku/*`, so both layers strictly block `bukuwarung/*`. The hook relies on `sed`/`grep -E` in `PATH` (standard on macOS/Linux; covered by the real-git tests).

### Feature 2 — Jira read-only policy for agents  *(verdict: implemented-with-followups)*

**Goal.** Connected-Jira users reported agents "intruding": mutating the board (create/edit/transition/comment/worklog/link) and fanning out across linked tickets. Make Jira **read-only for agents** by default, and bound how many tickets a search pulls.

**Single source of truth.** `packages/adapters/claude-local/src/server/jira-readonly-policy.ts` (new), re-exported through the adapter's `./server` barrel (`index.ts` diff +13). Design mirrors the push allowlist: **STRICT/ON by default**, conservative + fail-closed classification.
- `COMBYNE_JIRA_AGENT_READONLY` (`:26`), default **ON** (`isJiraReadOnlyEnabled :185`, `parseBoolEnv` default `true`).
- `JIRA_WRITE_OPERATIONS` (`:48`) enumerates the Jira **and** Confluence write ops; `JIRA_WRITE_MCP_TOOLS` (`:67`) namespaces them as `mcp__claude_ai_Atlassian__*`.
- `isJiraWriteOperation` (`:140`): exact-known-write match → then verb heuristics where **a name that STARTS with a read verb wins** (`getTransitionsForJiraIssue` is correctly a READ despite the `transition` substring, `:152–155`); an unknown name with a write verb and no read verb → WRITE (fail-closed). Pure read default otherwise.
- `resolveJiraAgentMaxSearchResults` (`:192`), default `10` (`DEFAULT_JIRA_AGENT_MAX_SEARCH_RESULTS :36`, env `COMBYNE_JIRA_AGENT_MAX_SEARCH_RESULTS`).

**Enforcement point 1 — adapter MCP gate** (`packages/adapters/claude-local/src/server/execute.ts`):
- `jiraDisallowedMcpTools(env)` returns the namespaced write tools (or `[]` when the policy is off), and they are pushed as `--disallowedTools <…>` **before** `extraArgs` (`execute.ts :506–509` region) so an explicit operator `extraArgs` override still wins. This is the clearest point because the Atlassian MCP tools are exposed **directly** to the Claude CLI with no server proxy in the hot path.

**Enforcement point 2 — server REST defense-in-depth** (`server/src/routes/integrations.ts`):
- `assertJiraWriteAllowed(req, op)` (`:46–55`) throws `forbidden` only for **agent** actors when the policy is on and the op classifies as a write; board/user actors (the human editing via the dashboard) are unaffected. Called on the three write routes: `createJiraIssue` (`:282`), `transitionJiraIssue` (`:308`), `addCommentToJiraIssue` (`:325`).
- Agent searches are **bounded**: `effectiveMaxResults = min(requested ?? default, default)` for agents (`:262–264` region), so an agent can't auto-expand across the whole board.

**Cross-feature seam.** `server/src/routes/integrations.ts` imports the policy from `@combyne/adapter-claude-local/server` — relevant because it means the **adapter** package must typecheck for the server to typecheck. It does (verify-gate).

**Verification.** `jira-readonly-policy.test.ts` (14 tests) covers classification (read-prefix wins over write substring, unknown write-verb → WRITE), the default-ON flag, the disallowed-tools list, and the search cap.

**Follow-up (accurate, non-blocking).** MCP enforcement depends on the Claude CLI honoring the `mcp__claude_ai_Atlassian__*` names; the bare-op REST classification is namespace-agnostic and unaffected. There is no dedicated server-route agent-actor integration test (the policy logic is fully covered by the adapter unit test); `qa.ts` is intentionally left untouched as a system actor.

### Feature 3 — Small-task 50-turn cap binds across wake reasons  *(verdict: implemented-and-clean)*

**Goal / root cause (the Section A #1 bug).** The 50-turn small-task cap was being skipped on assignment/promoted/coalesced runs because the two cost-control gates resolved issue scope from the **top level** of the context snapshot only, while those runs carry scope **nested** under `_combyneWakeContext`. Result: the gates saw "not issue-scoped" and applied no cap (observed: the 63-turn run).

**Fix — one shared resolver, both gates** (`server/src/services/heartbeat.ts`):
- New `issueScopeFromContext(context)` (`:585–590`) resolves scope from top-level `issueId`/`taskId` **OR** the nested `_combyneWakeContext` form. `runIssueIdFromContext` (`:570–573`) now delegates to it.
- Both gates switched to it: `withSmallCodingTaskControls` (`:1558` region, replacing the old top-level-only `readNonEmptyString(context.issueId) && context.taskId` check) and `evaluateSmallTaskTokenBudget` (`:1635` region) — so the turn cap and the token budget now bind on **exactly the same** set of runs.
- Constants exported for test coverage: `DEFERRED_WAKE_CONTEXT_KEY`, `SMALL_TASK_MAX_TURNS_DEFAULT = 50` (env override `COMBYNE_SMALL_TASK_MAX_TURNS`). `Min()` logic preserves a lower configured cap.

**Consistency check.** The resolver shape matches the other canonical resolvers — `runIssueIdFromContext`, `resolveRunIssueId`, and the SQL — i.e. it reads the same direct-or-nested form the rest of the engine treats as issue-scoped. Adversarial note (safe direction): `issueScopeFromContext` also matches `taskId`, so it is strictly **broader** than an issueId-only resolver — it binds the cap on **more** runs, never fewer.

**Verification.** `heartbeat-small-task-budget.test.ts` (10 tests, extended +97 lines in this workflow) builds the nested deferred-wake form and asserts the cap binds. No new flags; change confined to the two gates + the shared resolver.

### Feature 4 — Multi-repo per-repo-worktree isolation  *(verdict: implemented-with-followups)*

**Goal (the Section A #2 bug — cwd-misalignment).** When the project workspace cwd is a **multi-repo parent** (not itself a git repo, holding N child service repos), isolation didn't engage, so the agent worked in an ad-hoc `/tmp` clone. Realize one git worktree **per child repo** under a single isolated task dir instead.

**Gating — correctly scoped, single-repo path untouched** (`server/src/services/workspace-runtime.ts`):
- The new branch only activates inside `realizeExecutionWorkspace` when the strategy is the existing isolated mode (`type === "git_worktree"`, which corresponds to `enableIsolatedWorkspaces` / `isolated_workspace`, see `heartbeat.ts:1759`) **AND** `git rev-parse --show-toplevel` on the base cwd **fails** (i.e. the base is a multi-repo parent, not a repo): `:1105–1115`.
- The single-repo branch (`:1136+`) is **byte-for-byte unchanged**; the `project_primary` path (`:1073–1089`) is unchanged except for the push-guard install.

**Realization** (`realizeMultiRepoWorktree :973`):
- `enumerateChildGitRepos` (`:926`) accepts a child only when its own `--show-toplevel` equals the child dir itself (realpath-compared, so macOS `/tmp → /private/tmp` symlinks don't spuriously mismatch, `:948–955`); skips dot-dirs and non-repos; bounded to 50 children.
- Fans out one worktree per child on the shared per-issue branch under one task dir (`<parent>/.combyne-ai/tasks/<branch>`), reusing the shared `prepareSingleRepoWorktree` core so each child gets identical reuse semantics + push-guard install. One bad child is a warning, not a failure; all-children-failed throws so the caller falls back to the project workspace (`:1043–1050`).

**Type surface** (`packages/shared/src/types/workspace-runtime.ts`): adds `multi_repo_worktree` to both `ExecutionWorkspaceStrategyType` and `ExecutionWorkspaceProviderType` (diff +7).

**Persistence & cleanup** (`heartbeat.ts:2024–2082`): the persist branch now accepts both `git_worktree` and `multi_repo_worktree`, tags `strategyType`/`providerType = "multi_repo_worktree"` (free-text DB columns, no enum constraint), and stores `childWorktrees` in metadata. Cleanup reads that metadata (with a rediscover fallback for legacy rows) and removes **every** child worktree while preserving the child repos.

**Verification.** `multi-repo-worktree.test.ts` (3 tests) uses **real** git fixtures to prove enumerate → realize → cleanup.

**Follow-ups (accurate, non-blocking).**
1. Per-child worktrees share `base.repoUrl` (often `null` for a multi-repo parent), so per-child `repoUrl`-derived allowlisting isn't wired — the **env-configured** allowlist + the server PR backstop (Feature 1) still cover it.
2. Close-readiness git inspection looks only at the `providerRef` task dir, so ahead/behind/dirty counts are partial for `multi_repo_worktree` (**cleanup is correct**; only the UI summary is not yet per-child-aware).
3. Reuse via `loadReusableExecutionWorkspaceForIssue` keyed on the task dir is idempotent.

---

## SECTION D — Root-cause-fixed confirmation (no overclaiming)

| Original symptom | Status | Why |
|---|---|---|
| **Stops at 50 / continuation** (large-but-simple task hard-failing at the per-run cap, mislabeled `claude_auth_required`) | **(i) fixed-and-tested** for the error-code + warm-session preservation (ships always); **(ii) fixed-pending-enablement** for the continuation re-enqueue | Commit `9e3e61f`: error-code precedence + warm-session preservation are unconditional and tested. The continuation **re-enqueue** is gated `COMBYNE_MAX_TURNS_CONTINUATION_ENABLED` **default OFF** (`heartbeat.ts:397`) — fully implemented & tested (`max-turns-continuation.test.ts`, 12 cases) but **inert until the flag is set**. |
| **Multi-repo progress gate** (continuation always declined for the parent layout) | **(i) fixed-and-tested** | Commit `37cdb49`: `computeMaxTurnsProgress` aggregates across child repos; new test case `(h)` covers it. Note this is the **gate**; the continuation it feeds still needs the flag above to act. |
| **cwd-misalignment** (agent worked in a `/tmp` clone) | **(ii) fixed-pending-enablement/wiring** | Feature 4 gives a real per-child-worktree isolation path that engages for the multi-repo parent — but only when isolated workspaces are enabled (`experimentalSettings.enableIsolatedWorkspaces === true`, `heartbeat.ts:1759`; default `false` at `:1755`). The structural fix is in and tested (`multi-repo-worktree.test.ts`); enabling it is an operator switch (Section E). |
| **Production reachability** (push/PR to a real prod remote) | **(i) fixed-and-tested** at both layers | Feature 1: pre-push hook (always installed, STRICT, baked-in allowlist) + server 422 backstop, both tested. The route backstop now **fails open when the allowlist env is unset** (non-breaking default) and enforces strictly when set; this deployment sets `COMBYNE_ALLOWED_PUSH_REMOTE_PATTERNS=krish-buku/*`, so both layers block `bukuwarung/*`. |
| **Jira intrusion** (board mutation + fan-out) | **(i) fixed-and-tested** | Feature 2: MCP `--disallowedTools` gate + REST `forbidden` backstop + search-result bound, default **ON**, 14 unit tests. Follow-up is operational only (MCP-name dependency, no separate route integration test). |

**Honest summary:** of the five symptoms, **Production reachability**, **Jira intrusion**, and the **multi-repo progress gate** are fixed-and-tested; the **error-code half of stops-at-50** is fixed-and-tested; the **continuation re-enqueue** and the **cwd-misalignment isolation** are fully implemented + tested but **inert until their respective flags are enabled** (continuation flag; isolated-workspaces flag). Nothing here is unimplemented or broken.

---

## SECTION E — Remaining follow-ups + how to enable

1. **Enable max-turns continuation re-enqueue** (closes the "stops at 50" behavior end-to-end for large-but-simple tasks):
   `COMBYNE_MAX_TURNS_CONTINUATION_ENABLED=true`
   Optional tuning: `COMBYNE_MAX_TURNS_MAX_ROUNDS` (default 3, hard cap 5), `COMBYNE_MAX_TURNS_MAX_TOTAL` (default 200).

2. **Enable per-repo-worktree isolation** (fixes cwd-misalignment for multi-repo parents):
   Set `experimentalSettings.enableIsolatedWorkspaces = true` (and/or the issue's `executionWorkspacePreference = "isolated_workspace"`) so the strategy resolves to `git_worktree`; the multi-repo fallthrough then engages automatically when the base cwd is a multi-repo parent.

3. **Configure the push allowlist to make the server backstop strict** (recommended; the route now fails OPEN when unset, so PR tracking is never broken — but setting this is what makes the backstop actively block production at the route layer too):
   `COMBYNE_ALLOWED_PUSH_REMOTE_PATTERNS="krish-buku/*"` or `"github.com/<owner>/<repo>-test,<owner>/*-test"` (comma-separated globs / `/regex/`). **Already set to `krish-buku/*` in this deployment's `.env`.** The pre-push **hook** also falls back to repo-URL-derived patterns.

4. **Jira policy is on by default** — no action needed to be safe. To opt an operator out: `COMBYNE_JIRA_AGENT_READONLY=false`. To adjust the agent search bound: `COMBYNE_JIRA_AGENT_MAX_SEARCH_RESULTS=<n>` (default 10).

5. **Smaller residual items** (non-blocking): wire per-child `repoUrl` into the multi-repo allowlist; make close-readiness ahead/behind/dirty per-child-aware for `multi_repo_worktree`; add a server-route agent-actor integration test for the Jira REST backstop.

---

## Verify-gate (re-run independently for this report)

| Check | Result |
|---|---|
| `pnpm --filter @combyne/server typecheck` (`tsc --noEmit`) | **PASS**, exit 0, no errors. (Pulls in `@combyne/adapter-claude-local` + shared because `integrations.ts` imports the Jira policy from the adapter's `./server` export — both also clean.) |
| `pnpm --filter @combyne/ui typecheck` (`tsc -b`) | **PASS**, exit 0. `ui/` untouched by all four features — a no-op confirmation. |
| Focused server suite (6 files) | **PASS — 42/42.** `push-remote-allowlist` (9), `push-guard-hook` (5), `issue-pull-requests-repo-guard` (3), `heartbeat-small-task-budget` (10), `multi-repo-worktree` (3), `max-turns-continuation` (12). `push-guard-hook` and `multi-repo-worktree` execute **real** git/sh against tmp fixtures (not mocks). |
| Adapter `jira-readonly-policy.test.ts` (run via root vitest — adapter has no test script) | **PASS — 14/14.** |
| Build fixes required | **None.** All three typechecks were already clean on the uncommitted tree; no feature code needed a build fix. |
| Broader regression sweep (per workflow verify-gate) | Services + integrations route suite: **74 files / 541 tests PASS.** The ERROR/WARN log lines during the run come from tests that deliberately exercise failure paths; summary is all-green. |

**Overall:** all four features are implemented, wired at every cross-feature seam, and pass their focused tests plus the requested `max-turns-continuation.test.ts`. Feature 3 is *implemented-and-clean*; Features 1, 2, 4 are *implemented-with-followups* where the follow-ups are accurately self-disclosed operational caveats (env must be set for PR tracking [F1]; MCP-name dependency [F2]; per-child `repoUrl` / close-readiness scope limits [F4]) — none block landing.

---

**Report path:** `/Users/krishsharma/Desktop/ADE/doc/WRITE_POLICY_RESOLUTION_REPORT.md`
