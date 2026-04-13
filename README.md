<p align="center">
  <img src="doc/assets/header.png" alt="ADE — Agent Development Environment" width="720" />
</p>

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

| Requirement | Version | Install |
|-------------|---------|---------|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org) or `brew install node` |
| **pnpm** | 9+ | `npm install -g pnpm` |

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

## Configuration

### Environment Variables

ADE works out of the box with zero configuration. All settings below are **optional**.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *(embedded PostgreSQL)* | Use an external PostgreSQL instead of embedded |
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `3100` | Server port |
| `COMBYNE_HOME` | `~/.combyne` | Data directory root |
| `COMBYNE_INSTANCE_ID` | `default` | Instance identifier (for multi-instance setups) |
| `COMBYNE_DB_BACKUP_ENABLED` | `true` | Enable automatic database backups |
| `COMBYNE_DB_BACKUP_INTERVAL_MINUTES` | `60` | Backup frequency |
| `COMBYNE_DB_BACKUP_RETENTION_DAYS` | `30` | How long to keep backups |
| `COMBYNE_SECRETS_STRICT_MODE` | `false` | Require secret references for API keys/tokens |

### Database Modes

| Mode | When | Setup |
|------|------|-------|
| **Embedded PostgreSQL** | Local dev (default) | Leave `DATABASE_URL` unset — fully automatic |
| **External PostgreSQL** | Production / teams | Set `DATABASE_URL=postgres://user:pass@host:5432/dbname` |

Data is stored at `~/.combyne/instances/default/db` in embedded mode.

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
| `pnpm db:migrate` | Apply pending database migrations |
| `pnpm db:backup` | Run a manual database backup |
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

# 4. Restart dev server (migrations auto-apply)
pnpm dev
```

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

### Quick Start

```bash
docker build -t ade .
docker run --name ade \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e COMBYNE_HOME=/ade \
  -v "$(pwd)/data/docker-ade:/ade" \
  ade
```

### Docker Compose

```bash
docker compose -f docker-compose.quickstart.yml up --build
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

Make sure the agent CLI is installed and in your PATH:

```bash
# Claude Code
claude --version

# Codex
codex --version

# Run diagnostics
pnpm combyne doctor --repair
```

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
| [doc/DEVELOPING.md](doc/DEVELOPING.md) | Full development guide |
| [doc/SPEC.md](doc/SPEC.md) | Product specification |
| [doc/DATABASE.md](doc/DATABASE.md) | Database schema reference |
| [doc/CLI.md](doc/CLI.md) | CLI command reference |
| [doc/DOCKER.md](doc/DOCKER.md) | Docker deployment guide |
| [doc/RELEASING.md](doc/RELEASING.md) | Release process |

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
