---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm combyne issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm combyne issue get <issue-id-or-identifier>

# Create issue
pnpm combyne issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm combyne issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm combyne issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm combyne issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm combyne issue release <issue-id>
```

## Company Commands

```sh
pnpm combyne company list
pnpm combyne company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm combyne company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm combyne company import \
  --from https://github.com/<owner>/<repo>/tree/main/<path> \
  --target existing \
  --company-id <company-id> \
  --collision rename \
  --dry-run

# Apply import
pnpm combyne company import \
  --from ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm combyne agent list
pnpm combyne agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm combyne approval list [--status pending]

# Get approval
pnpm combyne approval get <approval-id>

# Create approval
pnpm combyne approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm combyne approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm combyne approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm combyne approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm combyne approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm combyne approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm combyne activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm combyne dashboard get
```

## Heartbeat

```sh
pnpm combyne heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
