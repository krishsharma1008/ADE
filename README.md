<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> &middot;
  <a href="#usage-examples"><strong>Examples</strong></a> &middot;
  <a href="#agent-adapters"><strong>Adapters</strong></a> &middot;
  <a href="#development"><strong>Dev Guide</strong></a> &middot;
  <a href="#docker"><strong>Docker</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS_%7C_Linux_%7C_Docker-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/node-20%2B-green" alt="Node.js 20+" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

<br/>

# ADE — Agent Development Environment

**Open-source orchestration platform for AI agent teams.**

ADE is a Node.js server and React dashboard that lets you build, manage, and coordinate teams of AI agents. Bring your own agents (Claude Code, Codex, Cursor, OpenClaw, or any custom adapter), assign goals, set budgets, and monitor everything from one place.

Think of it as a company operating system — org charts, governance, budgets, and task management — but the employees are AI agents.

<br/>

---

## Quick Start

### Prerequisites

**Required:**

| Requirement | Version | Install |
|-------------|---------|---------|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org) or `brew install node` |
| **pnpm** | 9+ | `npm install -g pnpm` |

**Optional — at least one agent adapter CLI to run agents:**

| Adapter CLI | Install |
|-------------|---------|
| **Claude Code** (`claude`) | `npm install -g @anthropic-ai/claude-code` |
| **Codex** (`codex`) | `npm install -g @openai/codex` |
| **Cursor Agent** (`cursor-agent`) | [cursor.com/install](https://www.cursor.com/install) |
| **Gemini CLI** (`gemini`) | `npm install -g @google/gemini-cli` |
| **OpenCode** (`opencode`) | `curl -fsSL https://opencode.ai/install \| bash` |
| **Pi** (`pi`) | [docs.pi.ai](https://docs.pi.ai) |

> You don't need to install all of them — pick the adapter(s) you plan to use. The onboarding wizard auto-detects what's installed and picks a default for you. Agents with missing CLIs are greyed out with install instructions.

### Platform support

| OS | Status | Notes |
|----|--------|-------|
| **macOS** (Intel, Apple Silicon) | ✅ Fully supported | Embedded PostgreSQL works out of the box |
| **Linux glibc** (x64, ARM64) | ✅ Fully supported | Debian/Ubuntu/RHEL/Fedora — embedded PostgreSQL works out of the box |
| **Linux musl** (Alpine) | ⚠️ Requires external Postgres | `embedded-postgres` ships glibc binaries only — set `DATABASE_URL` (see below) |
| **Windows** (native) | ⚠️ Requires external Postgres | Use WSL2 for the full experience, or point `DATABASE_URL` at an external Postgres |

If you're on Windows or Alpine, run an external Postgres and point the server at it:

```bash
# Example: docker postgres alongside ADE
docker run -d --name ade-pg \
  -e POSTGRES_USER=combyne -e POSTGRES_PASSWORD=combyne -e POSTGRES_DB=combyne \
  -p 54329:5432 postgres:16

# Tell ADE to use it instead of the embedded cluster
export DATABASE_URL="postgres://combyne:combyne@127.0.0.1:54329/combyne"
pnpm dev
```

### 1. Clone and install

```bash
git clone https://github.com/krishsharma1008/ADE.git
cd ADE
pnpm install
```

### 2. Start the dev server

```bash
pnpm dev
```

That's it. The server starts at **http://localhost:3100** with:
- An **embedded PostgreSQL** database (zero setup — created automatically)
- The **React dashboard** served on the same port
- **Auto-migrations** applied on first run

### 3. Verify it's running

```bash
# Health check
curl http://localhost:3100/api/health
# → {"status":"ok"}

# List companies
curl http://localhost:3100/api/companies
# → []
```

Open **http://localhost:3100** in your browser to access the dashboard.

<br/>

---

## Usage Examples

### Dashboard (UI)

The web dashboard at `http://localhost:3100` provides:

- **Company setup** — Create and configure AI companies with goals and branding
- **Org chart** — Visual hierarchy of your agent team
- **Issue tracker** — Create, assign, and track tasks across agents
- **Cost dashboard** — Monitor spend per agent with budget controls
- **Agent management** — Add/remove agents, configure adapters, set permissions
- **Governance** — Approve hires, review strategy, pause or terminate agents
- **Integrations** — Connect Jira, GitHub, Confluent Cloud, and SonarQube

### API Examples

```bash
# Create a company
curl -X POST http://localhost:3100/api/companies \
  -H "Content-Type: application/json" \
  -d '{"name": "My AI Startup", "mission": "Build the best AI note-taking app"}'

# List agents in a company
curl http://localhost:3100/api/companies/<company-id>/agents

# Create an issue
curl -X POST http://localhost:3100/api/companies/<company-id>/issues \
  -H "Content-Type: application/json" \
  -d '{"title": "Implement user authentication", "description": "Add OAuth2 login flow"}'

# Check agent costs
curl http://localhost:3100/api/companies/<company-id>/costs/summary
```

### CLI Examples

```bash
# One-command setup and run
pnpm combyne run

# Onboard a new instance
pnpm combyne onboard

# Run diagnostics
pnpm combyne doctor

# Set default context (so you don't repeat flags)
pnpm combyne context set --api-base http://localhost:3100 --company-id <company-id>

# Then use short commands
pnpm combyne issue list
pnpm combyne issue create --title "Investigate checkout bug"
pnpm combyne issue update <issue-id> --status in_progress --comment "Started triage"
pnpm combyne dashboard get
```

<br/>

---

## Agent Adapters

ADE supports multiple AI agent backends through adapters. If it can receive a heartbeat, it works.

| Adapter | Type | Description |
|---------|------|-------------|
| **Claude Code** | Local | Integrates Anthropic's Claude Code CLI as a managed agent |
| **Codex** | Local | Integrates OpenAI's Codex CLI as a managed agent |
| **Cursor** | Local | Integrates Cursor editor as a managed agent |
| **Gemini** | Local | Integrates Google's Gemini CLI as a managed agent |
| **OpenCode** | Local | Integrates OpenCode CLI as a managed agent |
| **Pi** | Local | Integrates Pi CLI as a managed agent |
| **Browser Use** | Local | AI-powered browser automation agent |
| **OpenClaw** | Gateway | Connects remote OpenClaw agents via SSE gateway |

### Adding an Agent

1. Open the dashboard at `http://localhost:3100`
2. Select or create a company
3. Navigate to **Agents** and click **Add Agent**
4. Choose an adapter type and configure it
5. The agent will connect via heartbeat and appear in your org chart

### Agent Environment

Each agent gets its own isolated workspace at:
```
~/.combyne/instances/default/workspaces/<agent-id>
```

Agent API keys are hashed at rest and scoped to their company — no cross-company access.

<br/>

---

## Central Context DB (memory layer)

ADE includes a **central context database** — a governed, hallucination-resistant
memory layer that captures what your team knows and feeds it back to the agents
that need it, scoped to each task.

**What it does**

- **Layered memory** — per-company `workspace` / `personal` / `shared` tiers plus an
  instance-wide **`global`** layer for org-wide conventions shared across every team.
- **Human-gated trust** — every entry carries provenance (`human-answer`,
  `pr-approval`, `agent-claim`, …), a verification state, and a confidence. Agent
  claims are forced **unverified** at the write gate and are never retrieved as
  authoritative until a human verifies or promotes them.
- **Two write-paths** — when an agent asks a teammate a question, the **answer** is
  captured as a verified entry; when a human EM **approves a PR**, the decision /
  convention is captured. Both are reused automatically next time.
- **EM passdown** — when a manager agent delegates, it hands the sub-agent a vetted,
  size-tiered, **cited** slice of memory (small / medium / large tickets get
  proportional context), and the sub-agent's own retrieval is verified-only too.
- **Ask-don't-hallucinate** — when retrieved context is insufficient, the agent asks
  the user instead of fabricating; the answer is captured so it's served from memory
  next time. (Ships dark; enable after calibration.)
- **Semantic retrieval** — a managed embedding model (or the built-in deterministic
  hash fallback) with **redact-before-embed**. On a benchmark of paraphrased queries,
  real embeddings lifted recall@1 from ~14% to ~93%.
- **Multi-tenant** — company-scoped by default, with Postgres **row-level security**
  authored and CI-proven for one shared instance (the `global` layer is the
  cross-company read exception).

**Use it**

- Open the **Memory** tab in the dashboard: *Browse · Capture · Verify · Conflicts*
  (merge / override) *· Redaction · Questions · Passdown*, plus admin **Database** and
  **Setup** tabs.
- Run the memory layer on its own database (optional): set
  `COMBYNE_CONTEXT_DATABASE_URL`, or use the **Database** tab to test + save a
  connection (takes effect on restart).
- Enable semantic retrieval (optional): set a **dedicated** `COMBYNE_EMBEDDING_API_KEY`,
  or save a key via the **Setup** tab (privacy disclosure) — either is treated as
  embedding intent and turns vector search on automatically (no flag needed). A generic
  host `OPENAI_API_KEY` alone does **not** enable it (so a stray key never silently
  egresses memory bodies) — pair it with `COMBYNE_VECTOR_SEARCH_ENABLED=true` to opt in
  explicitly. Set `COMBYNE_VECTOR_SEARCH_ENABLED=false` to force the local hash fallback
  even with a key (kill-switch).

The memory layer runs on the **2-DB model**: a local, throwaway **ops DB** (issues/agents/PRs) and a
durable, **shared context DB** (`COMBYNE_CONTEXT_DATABASE_URL`) that is the only shared rail. See
[`doc/DATABASE.md`](doc/DATABASE.md) for the model and the `db:migrate` (ops) vs `db:migrate:context`
(shared rail) migration split.

Design + ops docs: [`doc/CENTRAL_CONTEXT_DB_PLAN.md`](doc/CENTRAL_CONTEXT_DB_PLAN.md),
[`doc/MEMORY_UI_AND_QUALITY_PLAN.md`](doc/MEMORY_UI_AND_QUALITY_PLAN.md),
[`doc/CENTRAL_DB_RUNBOOK.md`](doc/CENTRAL_DB_RUNBOOK.md) (DevOps hand-off),
[`doc/LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md`](doc/LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md) (architecture + stand-up),
[`doc/TWO_DB_TESTING_PLAYBOOK.md`](doc/TWO_DB_TESTING_PLAYBOOK.md) (2-DB test procedure),
[`doc/IMPROVEMENT_PLAN.md`](doc/IMPROVEMENT_PLAN.md) + [`doc/INFRA_FIXES_PLAN.md`](doc/INFRA_FIXES_PLAN.md) (roadmap),
[`doc/HALLUCINATION_AT_SCALE.md`](doc/HALLUCINATION_AT_SCALE.md), and
[`doc/PRIVACY_DISCLOSURE.md`](doc/PRIVACY_DISCLOSURE.md).

---

## Configuration

### Environment Variables

ADE works out of the box with zero configuration. All settings below are **optional**.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *(embedded PostgreSQL)* | Use an external PostgreSQL instead of embedded |
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `3100` | Server port |
| `COMBYNE_EMBEDDED_POSTGRES_PORT` | `54329` | **Pinned** port for the embedded PostgreSQL cluster. The server fails fast with a clear error if this port is held by another process. |
| `COMBYNE_HOME` | `~/.combyne` | Data directory root |
| `COMBYNE_INSTANCE_ID` | `default` | Instance identifier (for multi-instance setups) |
| `COMBYNE_DB_BACKUP_ENABLED` | `true` | Enable automatic database backups |
| `COMBYNE_DB_BACKUP_INTERVAL_MINUTES` | `60` | Backup frequency |
| `COMBYNE_DB_BACKUP_RETENTION_DAYS` | `30` | How long to keep backups |
| `COMBYNE_SECRETS_STRICT_MODE` | `false` | Require secret references for API keys/tokens |
| `BETTER_AUTH_SECRET` | *(auto-generated at `~/.combyne/secrets/`)* | Session signing key. Set explicitly for Docker / multi-instance deployments so sessions survive container restarts. Generate with `openssl rand -hex 32`. |
| `COMBYNE_MEMORY_MIN_ENTRIES` | `3` | Min transcript entries before a run gets summarized into `agent_memory` |
| `COMBYNE_RESET_SESSION_ON_ASSIGN` | `false` | Set to `true` to reset the adapter session on every issue reassignment (rollback lever for shared-context handoff) |
| `COMBYNE_CONTEXT_DATABASE_URL` | *(uses `DATABASE_URL`)* | Run the **context/memory** tables in a **separate** PostgreSQL from operational data (the central context DB) |
| `COMBYNE_EMBEDDING_API_KEY` | *(unset → local hash fallback)* | **Dedicated** team embedding key. Treated as embedding intent → auto-enables vector search (bodies egress post-redaction). |
| `OPENAI_API_KEY` | *(generic host key)* | Usable as the embedding key, but does **not** auto-enable vector search — needs `COMBYNE_VECTOR_SEARCH_ENABLED=true` so a stray key never silently egresses memory. |
| `COMBYNE_VECTOR_SEARCH_ENABLED` | *(auto-on with a dedicated/UI key)* | `true` = explicit opt-in (required for a generic `OPENAI_API_KEY`); `false` = kill-switch forcing the hash fallback even with a key. |
| `COMBYNE_SUFFICIENCY_GATE_ENABLED` | `false` | Ask-don't-hallucinate gate — ships dark; enable after calibration |

See [`.env.example`](.env.example) for the full env-var surface, grouped by section.

### Database Modes

| Mode | When | Setup |
|------|------|-------|
| **Embedded PostgreSQL** | Local dev (default) | Leave `DATABASE_URL` unset — fully automatic. Cluster binds to **`127.0.0.1:54329`** (pin is fail-fast; override with `COMBYNE_EMBEDDED_POSTGRES_PORT`). |
| **External PostgreSQL** | Production / teams | Set `DATABASE_URL=postgres://user:pass@host:5432/dbname` |

Data is stored at `~/.combyne/instances/default/db` in embedded mode.
The on-disk cluster is persistent — stopping the server leaves the data
in place, and the next boot reattaches to it.

On startup the server prints one line with the full connection string,
e.g.:

```text
Postgres ready at postgres://combyne:combyne@127.0.0.1:54329/combyne (pgAdmin: host=127.0.0.1 port=54329 user=combyne password=combyne database=combyne)
```

### Connect with pgAdmin (or any psql-compatible client)

While `pnpm dev` is running, point pgAdmin / DBeaver / `psql` at the
embedded cluster:

| Field    | Value        |
|----------|--------------|
| Host     | `127.0.0.1`  |
| Port     | `54329`      |
| Database | `combyne`    |
| User     | `combyne`    |
| Password | `combyne`    |

One-shot verification from another terminal:

```bash
psql "postgres://combyne:combyne@127.0.0.1:54329/combyne" -c '\dt'
```

The onboarding wizard (first-run UI) also surfaces this connection
string inline so you can copy it into pgAdmin without leaving the app.

### Port conflicts

If port `54329` is already bound (e.g. a system Postgres is running),
the dev server will **fail fast** rather than silently relocating to a
random port — this keeps pgAdmin bookmarks stable. Either stop the
other process or choose a different port:

```bash
COMBYNE_EMBEDDED_POSTGRES_PORT=54330 pnpm dev
```

### Reset Local Database

```bash
rm -rf ~/.combyne/instances/default/db
pnpm dev
```

### Storage

Uploaded files (images, attachments) are stored locally by default at:
```
~/.combyne/instances/default/data/storage
```

Configure storage provider:
```bash
pnpm combyne configure --section storage
```

### Secrets Management

Agent env vars support encrypted secret references:

```bash
# Configure secrets
pnpm combyne configure --section secrets

# Migrate existing inline secrets to encrypted references
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply
```

<br/>

---

## Project Structure

```
ADE/
├── server/                    # Express.js API server
├── ui/                        # React 19 frontend (Vite + Tailwind CSS 4)
├── cli/                       # CLI tool (Commander.js)
├── packages/
│   ├── db/                    # Database layer (Drizzle ORM + migrations)
│   ├── shared/                # Shared TypeScript types & Zod validators
│   ├── adapter-utils/         # Common adapter utilities
│   ├── plugin-sdk/            # Plugin development SDK
│   └── adapters/
│       ├── claude-local/      # Claude Code adapter
│       ├── codex-local/       # Codex adapter
│       ├── cursor-local/      # Cursor adapter
│       ├── gemini-local/      # Gemini adapter
│       ├── opencode-local/    # OpenCode adapter
│       ├── pi-local/          # Pi adapter
│       ├── browser-use/       # Browser automation adapter
│       └── openclaw-gateway/  # OpenClaw SSE gateway adapter
├── supabase/                  # Supabase Edge Functions
├── skills/                    # Agent skill definitions
├── tests/e2e/                 # Playwright E2E tests
├── scripts/                   # Build, release, and utility scripts
├── docker/                    # Docker configuration files
├── docs/                      # Mintlify documentation site
└── doc/                       # Internal development docs
```

<br/>

---

## Development

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start full dev server (API + UI) with watch mode |
| `pnpm dev:once` | Start dev server without file watching |
| `pnpm dev:server` | Start API server only |
| `pnpm dev:ui` | Start UI dev server only (port 5173) |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Run TypeScript type checking across all packages |
| `pnpm test:run` | Run all unit tests (Vitest) |
| `pnpm test:e2e` | Run Playwright E2E tests |
| `pnpm test:e2e:headed` | Run E2E tests with visible browser |
| `pnpm db:generate` | Generate a new database migration |
| `pnpm db:migrate` | Apply pending migrations to the **ops** DB (`DATABASE_URL` / embedded) |
| `pnpm db:migrate:context` | Apply pending migrations to the **shared context** DB (`COMBYNE_CONTEXT_DATABASE_URL`) — designated migrator only, advisory-locked |
| `pnpm db:backup` | Run a manual backup of the **ops** DB (ops-only by design — see the runbook for context-DB DR) |
| `pnpm combyne run` | One-command setup + diagnostics + start |
| `pnpm combyne doctor` | Run diagnostics and optionally repair |
| `pnpm combyne onboard` | Interactive first-time setup |
| `pnpm combyne configure` | Update instance configuration |

### Database Changes

When modifying the data model:

```bash
# 1. Edit schema files
#    packages/db/src/schema/*.ts

# 2. Generate migration
pnpm db:generate

# 3. Verify everything compiles
pnpm typecheck

# 4. Restart dev server (ops-DB migrations auto-apply)
pnpm dev
```

> Migrations are **split** across the 2-DB model: `pnpm db:migrate` (auto-applied on dev boot)
> targets the **ops** DB, while `pnpm db:migrate:context` targets the **shared context** DB and is run
> once by the designated migrator (`COMBYNE_CONTEXT_DB_MIGRATE=true`). See [doc/DATABASE.md](doc/DATABASE.md).

### Verification Checklist

Before submitting changes, run:

```bash
pnpm typecheck    # Type checking
pnpm test:run     # Unit tests
pnpm build        # Full build
```

<br/>

---

## Docker

### One-command quickstart (recommended)

```bash
# Generate a stable auth secret (store it somewhere — you'll need it on every restart)
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)

docker compose -f docker-compose.quickstart.yml up --build
```

Then open **http://localhost:3100** and follow the onboarding wizard.

The quickstart compose file:
- Builds the `ade` image from the local `Dockerfile`
- Persists data in the `ade_data` named volume (`~/.combyne` inside the container)
- Binds to `:3100` on the host
- Runs the embedded PostgreSQL inside the container — no separate DB service required

### Manual docker run

```bash
docker build -t ade .
docker run --name ade \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e COMBYNE_HOME=/ade \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-ade:/ade" \
  ade
```

Pass API keys for your agent providers:

```bash
docker run --name ade \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v "$(pwd)/data/docker-ade:/ade" \
  ade
```

See [doc/DOCKER.md](doc/DOCKER.md) for full Docker documentation.

<br/>

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Dashboard (React)           │
│          http://localhost:3100               │
└──────────────────┬──────────────────────────┘
                   │ REST API + WebSocket
┌──────────────────▼──────────────────────────┐
│              API Server (Express)            │
│  Routes · Services · Governance · Heartbeat │
└──────┬───────────┬──────────────┬───────────┘
       │           │              │
┌──────▼──┐  ┌─────▼─────┐  ┌────▼────────┐
│ Database │  │  Adapters  │  │ Integrations│
│ (Drizzle │  │ Claude,    │  │ Jira,GitHub │
│  + PG)   │  │ Codex,...  │  │ Confluent,  │
└──────────┘  └───────────┘  │ SonarQube   │
                              └─────────────┘
```

**Key concepts:**
- **Companies** — isolated tenants with their own agents, goals, and budgets
- **Agents** — AI workers connected through adapters, managed via heartbeats
- **Issues** — tasks assigned to agents with full audit trail
- **Governance** — board-level approval gates for hires, strategy, and budget
- **Cost control** — per-agent monthly budgets with automatic pause on limit

<br/>

---

## Integrations

| Integration | Capabilities |
|-------------|-------------|
| **Jira** | Bidirectional issue sync, create/update tickets, field mapping |
| **GitHub** | PR workflows, agent-driven code review |
| **Confluent Cloud** | Kafka topic management, message production |
| **SonarQube** | Code quality analysis integration |

Configure integrations per-company via **Settings > Integrations** in the dashboard.

<br/>

---

## Troubleshooting

### Server won't start / port in use

```bash
# Check if something is already on port 3100
lsof -i :3100

# Kill it or use a different port
PORT=3200 pnpm dev
```

### Database errors after update

```bash
# Reset the embedded database (dev only)
rm -rf ~/.combyne/instances/default/db
pnpm dev
```

### Agent adapter not found

Make sure the agent CLI is installed and in your PATH. The server's `/api/health` response includes an `adapters` object showing which ones it could resolve:

```bash
curl -s http://localhost:3100/api/health | jq .adapters
```

If a CLI is missing, install it (see [Prerequisites](#prerequisites) for the full list) or run:

```bash
pnpm combyne doctor --repair
```

`combyne doctor` checks every adapter binary one by one and prints a per-adapter pass/warn line with the install command.

### Stale PostgreSQL lock file

If the server crashes and leaves a lock file:

```bash
# The server auto-detects and removes stale locks on next start
pnpm dev
```

<br/>

---

## macOS Standalone App

A native macOS app (Swift + WKWebView) is available for Apple Silicon:

```bash
./StandAloneAppleSiliconInstaller/build-standalone-dmg.sh
```

This creates a self-contained `.dmg` with bundled Node.js, server, UI, and embedded PostgreSQL. No prerequisites on the target machine (macOS 13+ required).

See [APP_INSTALL.md](APP_INSTALL.md) for details.

<br/>

---

## Documentation

| Document | Description |
|----------|-------------|
| [APP_INSTALL.md](APP_INSTALL.md) | macOS standalone app guide |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidelines |
| [doc/DEVELOPING.md](doc/DEVELOPING.md) | Full development guide (incl. the local-first 2-DB dev flow) |
| [doc/SPEC.md](doc/SPEC.md) | Product specification |
| [doc/DATABASE.md](doc/DATABASE.md) | Database reference — the 2-DB model + migration split |
| [doc/CLI.md](doc/CLI.md) | CLI command reference |
| [doc/DOCKER.md](doc/DOCKER.md) | Docker deployment guide |
| [doc/RELEASING.md](doc/RELEASING.md) | Release process |
| [doc/CENTRAL_DB_RUNBOOK.md](doc/CENTRAL_DB_RUNBOOK.md) | Stand up + operate the shared context DB (DevOps hand-off) |
| [doc/LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md](doc/LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md) | Local-first + shared-context architecture and end-to-end stand-up |
| [doc/TWO_DB_TESTING_PLAYBOOK.md](doc/TWO_DB_TESTING_PLAYBOOK.md) | 2-DB hardening test procedure + per-hop trace |
| [doc/IMPROVEMENT_PLAN.md](doc/IMPROVEMENT_PLAN.md) | Retrieval + agent-behavior improvement roadmap |
| [doc/INFRA_FIXES_PLAN.md](doc/INFRA_FIXES_PLAN.md) | 2-DB infra-fixes roadmap (config wiring, company-pin, backups, docs, RLS) |

<br/>

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Quick version:**
1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Run `pnpm typecheck && pnpm test:run && pnpm build`
5. Open a PR

<br/>

---

## License

MIT &copy; 2026

<br/>

---

<p align="center">
  <sub>ADE — The Agent Development Environment. Build companies, not just code.</sub>
</p>
