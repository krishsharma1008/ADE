---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `combyne-ai run`

One-command bootstrap and start:

```sh
pnpm combyne run
```

Does:

1. Auto-onboards if config is missing
2. Runs `combyne-ai doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm combyne run --instance dev
```

## `combyne-ai onboard`

Interactive first-time setup:

```sh
pnpm combyne onboard
```

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm combyne onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm combyne onboard --yes
```

## `combyne-ai doctor`

Health checks with optional auto-repair:

```sh
pnpm combyne doctor
pnpm combyne doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `combyne-ai configure`

Update configuration sections:

```sh
pnpm combyne configure --section server
pnpm combyne configure --section secrets
pnpm combyne configure --section storage
```

## `combyne-ai env`

Show resolved environment configuration:

```sh
pnpm combyne env
```

## `combyne-ai allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm combyne allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.combyne-ai/instances/default/config.json` |
| Database | `~/.combyne-ai/instances/default/db` |
| Logs | `~/.combyne-ai/instances/default/logs` |
| Storage | `~/.combyne-ai/instances/default/data/storage` |
| Secrets key | `~/.combyne-ai/instances/default/secrets/master.key` |

Override with:

```sh
COMBYNE_HOME=/custom/home COMBYNE_INSTANCE_ID=dev pnpm combyne run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm combyne run --data-dir ./tmp/combyne-dev
pnpm combyne doctor --data-dir ./tmp/combyne-dev
```
