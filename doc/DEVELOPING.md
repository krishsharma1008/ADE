# Developing

This project can run fully in local dev without setting up PostgreSQL manually.

## Deployment Modes

For mode definitions and intended CLI behavior, see `doc/DEPLOYMENT-MODES.md`.

Current implementation status:

- canonical model: `local_trusted` and `authenticated` (with `private/public` exposure)

## Prerequisites

- Node.js 20+
- pnpm 9+

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`.

- Do not commit `pnpm-lock.yaml` in pull requests.
- Pull request CI validates dependency resolution when manifests change.
- Pushes to `master` regenerate `pnpm-lock.yaml` with `pnpm install --lockfile-only --no-frozen-lockfile`, commit it back if needed, and then run verification with `--frozen-lockfile`.

## Start Dev

From repo root:

```sh
pnpm install
pnpm dev
```

This starts:

- API server: `http://localhost:3100`
- UI: served by the API server in dev middleware mode (same origin as API)

`pnpm dev` runs the server in watch mode and restarts on changes from workspace packages (including adapter packages). Use `pnpm dev:once` to run without file watching.

Tailscale/private-auth dev mode:

```sh
pnpm dev --tailscale-auth
```

This runs dev as `authenticated/private` and binds the server to `0.0.0.0` for private-network access.

Allow additional private hostnames (for example custom Tailscale hostnames):

```sh
pnpm combyne allowed-hostname dotta-macbook-pro
```

## One-Command Local Run

For a first-time local install, you can bootstrap and run in one command:

```sh
pnpm combyne run
```

`combyne-ai run` does:

1. auto-onboard if config is missing
2. `combyne-ai doctor` with repair enabled
3. starts the server when checks pass

## Docker Quickstart (No local Node install)

Build and run Combyne in Docker:

```sh
docker build -t combyne-local .
docker run --name combyne \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e COMBYNE_HOME=/combyne \
  -v "$(pwd)/data/docker-combyne:/combyne" \
  combyne-local
```

Or use Compose:

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

See `doc/DOCKER.md` for API key wiring (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) and persistence details.

## Database in Dev (Auto-Handled)

For local development, leave `DATABASE_URL` unset.
The server will automatically use embedded PostgreSQL and persist data at:

- `~/.combyne-ai/instances/default/db`

Override home and instance:

```sh
COMBYNE_HOME=/custom/path COMBYNE_INSTANCE_ID=dev pnpm combyne run
```

No Docker or external database is required for this mode.

## The 2-DB Model in Dev (Local-First)

Combyne is **local-first** and runs two logically separate databases (full reference:
[`doc/DATABASE.md`](DATABASE.md) "The 2-DB model"):

- **Ops DB** — local + **throwaway**: companies, agents, issues, PRs, approvals, auth, heartbeat
  state, and the durable capture outbox. Routed by `DATABASE_URL` (unset → embedded PG `:54329`).
  Wipe and re-migrate it anytime without touching shared context.
- **Context DB** — the **shared rail**: `memory_entries` and the rest of the trust-spine + embeddings.
  Routed by `COMBYNE_CONTEXT_DATABASE_URL`. **Durable** and shared between teammates.

For solo local dev you need **neither** env var: leave `DATABASE_URL` unset (embedded ops PG) and
`COMBYNE_CONTEXT_DATABASE_URL` unset (context tables live in the same embedded DB). The whole
write → embed → retrieve → passdown loop still works against the single embedded DB — context just
isn't shared with anyone else.

### Pointing dev at a shared context DB (Docker PG)

To exercise the real 2-DB split locally, point the context tables at a separate PostgreSQL. The
simplest dev rail is a Docker Postgres with pgvector:

```sh
# A throwaway context-DB container with pgvector
docker run -d --name ade-context-db \
  -e POSTGRES_USER=combyne -e POSTGRES_PASSWORD=combyne -e POSTGRES_DB=combyne \
  -p 55432:5432 pgvector/pgvector:pg17

# Provision the context schema ONCE as the designated migrator (advisory-locked)
COMBYNE_CONTEXT_DB_MIGRATE=true \
COMBYNE_CONTEXT_DATABASE_URL="postgres://combyne:combyne@127.0.0.1:55432/combyne" \
  pnpm db:migrate:context

# Run dev against it (the ops DB stays embedded; only context routes to Docker PG)
COMBYNE_CONTEXT_DATABASE_URL="postgres://combyne:combyne@127.0.0.1:55432/combyne" \
COMBYNE_CONTEXT_REQUIRED=true \
COMBYNE_CONTEXT_TRACE=1 \
  pnpm dev
```

What the env knobs do:

- `COMBYNE_CONTEXT_DATABASE_URL` — route the context/memory tables to the separate DB.
- `COMBYNE_CONTEXT_DB_MIGRATE=true` — mark this run as the **designated migrator** so
  `pnpm db:migrate:context` may apply the schema; **teammate boots are inspect-only** and never
  auto-migrate the shared DB (use plain `pnpm db:migrate` for the local ops DB only).
- `COMBYNE_CONTEXT_REQUIRED=true` — fail-loud: refuse to boot if the rail is unreachable instead of
  silently using the ops DB.
- `COMBYNE_CONTEXT_TRACE=1` — emit per-hop `ctxtrace:` lines so you can follow one ticket's context
  lifecycle across both DBs (see [`doc/TWO_DB_TESTING_PLAYBOOK.md`](TWO_DB_TESTING_PLAYBOOK.md)).

Optionally pin a canonical company id so a second local instance (or a teammate) shares the same
tenant partition on the rail: set `COMBYNE_CONTEXT_COMPANY_ID=<uuid>` and seed the local company with
that explicit id (`pnpm db:company-pin`). See
[`doc/LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md`](LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md).

> Smoke-check the wiring before running tickets: the boot log should say `Shared context DB reachable;
> memory layer routing to the shared rail` with the Docker host (not `:54329`), and the embedding
> status should show your model (not the hash-64 fallback). For the production rail (Cloud SQL), follow
> [`doc/CENTRAL_DB_RUNBOOK.md`](CENTRAL_DB_RUNBOOK.md).

## Storage in Dev (Auto-Handled)

For local development, the default storage provider is `local_disk`, which persists uploaded images/attachments at:

- `~/.combyne-ai/instances/default/data/storage`

Configure storage provider/settings:

```sh
pnpm combyne configure --section storage
```

## Default Agent Workspaces

When a local agent run has no resolved project/session workspace, Combyne falls back to an agent home workspace under the instance root:

- `~/.combyne-ai/instances/default/workspaces/<agent-id>`

This path honors `COMBYNE_HOME` and `COMBYNE_INSTANCE_ID` in non-default setups.

## Quick Health Checks

In another terminal:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Expected:

- `/api/health` returns `{"status":"ok"}`
- `/api/companies` returns a JSON array

## EM Autonomy Audit

To create an isolated company, copy the local Buku lending repos from `HEAD`, and run the repeatable EM autonomy scenarios:

```sh
pnpm audit:em-autonomy
```

Useful flags:

- `--api-url http://127.0.0.1:3100/api`
- `--root /tmp/combyne-em-autonomy-audit`
- `--bnpl /path/to/fs-bnpl-service`
- `--brick /path/to/fs-brick-service`
- `--quality-checks` to run Gradle task discovery in the copied workspaces
- `--java-home /path/to/jdk` or `COMBYNE_AUDIT_JAVA_HOME=/path/to/jdk` to force a compatible JDK for Gradle checks. If no compatible JDK exists, the audit reports `setup_missing` with install/export guidance instead of marking the repo diff as failed.

The script writes `em-autonomy-audit-report.md` and `.json` in the audit root. It never edits the original Buku repos.

## Reset Local Dev Database

To wipe the **local ops DB** (throwaway) and start fresh:

```sh
rm -rf ~/.combyne-ai/instances/default/db
pnpm dev
```

This re-inits and re-migrates the ops DB from `0001 → latest`. The **shared context DB is never
touched** by this — that's the whole point of the local-first split: blow away ops anytime without
losing shared memory.

## Optional: Use External Postgres

If you set `DATABASE_URL`, the server will use that for the **ops DB** instead of embedded PostgreSQL.
The **context/memory** tables are controlled separately by `COMBYNE_CONTEXT_DATABASE_URL` (see
"The 2-DB Model in Dev" above); when it is unset, context lives in whichever ops DB `DATABASE_URL`
selects. Migrate them with the matching commands: `pnpm db:migrate` (ops) and `pnpm db:migrate:context`
(shared context, designated migrator only).

## Automatic DB Backups

Combyne can run automatic DB backups on a timer. Defaults:

- enabled
- every 60 minutes
- retain 30 days
- backup dir: `~/.combyne-ai/instances/default/data/backups`

Configure these in:

```sh
pnpm combyne configure --section database
```

Run a one-off backup manually:

```sh
pnpm combyne db:backup
# or:
pnpm db:backup
```

Environment overrides:

- `COMBYNE_DB_BACKUP_ENABLED=true|false`
- `COMBYNE_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `COMBYNE_DB_BACKUP_RETENTION_DAYS=<days>`
- `COMBYNE_DB_BACKUP_DIR=/absolute/or/~/path`

## Secrets in Dev

Agent env vars now support secret references. By default, secret values are stored with local encryption and only secret refs are persisted in agent config.

- Default local key path: `~/.combyne-ai/instances/default/secrets/master.key`
- Override key material directly: `COMBYNE_SECRETS_MASTER_KEY`
- Override key file path: `COMBYNE_SECRETS_MASTER_KEY_FILE`

Strict mode (recommended outside local trusted machines):

```sh
COMBYNE_SECRETS_STRICT_MODE=true
```

When strict mode is enabled, sensitive env keys (for example `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

CLI configuration support:

- `pnpm combyne onboard` writes a default `secrets` config section (`local_encrypted`, strict mode off, key file path set) and creates a local key file when needed.
- `pnpm combyne configure --section secrets` lets you update provider/strict mode/key path and creates the local key file when needed.
- `pnpm combyne doctor` validates secrets adapter configuration and can create a missing local key file with `--repair`.

Migration helper for existing inline env secrets:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Company Deletion Toggle

Company deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
COMBYNE_ENABLE_COMPANY_DELETION=false
```

Default behavior:

- `local_trusted`: enabled
- `authenticated`: disabled

## CLI Client Operations

Combyne CLI now includes client-side control-plane commands in addition to setup commands.

Quick examples:

```sh
pnpm combyne issue list --company-id <company-id>
pnpm combyne issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm combyne issue update <issue-id> --status in_progress --comment "Started triage"
```

Set defaults once with context profiles:

```sh
pnpm combyne context set --api-base http://localhost:3100 --company-id <company-id>
```

Then run commands without repeating flags:

```sh
pnpm combyne issue list
pnpm combyne dashboard get
```

See full command reference in `doc/CLI.md`.

## OpenClaw Invite Onboarding Endpoints

Agent-oriented invite onboarding now exposes machine-readable API docs:

- `GET /api/invites/:token` returns invite summary plus onboarding and skills index links.
- `GET /api/invites/:token/onboarding` returns onboarding manifest details (registration endpoint, claim endpoint template, skill install hints).
- `GET /api/invites/:token/onboarding.txt` returns a plain-text onboarding doc intended for both human operators and agents (llm.txt-style handoff), including optional inviter message and suggested network host candidates.
- `GET /api/skills/index` lists available skill documents.
- `GET /api/skills/combyne` returns the Combyne heartbeat skill markdown.

## OpenClaw Join Smoke Test

Run the end-to-end OpenClaw join smoke harness:

```sh
pnpm smoke:openclaw-join
```

What it validates:

- invite creation for agent-only join
- agent join request using `adapterType=openclaw`
- board approval + one-time API key claim semantics
- callback delivery on wakeup to a dockerized OpenClaw-style webhook receiver

Required permissions:

- This script performs board-governed actions (create invite, approve join, wakeup another agent).
- In authenticated mode, run with board auth via `COMBYNE_AUTH_HEADER` or `COMBYNE_COOKIE`.

Optional auth flags (for authenticated mode):

- `COMBYNE_AUTH_HEADER` (for example `Bearer ...`)
- `COMBYNE_COOKIE` (session cookie header value)

## OpenClaw Docker UI One-Command Script

To boot OpenClaw in Docker and print a host-browser dashboard URL in one command:

```sh
pnpm smoke:openclaw-docker-ui
```

This script lives at `scripts/smoke/openclaw-docker-ui.sh` and automates clone/build/config/start for Compose-based local OpenClaw UI testing.

Pairing behavior for this smoke script:

- default `OPENCLAW_DISABLE_DEVICE_AUTH=1` (no Control UI pairing prompt for local smoke; no extra pairing env vars required)
- set `OPENCLAW_DISABLE_DEVICE_AUTH=0` to require standard device pairing

Model behavior for this smoke script:

- defaults to OpenAI models (`openai/gpt-5.2` + OpenAI fallback) so it does not require Anthropic auth by default

State behavior for this smoke script:

- defaults to isolated config dir `~/.openclaw-combyne-smoke`
- resets smoke agent state each run by default (`OPENCLAW_RESET_STATE=1`) to avoid stale provider/auth drift

Networking behavior for this smoke script:

- auto-detects and prints a Combyne host URL reachable from inside OpenClaw Docker
- default container-side host alias is `host.docker.internal` (override with `COMBYNE_HOST_FROM_CONTAINER` / `COMBYNE_HOST_PORT`)
- if Combyne rejects container hostnames in authenticated/private mode, allow `host.docker.internal` via `pnpm combyne allowed-hostname host.docker.internal` and restart Combyne
