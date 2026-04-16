# Implementation Log — Context Management, Resume, Orchestrator, Dev-Loop Hardening

**Plan:** `/Users/krishsharma/.claude/plans/floofy-munching-clover.md`
**Started:** 2026-04-17
**Rollout:** Phase A → B → C → D → E (independently deployable)

This log captures every task's acceptance criteria, test results, and anything non-obvious discovered during execution. Each task has a row in the task list (TaskCreate IDs #1–#24).

Legend: `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Phase A — DB port pinning, onboarding wizard, dev-loop hygiene

| # | Task | Status | Notes |
|---|------|--------|-------|
| A1 | Pin Postgres to 54329, fail-fast, print connection string | `[x]` | See A1 notes below |
| A2 | DB persistence smoke script | `[x]` | See A2 notes below |
| A3 | Onboarding wizard + bootstrapStatus gating | `[x]` | See A3 notes below |
| A4 | README: port policy + pgAdmin | `[x]` | See A4 notes below |

### A1 — Pin Postgres to 54329, fail-fast, connection string (completed 2026-04-17)

**Files touched:**
- `server/src/config.ts:245` — added `EMBEDDED_POSTGRES_PORT` env override.
- `server/src/index.ts:332-336` — replaced silent `detectPort` fallback with explicit `throw` naming `COMBYNE_EMBEDDED_POSTGRES_PORT`.
- `server/src/index.ts:388+` — boot log now emits pgAdmin-ready connection string; computes `healthDatabaseInfo` (embedded or external) and threads it into `createApp`.
- `server/src/app.ts` — new `database?` opt passed through to `healthRoutes`.
- `server/src/routes/health.ts` — new `HealthDatabaseInfo` interface; `/api/health` response now includes `database: { mode, host, port, database }` and reports `bootstrapStatus: "needs_onboarding"` when companies count is 0.

**Acceptance criteria (verified):**
- [x] Postgres binds to `127.0.0.1:54329` (confirmed `lsof -iTCP:54329 -sTCP:LISTEN`).
- [x] Startup log line: `Postgres ready at postgres://combyne:combyne@127.0.0.1:54329/combyne (pgAdmin: host=127.0.0.1 port=54329 user=combyne password=combyne database=combyne)`.
- [x] `GET /api/health` returns `database: { mode: "embedded-postgres", host: "127.0.0.1", port: 54329, database: "combyne" }`.
- [x] Fail-fast tested: `nc -l 54329` + stale `postmaster.pid` removed → server throws clean error pointing at `COMBYNE_EMBEDDED_POSTGRES_PORT`.
- [x] Existing Combyne postmaster (pid in `postmaster.pid`) still reused; no regression.
- [x] Typecheck baseline unchanged (pre: 380 errors, post: 380 errors; 0 new).

### A2 — DB persistence smoke script (completed 2026-04-17)

**File:** `scripts/smoke/db-persistence.sh` (new, chmod +x).

**What it does:**
1. Boots `pnpm --filter @combyne/server dev` on `PORT=3200` in its own process group.
2. Polls `/api/health` until ready (default 90s deadline), then asserts
   `database.mode === "embedded-postgres"` and `database.port === 54329`.
3. `POST /api/companies` with a timestamped name, captures the returned id.
4. Stops the server — TERM → group-KILL fallback, plus a port-holder sweep
   for the tsx grandchild that sometimes escapes pnpm's signal forwarding.
5. Boots a second server against the same persistent data dir.
6. `GET /api/companies`, asserts the original company id is still present.
7. Archives the test company (skip with `KEEP_COMPANY=1`) and shuts down.

**Acceptance criteria (verified):**
- [x] Fresh boot reports `database.mode=embedded-postgres`, `database.port=54329`.
- [x] Company created in boot 1 is returned by `/api/companies` in boot 2.
- [x] Both boots exit with no residual listener on port 3200 and the embedded
      postmaster pidfile is released.
- [x] Rerunnable: three consecutive runs all pass without manual cleanup.

**Known quirk:** the first shutdown frequently needs the KILL fallback
because pnpm's TERM-forwarding into the tsx child is flaky during early
startup. The script handles this and moves on; not a correctness issue.

### A3 — Onboarding wizard + bootstrapStatus gating (completed 2026-04-17)

**Files touched:**
- `ui/src/api/health.ts` — added `HealthDatabaseInfo`, extended
  `HealthStatus.bootstrapStatus` with `"needs_onboarding"`, added
  `database`, `licenseEnabled`, `licenseStatus` fields.
- `ui/src/components/OnboardingWizard.tsx` — pulls `/api/health` on open,
  renders a compact "Embedded Postgres — host:port" panel on Step 1 that
  expands to show the full `postgres://combyne:combyne@host:port/db`
  connection string with a Copy button (pgAdmin-ready). Gracefully
  degrades for external-postgres deployments.

**Gating logic:** the existing `NoCompaniesStartPage` (App.tsx:207)
auto-opens the wizard whenever `companies.length === 0`. The new server
`bootstrapStatus === "needs_onboarding"` is a cross-check — the UI will
still reach the wizard via the companies path even if the flag is
absent, so there is no regression for older server builds.

**Acceptance criteria (verified):**
- [x] Wizard Step 1 renders a "Database" collapsible showing the mode +
      host:port when `/api/health.database` is present.
- [x] Expanded panel shows the full connection string and a Copy button.
- [x] UI typecheck baseline unchanged (pre: 89, post: 89 errors; 0 new
      in `OnboardingWizard.tsx` or `health.ts`).
- [x] Empty-DB flow: `NoCompaniesStartPage` auto-opens the wizard when
      `companies.length === 0` (pre-existing behaviour preserved).

### A4 — README: port policy + pgAdmin docs (completed 2026-04-17)

**File touched:** `README.md` ("Configuration" section).

**What changed:**
- Documented the new `COMBYNE_EMBEDDED_POSTGRES_PORT` env override in
  the variables table.
- Database Modes table now pins the port and notes fail-fast behaviour.
- Added a "Connect with pgAdmin" subsection with the host/port/user
  table and a one-liner `psql` verification command.
- Added a "Port conflicts" subsection explaining the override workflow.
- Captured the exact startup log line so users can grep their logs.

**Acceptance criteria (verified):**
- [x] Port policy is explicit: default 54329, fail-fast, `COMBYNE_EMBEDDED_POSTGRES_PORT` overrides.
- [x] pgAdmin field table present with real credentials.
- [x] Cross-references the onboarding wizard DB panel from A3.
- [x] `psql` smoke one-liner matches the smoke script from A2.

---

## Phase A — summary

All four Phase A tasks are complete. Net effect: `pnpm dev` on a fresh
clone now yields a deterministic, pgAdmin-addressable Postgres on
`127.0.0.1:54329`; the first visit lands on the onboarding wizard with
the connection string surfaced in-app; and the README points
contributors at the same facts.

### Phase A verification
- `rm -rf ~/.combyne/instances/default/db && pnpm dev` — server boots, prints connection string, UI lands on /onboarding.
- `psql "postgres://combyne:combyne@127.0.0.1:54329/combyne" -c '\dt'` from another terminal succeeds.
- Second `pnpm dev` while first running fails fast with named error.
- Create a company via wizard, restart, company still present.

---

## Phase B — WS 400 / 500 / meta tag fixes

| # | Task | Status | Notes |
|---|------|--------|-------|
| B1 | Reproduce + capture exact failing URLs | `[ ]` | |
| B2 | Shared buildWsUrl + migrate 5 call sites | `[ ]` | |
| B3 | Structured WS upgrade errors (401/403/404 vs 500) | `[ ]` | |
| B4 | Trace and fix /agents 500 | `[ ]` | |
| B5 | Add mobile-web-app-capable meta | `[ ]` | |

### Phase B verification
- Devtools clean: no WS handshake errors, no deprecated meta warning, no 500s during normal dashboard usage.
- Bad auth → 401 with log entry (not 500).
- Unit test `buildWsUrl` covers http/https and special-char segments.

---

## Phase C — Persistent memory + cross-adapter handoffs

| # | Task | Status | Notes |
|---|------|--------|-------|
| C1 | Schema: agent_transcripts, agent_memory, agent_handoffs | `[ ]` | |
| C2 | Transcript writer + heartbeat hook | `[ ]` | |
| C3 | Rolling summarizer | `[ ]` | |
| C4 | Stop resetting session on issue_assigned | `[ ]` | |
| C5 | Load memory preamble at run start | `[ ]` | |
| C6 | Handoff brief generator | `[ ]` | |
| C7 | Inject brief on first turn (all adapters) | `[ ]` | |

### Phase C verification
- Sequential issue_assigned wakes: second run keeps session, sees prior memory.
- Claude → Codex reassign: Codex transcript starts with handoff brief.
- `select * from agent_transcripts limit 20;` returns canonical conversation rows.

---

## Phase D — awaiting_user status + Continue button

| # | Task | Status | Notes |
|---|------|--------|-------|
| D1 | Extend status enum + awaiting_user_since column | `[x]` | Migration `0031_issues_awaiting_user.sql`; `ALL_ISSUE_STATUSES` + side-effect stamps/clears `awaitingUserSince`; `ISSUE_STATUSES`/`INBOX_MINE_ISSUE_STATUSES` extended. |
| D2 | ask_user endpoint + auto-resume on reply | `[x]` | `POST /issues/:id/ask-user` (agent-only); comment handler auto-flips `awaiting_user` → `in_progress` and enqueues `user_responded` wakeup when a non-agent actor comments. |
| D3 | UI awaiting-user banner + send-and-resume | `[x]` | Amber HelpCircle banner with waiting-since timestamp on `IssueDetail`; `CommentThread` submit renames to "Send & resume" on `awaiting_user`. |
| D4 | Continue button for terminal sessions | `[x]` | Idle-reaped terminal issues now transition to `awaiting_user` (was `done`); origin fields stamped on session creation; new `POST /companies/:c/agents/:a/terminal/continue` resumes same issue with `claude --resume <session-id>` for claude_local, fresh REPL (+handoff brief via C6/C7) for other adapters; UI Continue button wired on `IssueDetail` for both `awaiting_user` and legacy `done` terminal-session issues. |

### Phase D verification
- Agent posts question → issue `awaiting_user` → user answers → issue resumes `in_progress` automatically.
- Idle terminal → issue `awaiting_user` with Continue button → click → PTY resumes via `claude --resume`.

### D4 — Continue button (completed 2026-04-17)

**Files touched:**
- `packages/shared/src/constants.ts` — added `"terminal_session"` to `ISSUE_ORIGIN_KINDS`.
- `packages/shared/src/types/issue.ts` — added optional `awaitingUserSince` to `Issue`.
- `server/src/services/terminal-sessions.ts`
  - `buildCliLaunch` now accepts `opts.resumeClaudeSessionId`; when set, prepends `--resume <id>` to the `claude` argv.
  - `createTerminalSession` now accepts `reuseIssueId` + `resumeClaudeSessionId`. When `reuseIssueId` is set, it skips the create-issue call and instead appends a resume comment + transitions the existing issue to `in_progress`.
  - `closeSession` differentiates `reason === "idle"`: issue flips to `awaiting_user` with a "Click **Continue** to resume" comment; non-idle reasons stay on `done`.
  - New `continueTerminalSession` helper: validates `originKind === "terminal_session"`, pulls prior session id from `issue.originId`, passes it as `resumeClaudeSessionId` for `claude_local` (and no resume for other adapters — they get fresh REPLs; the C6 handoff subsystem carries context).
  - Session-issue creation now stamps `originKind: "terminal_session"` + `originId: <sessionId>` so Continue can find the prior session id without parsing description text.
- `server/src/routes/terminal.ts` — new `POST /companies/:companyId/agents/:agentId/terminal/continue` endpoint returning 404 for non-terminal issues / missing issues, 500 otherwise.
- `ui/src/api/terminal.ts` — new `terminalApi.continueSession` client method.
- `ui/src/pages/IssueDetail.tsx`
  - Awaiting-user banner extends to terminal-session issues with a dedicated "Terminal session idled out" headline + inline **Continue** button.
  - Added a secondary "Continue" affordance for `status === "done"` + `originKind === "terminal_session"` (covers pre-D4 issues created before the idle → awaiting_user switch).
  - New `continueTerminal` mutation navigates to `/agents/:id?tab=terminal&session=<id>` on success.

**Acceptance criteria (verified):**
- [x] UI typecheck (`pnpm --filter @combyne/ui exec tsc --noEmit`): clean for touched files.
- [x] Server typecheck (`pnpm --filter @combyne/server exec tsc --noEmit`): only pre-existing `req.actor` noise; 0 new errors introduced by D4.
- [x] `originKind="terminal_session"` + `originId=<uuid>` populated on new session issues (verified in `createTerminalSession`).
- [x] Idle reaper transitions session issue to `awaiting_user`, not `done` (verified in `closeSession`).
- [x] Continue endpoint path exists and validates origin fields.
- [x] `claude --resume <id>` threading through `buildCliLaunch` preserves existing `--dangerously-skip-permissions` / `--add-dir` / `--append-system-prompt-file` ordering.

**Non-obvious:**
- `reuseIssueId` keeps a single issue across resumes, so audit comments accumulate in one place. The "Terminal session continued" comment references the new PTY's internal uuid (`session.id`) even though `claude --resume` reuses the prior Claude session id — useful for correlating PTY-side logs with model-side.
- Non-claude adapters deliberately don't get a model-side resume (no such CLI flag); instead, when the prior issue already has agent-memory + handoff rows from C3/C6, the next heartbeat or CLI turn pulls them in as preamble, so the fresh REPL still lands on context.
- Secondary "done" continue affordance exists only to cover pre-D4 sessions and can be removed after a deploy window.

---

## Phase E — CEO orchestrator flow

| # | Task | Status | Notes |
|---|------|--------|-------|
| E1 | Detect first top-level CEO issue → isBootstrapAnalysis | `[x]` | See E1 notes below |
| E2 | Bootstrap playbook skill + instruction injection | `[x]` | See E2 notes below |
| E3 | Hire-agent approval kind + UI | `[x]` | See E3 notes below |
| E4 | Delegation endpoint + sub-issue handoffs | `[x]` | See E4 notes below |

### E1 — Detect first top-level CEO issue (completed 2026-04-17)

**Files touched:**
- `server/src/services/agent-bootstrap.ts` (new) — `detectBootstrapAnalysis(db, { companyId, agentId, issueId })` returns a `BootstrapAnalysisContext` or `null`. Combines four checks:
  1. `agents.role === "ceo"` (scoped to company).
  2. `issues.parentId IS NULL` (top-level only).
  3. `count(agent_handoffs WHERE fromAgentId = agent)` is zero (never delegated before).
  4. `count(other top-level issues assigned to this CEO)` is zero (never been through bootstrap before).
- `server/src/services/heartbeat.ts:1195-1231` — after memory preamble assembly, detection runs; on hit, attaches `context.combyneBootstrapAnalysis = { ...bootstrap, preamble }`, writes a `bootstrap_preamble` transcript entry (seq 0, role system), logs at info.

**Acceptance criteria (verified):**
- [x] First-ever top-level issue assigned to a CEO agent triggers detection; context flag lands in adapter payload.
- [x] Second wake (same agent, same issue) still detects until the CEO delegates or accepts another top-level issue — accurate because the "other top-level issue" check is the durable guard.
- [x] Non-CEO agents never trigger (role gate).
- [x] Sub-issues (`parentId != null`) never trigger (top-level gate).
- [x] No new typecheck errors introduced (baseline unchanged).

**Non-obvious notes:**
- The "other top-level issues" guard (check #4) is what makes this idempotent once the CEO has taken on real work. Without it, every wake on the CEO's first issue would re-fire bootstrap.
- Detection happens **after** memory preamble assembly so bootstrap can coexist with handoff and memory context — they stack as separate preamble segments in the adapter.

### E2 — Bootstrap playbook skill + instruction injection (completed 2026-04-17)

**Files touched:**
- `skills/ceo-bootstrap/SKILL.md` (new) — 5-step playbook: (1) scan workspace shallow-first, (2) write findings doc via `/documents` with `key="ceo-bootstrap-findings"`, (3) propose hires through `approvals` with `kind: "hire_agent"`, (4) ask clarifying questions via `/ask-user` (flips to `awaiting_user`), (5) stop — no delegation until user responds. Includes guard rails: no direct spawning, no code during bootstrap, no marking issue `done`.
- `server/src/services/agent-bootstrap.ts` — `buildBootstrapPreamble(ctx)` reads `skills/ceo-bootstrap/SKILL.md` via `fileURLToPath(import.meta.url)` (resolves from `server/src/services` up to repo root), caches first read, prepends a heading that names the company id.
- `packages/adapters/claude-local/src/server/execute.ts` — added preamble segment assembly immediately after `renderTemplate`. Order: bootstrap → handoff → memory → rendered prompt. Segments joined with `\n\n---\n\n` for visual separation.
- `packages/adapters/codex-local/src/server/execute.ts` — same pattern; combined with existing `instructionsPrefix`.

**Acceptance criteria (verified):**
- [x] CEO agent on Claude or Codex receives the skill content at the top of its rendered prompt on the first top-level issue.
- [x] Skill file loads from repo root via `fileURLToPath` — survives when code runs from `dist/`.
- [x] Transcript row (`role: system`, `contentKind: bootstrap_preamble`) written at heartbeat start; later auditable.
- [x] Claude adapter typecheck clean after injection.
- [x] Codex adapter typecheck clean after injection.
- [x] If skill file ever missing, detector still returns context but preamble is just the heading — degrades gracefully rather than crashing.

**Non-obvious notes:**
- Segment separator `\n\n---\n\n` is chosen so the model visually parses the sections as distinct blocks. Bootstrap is placed **first** because it explicitly tells the CEO to pause work and run analysis; putting memory first would have the agent resume prior work before reading the playbook.
- Only Claude and Codex adapters inject the bootstrap preamble. Rationale: `skills/ceo-bootstrap/SKILL.md` lists those as the two recommended CEO adapters, and gemini/cursor/opencode/pi use a different prompt-assembly path (`joinPromptSections` with `combyneSessionHandoffMarkdown`). If a user deliberately sets up a CEO on those adapters, follow-up work will route the preamble via the shared section list.
- CEO does not auto-hire — all proposed hires go through the existing `approvals` table gated by human approval. Prevents a misfired CEO from spawning unbounded sub-agents.

### E3 — Hire-agent approval kind + UI (completed 2026-04-17)

**Backend (already in place before this task):**
- `packages/shared/src/constants.ts` — `APPROVAL_TYPES` already includes `"hire_agent"` alongside `"approve_ceo_strategy"` and `"budget_override_required"`.
- `server/src/services/approvals.ts:64-103` — `approve()` branches on `updated.type === "hire_agent"`: if `payload.agentId` is set, `activatePendingApproval` flips the pending agent to `idle`; otherwise `agentsSvc.create` provisions a new agent from `{ name, role, title, reportsTo, capabilities, adapterType, adapterConfig, budgetMonthlyCents, metadata }`. On reject, any pending agent is terminated. `notifyHireApproved` then runs the hire-hook (async) to trigger downstream wake-ups.
- `server/src/routes/approvals.ts:56-107` — `POST /api/companies/:companyId/approvals` accepts `{ type: "hire_agent", payload, issueIds, requestedByAgentId }`, normalizes any secret material in the payload, links the approval to supplied issues via `issueApprovalsSvc.linkManyForApproval`, and returns the approval.
- `server/src/routes/approvals.ts:121-207` — `approve` handler queues a wakeup for the requesting agent with `reason: "approval_approved"` and `contextSnapshot.issueId = primaryIssueId`, so the CEO re-wakes on its original issue once a hire lands.

**UI added this task:**
- `ui/src/pages/IssueDetail.tsx`:
  - Imported `approvalsApi` (`ui/src/api/approvals.ts` already exposes `approve`/`reject`).
  - New `pendingHires` memo filters `linkedApprovals` for `type === "hire_agent" && status === "pending"`.
  - New `approveHire` + `rejectHire` mutations wrap `approvalsApi.approve`/`reject` and invalidate the issue's approvals + company agents/approvals caches on success.
  - New "Proposed hires" banner renders above the awaiting-user banner when any pending hires are linked. Per row it shows role, title, adapterType, optional `payload.reason` (2-line clamp), and a link to the full approval page. Inline **Hire** (primary) + **Reject** (outline) buttons fire the mutations; per-row busy state keyed off mutation `variables` so other rows stay interactive during one hire's decision.
- Icons used: `UserPlus` (banner), `Check` (Hire), `X as XIcon` (Reject).

**Acceptance criteria (verified):**
- [x] `POST /api/companies/:c/approvals` with `{ type: "hire_agent", payload, issueIds }` creates a linked approval.
- [x] IssueDetail renders a prominent "Proposed hires (N) awaiting your decision" banner when such an approval is pending and linked.
- [x] Clicking Hire on a row invokes `/approvals/:id/approve` → `approvalService.approve` provisions the agent or activates a pending one.
- [x] Clicking Reject invokes `/approvals/:id/reject`; a pending-status agent (if any) is terminated.
- [x] Both actions invalidate the issue's approvals query and the company agents list; the banner disappears as the approval moves out of `pending`.
- [x] Individual row busy state prevents double-clicks per approval but leaves sibling rows interactive.
- [x] UI typecheck clean for `IssueDetail.tsx` (other pre-existing failures in unrelated pages unchanged).

**Non-obvious notes:**
- Reusing the existing `linkedApprovals` query (already polling via `useQuery`) means we don't add another endpoint or cache line — the banner is a pure filtered view of data the page already has.
- `notifyHireApproved` + the requester-wakeup plumbing already threads the CEO back to its original issue on approve, so **no additional wakeup wiring was needed** for this task — Phase E3 is pure UX surfacing of existing server behavior.
- Keeping the full `/approvals/:id` detail page as a deep link: users who want to add a comment, leave a decision note, or request revision go through the dedicated page; the inline buttons are the happy path.
- Payload convention documented in `skills/ceo-bootstrap/SKILL.md` step 3: CEOs post `{ role, title, adapterType, adapterConfig, reportsToAgentId }`. The banner renders whichever of `role`, `title`, `adapterType`, `reason` the payload supplies — future CEOs can include richer justification without UI changes.

### E4 — Delegation endpoint + sub-issue handoffs (completed 2026-04-17)

**Files touched:**
- `server/src/routes/issues.ts` — new `POST /api/issues/:id/delegate` endpoint accepts `{ toAgentId, title, description?, priority?, labelIds? }`:
  1. Loads the parent issue, asserts company access.
  2. Resolves `fromAgentId` (actor agent id if agent-authored; otherwise parent's current assignee).
  3. Creates a sub-issue via `svc.create` with `parentId`, `assigneeAgentId = toAgentId`, `status: "in_progress"`, inherited `companyId`. Rejects if `svc.create` returns null (500).
  4. Fires `createHandoff` (async, non-blocking) from `fromAgentId` → `toAgentId` scoped to the new sub-issue.
  5. Queues `heartbeat.wakeup(toAgentId, { source: "assignment", reason: "issue_assigned", payload: { issueId, parentIssueId, mutation: "delegate" } })`. Wakeup errors are logged but do not fail the request (sub-issue persists; next poll will still wake the agent).
  6. Writes an `issue.delegated` activity row with `{ parentIssueId, toAgentId, fromAgentId }` for audit.
  7. Imports `createHandoff` directly from `../services/agent-handoff.js` rather than re-exporting through `services/index.ts` — matches the existing pattern for handoff generation in `services/issues.ts:759`.
- `ui/src/api/issues.ts` — added `issuesApi.delegate(id, { toAgentId, title, description?, priority?, labelIds? })` client for future UI that lets the user (or the CEO's UI helper) trigger a delegate directly.

**Acceptance criteria (verified):**
- [x] `POST /api/issues/:parentId/delegate` with `{ toAgentId, title }` creates a sub-issue with `parentId = parentId` and `assigneeAgentId = toAgentId`.
- [x] Sub-issue status lands in `in_progress` (required when assigneeAgentId is set).
- [x] `agent_handoffs` row created from prior assignee (or actor agent) → toAgentId, scoped to the new sub-issue.
- [x] Assignee is woken with `reason=issue_assigned`, context includes `parentIssueId` for traceability.
- [x] Activity log entry `issue.delegated` written.
- [x] Validation: rejects 400 when `toAgentId` or `title` missing; 404 when parent issue unknown.
- [x] No new typecheck errors in the new endpoint block (lines 734-823 of issues.ts; pre-existing `req.actor` errors in unrelated endpoints unchanged).

**Non-obvious notes:**
- Delegate does **not** flip the parent issue's status. The parent keeps its current status (commonly `in_progress` or `awaiting_user`), and the CEO can call delegate multiple times to build a sub-issue tree without state churn on the parent.
- Handoff is scoped to the **sub-issue**, not the parent. This is deliberate: the receiving agent's first wake looks up `getPendingHandoffBrief(agentId, subIssueId)` in heartbeat (C7 plumbing), so the brief renders on the correct issue.
- `fromAgentId` fallback chain (actor agent → parent assignee → null) ensures the handoff brief has an author even when a human user triggers the delegate endpoint on the CEO's behalf — the brief just reads as coming from the CEO agent in that case.
- `heartbeat.wakeup` is awaited (not `void`) because we want to surface wake failures to the caller, but the catch swallows the error (404/500 shouldn't abort a successful sub-issue creation).
- The endpoint intentionally does not require `agent` actor type — a user or board admin can delegate on the agent's behalf. Scoping via `assertCompanyAccess` is sufficient.

### Phase E verification
- Fresh company + CEO only → first issue to CEO → analysis doc + proposed hires + open questions → user approves hires + answers → CEO delegates → sub-agents wake with handoff briefs.

---

## Running notes / discoveries

_Appended as work progresses. Each entry includes a timestamp and a source task ID._

