# Handoff — Read This First (for humans and AI agents)

Written 2026-06-12 at the close of the validation engagement. Purpose: a single first-sweep document that gives a fresh contributor — especially a fresh Claude/AI session — the full working picture without re-deriving it.

## What this is

ADE (Combyne) orchestrates AI agents working real tickets like a software team: EM triages and delegates, engineers implement and raise PRs, a **human merges** (the one human gate), and accepted decisions are captured into a shared team memory that future work recalls. `docs/ARCHITECTURE.md` is the system reference (with diagrams); this doc is the operational state + tribal knowledge.

**Reading order for a new session:** this file → `docs/ARCHITECTURE.md` → `docs/DEVELOPER_SETUP.md`. Deep dives: `docs/AUDIT_PLAYBOOK.md` (how we audit), `docs/REPO_ONBOARDING.md` (adding repos), `logs/e2e-run-2026-06-10/FINAL_REPORT.md` + `findings.md` (what broke live and how it was fixed — 27 findings, all resolved).

## Current state (2026-06-12)

- **Branch:** `central-db` — pushed, in sync with origin. This is the validated team branch.
- **Live dev instance:** `pnpm dev` → server on `127.0.0.1:3100`, embedded ops Postgres on `54329` (user/pass/db all `combyne`), vite UI proxied through 3100.
- **Env:** the server reads `~/.combyne/instances/default/.env` ONLY (template: `docs/instance.env.example`; a repo-root `.env` is ignored — a finding learned the hard way).
- **Company:** Lending (`PINB405`), agents CEO / EM / Backend-1 / Backend-2 (claude-local adapter, no per-agent env overrides — they inherit the machine's `claude` login).
- **Central context rail:** self-hosted Postgres on GCP (`34.171.242.104` — see instance env). Corpus is cleaned + seeded: all active entries verified, 15 curated repo-context seeds, recall probe accuracy 16/16 top-3 (`logs/e2e-run-2026-06-10/probe-recall-results.txt`). The box has flaked twice — calls carry a 20s client deadline and the UI shows a banner when it's down; treat its uptime as an ops concern.
- **Work repos (test mirrors):** `krish-buku/fs-brick-service-test`, `krish-buku/fs-bnpl-service-test` — Java/Gradle, default branch `staging`, **JDK 17 required** (`-Dorg.gradle.java.home=/opt/homebrew/opt/openjdk@17`).
- **Outstanding:** merge the CI PRs (fs-brick#7, fs-bnpl#4 — then drop `COMBYNE_GITHUB_MERGE_ALLOW_UNKNOWN_CI`); monitor/back up the rail box; second GitHub identity if formal request-changes review gating is wanted; Claude usage credits were near zero on 06-12 (usage-pause engine parks/resumes work, but throttled time is dead time).

## Hard rules (each one cost us a live incident)

1. **Don't edit `server/src` while agent runs are in flight.** tsx watch restarts the server and orphans runs. The reaper now re-delivers them (finding #15), but don't rely on it. UI edits (`ui/src`) are always safe — vite hot-reloads independently.
2. **The instance env is the only env.** Editing a repo-root `.env` does nothing. After editing the instance file, `touch server/src/index.ts` (watch reload) or restart `pnpm dev`.
3. **"Requested port is busy; using next free port" in the boot banner means a zombie server holds 3100** and you're about to browse stale code on it. `lsof -nP -iTCP:3100` and kill the old tree before continuing. Also possible: `pnpm dev` parent alive while the server child died — same check.
4. **Use full UUIDs in DB queries.** Two round-2 run ids shared an 8-char prefix and a prefix-LIKE query debugged the wrong run for half an hour.
5. **Run vitest from the repo root** (`npx vitest run server/src/...`), not from `server/`.
6. **Two GitHub identities live on this machine:** `krish-buku` (ACTIVE — the agents push mirrors with it; don't switch it) and `krishsharma1008` (repo owner). To push ADE itself: `git push "https://x-access-token:$(gh auth token -u krishsharma1008)@github.com/krishsharma1008/ADE.git" central-db`.
7. **Never hand-edit the shared rail destructively without a backup** (JSON dumps go in `~/.combyne/instances/default/data/backups/`). Archive (status flip) over delete. Agents can never author verified memory — don't "fix" that in data either.
8. **Findings close one of three ways:** fixed-with-test, proven-benign-with-evidence, or deferred-with-owner. Never downgrade a finding without an empirical test (`docs/AUDIT_PLAYBOOK.md`).

## Code map — where the load-bearing logic lives

| Area | File(s) | Invariants you must not break |
|---|---|---|
| Heartbeat engine | `server/src/services/heartbeat.ts` (~8k lines) | Wakeups persist when skipped (paused agents re-deliver on resume); reaper re-delivers interrupted runs + 3-strikes loop guard; usage-pause parks with the issue lock HELD and the session preserved; auto-close hands open-PR issues to `in_review`, never `done` |
| PR lifecycle | `server/src/services/issue-pull-requests.ts` | `merge()` re-validates blockers server-side; the "actively revising" gate is merge-only (`agentBlockers` excludes it); the dangling-approval resolver must skip approvals attached to open PRs; capture from the POST-merge row (pre-merge `merge_commit_sha` is a GitHub test commit) |
| Issue state machine | `server/src/services/issues.ts` | The close chokepoint: non-human `done` with an open tracked PR is refused; unattributed status changes get stamped to the activity log; the awaiting-user sweeper emits `issue.auto_closed` (live UI refresh depends on it) |
| Context rail client | `server/src/services/context-db.ts` | Every rail call races the client deadline + pool eviction; health surface feeds the UI banner; RLS scope via `withContextScope` |
| Memory trust spine | `server/src/services/memory.ts`, `memory-capture.ts` | Agents write unverified only (route AND service gates); scoped recall = scope-or-NULL; passdown budgets are tiny — quality over volume |
| Accepted work | `server/src/services/accepted-work.ts` | Auto-resolver reconciles the inbox against pr-approval captures (1h EM grace) |
| Capability guards | `packages/adapter-utils/src/command-guard.ts`, `server/src/routes/integrations.ts` | Merge stays blocked in the CLI shim unless `canMergePr=true` is explicit; Jira read-only default |
| Company deletion | `server/src/services/companies.ts` | Dynamic multi-pass delete (savepoint per table) — never go back to a hand-maintained table list |
| Scheduler | `server/src/index.ts` (~line 830-1160) | PR sweep, awaiting-user sweep (terminal sessions expire on their own 8h window), usage-pause poller, memory decay, accepted-work auto-resolve |

## Tooling

```bash
pnpm dev                                   # full stack (server+UI), embedded PG auto-starts
pnpm test:run                              # full suite (~190 files, embedded-PG harness, ~40s)
npx vitest run server/src/services/__tests__/<file>.test.ts   # one file, FROM REPO ROOT
pnpm typecheck && pnpm --filter ui build   # gates before any commit

node scripts/db-query.mjs "SELECT identifier, status FROM issues ORDER BY created_at DESC LIMIT 5"
node scripts/context-query.mjs "SELECT count(*) FROM memory_entries WHERE status='active'"   # CAREFUL: live shared rail
```

Test patterns: `startTestDb()` embedded-PG harness (`server/src/services/__tests__/_test-db.ts`), `vi.spyOn(globalThis, "fetch")` for GitHub mocks, supertest with a stub `req.actor` for route tests (see `transcript-route.test.ts`), wake assertions via `agent_wakeup_requests` rows by `reason`. Post-teardown `CONNECTION_ENDED` noise from fire-and-forget wakes is a known harmless artifact.

## How to verify your work (the bar this repo is held to)

Every behavioral fix ships with a regression test; every live-found bug gets root-caused down to the line before fixing; UI-visible claims get verified on the actual UI (browse/screenshot); destructive operations get a backup first. When auditing, run all coverage classes in `docs/AUDIT_PLAYBOOK.md` — each class exists because skipping it once missed a real bug.
