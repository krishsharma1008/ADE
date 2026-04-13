---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Combyne uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `HOST` | `127.0.0.1` | Server host binding |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `COMBYNE_HOME` | `~/.combyne` | Base directory for all Combyne data |
| `COMBYNE_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `COMBYNE_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `COMBYNE_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `COMBYNE_SECRETS_MASTER_KEY_FILE` | `~/.combyne-ai/.../secrets/master.key` | Path to key file |
| `COMBYNE_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `COMBYNE_AGENT_ID` | Agent's unique ID |
| `COMBYNE_COMPANY_ID` | Company ID |
| `COMBYNE_API_URL` | Combyne API base URL |
| `COMBYNE_API_KEY` | Short-lived JWT for API auth |
| `COMBYNE_RUN_ID` | Current heartbeat run ID |
| `COMBYNE_TASK_ID` | Issue that triggered this wake |
| `COMBYNE_WAKE_REASON` | Wake trigger reason |
| `COMBYNE_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `COMBYNE_APPROVAL_ID` | Resolved approval ID |
| `COMBYNE_APPROVAL_STATUS` | Approval decision |
| `COMBYNE_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
