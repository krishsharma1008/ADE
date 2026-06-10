# ADE (Combyne) — Developer Setup

One page from clone to a running instance joined to your team's shared context DB.

## Prerequisites

| Tool | Version / note |
|---|---|
| Node | 20+ (22 recommended) |
| pnpm | 9+ (`corepack enable` or `npm i -g pnpm`) |
| git + gh CLI | `gh auth login` — agents push branches and open PRs through `gh` on **your** machine |
| JDK 17 | `brew install openjdk@17` — BukuWarung Java services use Gradle 7.x, which cannot run on JDK 18+; without this neither you nor agents can run Java tests locally |

## Install & run

```bash
git clone <repo-url> ade && cd ade
pnpm install
pnpm dev          # server + UI on http://127.0.0.1:3100 (embedded Postgres auto-starts on 54329)
```

First boot bootstraps the embedded DB and prints a startup banner. **Gotcha:** if the banner says `Requested port is busy; using next free port`, an older instance is still running — kill it (`lsof -nP -iTCP:3100`) or you'll browse a stale build on 3100 while the new one sits on 3101.

## Environment

**The server reads `~/.combyne/instances/<id>/.env`** (instance dir, default id `default`) — created on first boot. A repo-root `.env` is NOT loaded; shell-exported vars also work (process env wins). Edit the instance file and restart `pnpm dev` for changes to apply.

To run a **second instance** on one machine (e.g. validation), isolate it with shell env: `COMBYNE_HOME=/tmp/ade2-home PORT=3200 COMBYNE_EMBEDDED_POSTGRES_PORT=54330 pnpm dev`.

| Var | Purpose |
|---|---|
| `COMBYNE_CONTEXT_DATABASE_URL` | Shared central context DB (`postgres://…?sslmode=require`). Set this to join a team rail; omit for single-DB local mode |
| `PORT` | Server port (default 3100) |
| `COMBYNE_EMBEDDED_POSTGRES_PORT` | Embedded operational DB port (default 54329) |
| `COMBYNE_ALLOWED_PUSH_REMOTE_PATTERNS` | Agent push allowlist (globs/regex of `owner/repo`); empty ⇒ derived from project repo URLs, strict by default |
| `COMBYNE_JIRA_AGENT_READONLY` | Default ON — agents read Jira but never mutate the board (per-company overrides: Integrations → Agent Capabilities) |
| `COMBYNE_GITHUB_MERGE_ALLOW_UNKNOWN_CI` | `true` to keep CI-less repos dashboard-mergeable |
| `COMBYNE_PR_SWEEP_INTERVAL_MS` | External-merge detection sweep cadence (default 5 min) |

## Join your team (onboarding flow)

With `COMBYNE_CONTEXT_DATABASE_URL` set, open http://127.0.0.1:3100 → the onboarding wizard offers **Join an existing team**; pick your team (e.g. *Lending*) and finish. Headless equivalent:

```bash
curl -s -X POST localhost:3100/api/instance/context-database/teams -H 'Content-Type: application/json' -d '{}'   # list joinable teams
curl -s -X POST localhost:3100/api/instance/context-database/join  -H 'Content-Type: application/json' \
  -d '{"teamId":"<id from list>","teamName":"<name>"}'
```

Joining adopts the team's company + shared memory rail (multi-team isolation is enforced server-side; you only see your team's entries).

## Tests

```bash
pnpm test:run                                  # full suite (embedded-PG, ~40s)
npx vitest run server/src/services/__tests__/<file>.test.ts   # one file
pnpm typecheck && pnpm --filter ui build       # types + UI build
```

## Operational gotchas (1 line each)

- **Pause/resume**: wakes missed while an agent/company is paused are persisted and re-delivered on resume — but check the issue's system comments if work looks stuck.
- **Merges are human-gated**: agents take issues to `in_review` with a tracked PR; you merge from the dashboard PR panel (GitHub-direct merges are detected by the sweep within ~5 min).
- **Agent capabilities**: per-company toggles (Integrations page) gate agent push / raise-PR / merge-PR and Jira writes — enforced at REST, MCP, and the per-run gh/git CLI shim.
- **Memory trust spine**: agents write only unverified entries; verified facts come from your confirmations (Memory → Capture) and PR approvals; shared-layer promotion needs board approval.
- **Integrations → Test** checks both the REST token *and* your local `gh auth status` — agents need the CLI working.

---
*Guide validated by cold-start run on 2026-06-10: fresh clone → pnpm install → isolated env (COMBYNE_HOME + PORT + COMBYNE_EMBEDDED_POSTGRES_PORT + context URL) → boot (needs_onboarding) → team list → joined Lending (company + shared memory rail adopted) → targeted test green. Two guide errors found and fixed during validation (env file location; embedded-PG port var name).*
