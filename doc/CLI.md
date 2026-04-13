# CLI Reference

Combyne CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm combyne --help
```

First-time local bootstrap + run:

```sh
pnpm combyne run
```

Choose local instance:

```sh
pnpm combyne run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `combyne-ai onboard` and `combyne-ai configure --section server` set deployment mode in config
- runtime can override mode with `COMBYNE_DEPLOYMENT_MODE`
- `combyne-ai run` and `combyne-ai doctor` do not yet expose a direct `--mode` flag

Target behavior (planned) is documented in `doc/DEPLOYMENT-MODES.md` section 5.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm combyne allowed-hostname dotta-macbook-pro
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.combyne`:

```sh
pnpm combyne run --data-dir ./tmp/combyne-dev
pnpm combyne issue list --data-dir ./tmp/combyne-dev
```

## Context Profiles

Store local defaults in `~/.combyne-ai/context.json`:

```sh
pnpm combyne context set --api-base http://localhost:3100 --company-id <company-id>
pnpm combyne context show
pnpm combyne context list
pnpm combyne context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm combyne context set --api-key-env-var-name COMBYNE_API_KEY
export COMBYNE_API_KEY=...
```

## Company Commands

```sh
pnpm combyne company list
pnpm combyne company get <company-id>
pnpm combyne company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm combyne company delete PAP --yes --confirm PAP
pnpm combyne company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `COMBYNE_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `COMBYNE_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm combyne issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm combyne issue get <issue-id-or-identifier>
pnpm combyne issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm combyne issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm combyne issue comment <issue-id> --body "..." [--reopen]
pnpm combyne issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm combyne issue release <issue-id>
```

## Agent Commands

```sh
pnpm combyne agent list --company-id <company-id>
pnpm combyne agent get <agent-id>
pnpm combyne agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Combyne agent:

- creates a new long-lived agent API key
- installs missing Combyne skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `COMBYNE_API_URL`, `COMBYNE_COMPANY_ID`, `COMBYNE_AGENT_ID`, and `COMBYNE_API_KEY`

Example for shortname-based local setup:

```sh
pnpm combyne agent local-cli codexcoder --company-id <company-id>
pnpm combyne agent local-cli claudecoder --company-id <company-id>
```

## Approval Commands

```sh
pnpm combyne approval list --company-id <company-id> [--status pending]
pnpm combyne approval get <approval-id>
pnpm combyne approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm combyne approval approve <approval-id> [--decision-note "..."]
pnpm combyne approval reject <approval-id> [--decision-note "..."]
pnpm combyne approval request-revision <approval-id> [--decision-note "..."]
pnpm combyne approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm combyne approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm combyne activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm combyne dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm combyne heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Default local instance root is `~/.combyne-ai/instances/default`:

- config: `~/.combyne-ai/instances/default/config.json`
- embedded db: `~/.combyne-ai/instances/default/db`
- logs: `~/.combyne-ai/instances/default/logs`
- storage: `~/.combyne-ai/instances/default/data/storage`
- secrets key: `~/.combyne-ai/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
COMBYNE_HOME=/custom/home COMBYNE_INSTANCE_ID=dev pnpm combyne run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm combyne configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
