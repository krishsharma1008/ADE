---
name: ceo-bootstrap
description: >
  Executed by a CEO-role agent the first time a top-level issue is assigned to
  them in a new company. Walks the CEO through a scripted bootstrap analysis:
  scan the workspace, draft a findings document, propose agent hires (gated by
  approvals), ask clarifying questions, and transition the issue to
  awaiting_user until the human responds.
---

# CEO Bootstrap Playbook

You are the CEO-role agent and this is the first top-level issue that has ever
been assigned to you in this company. Before you delegate anything or do any
direct implementation work, run the following bootstrap sequence. It exists so
the human operator has a clear picture of the team you're about to build and
the work you're about to delegate.

## Step 1 — Scan the workspace

Read, in order of priority:
1. `README.md`, `AGENTS.md`, `SPEC.md`, `CONTRIBUTING.md` (if present).
2. `package.json` (or equivalent manifest — `pyproject.toml`, `Cargo.toml`, `go.mod`).
3. The top-level directory listing — understand the layout in one pass.
4. Any `docs/` or `doc/` folder, shallow-only.

Do not deep-read source files yet; the goal is to understand the **shape** of
the codebase, not to fix it.

## Step 2 — Write a findings document

Create (or update) a document on this issue via
`POST /api/companies/:companyId/issues/:issueId/documents` with `key="ceo-bootstrap-findings"`.
Structure:

```
# Bootstrap analysis — <company name>

## What this codebase is
<2-3 sentences>

## What the user asked for
<restate the issue title/description in your own words>

## What I'll need to deliver it
- Proposed hires: <role, title, adapter, why>
- Constraints I noticed: <build tooling, style, infra>
- Open questions: <numbered list>
```

Keep it under 400 lines.

## Step 3 — Propose agent hires

For each role you want to add, submit a `hire_agent` approval via
`POST /api/companies/:companyId/approvals` with:
- `kind: "hire_agent"`
- `payload: { role, title, adapterType, adapterConfig, reportsToAgentId: <your-agent-id> }`
- `linkedIssueIds: [<this-issue-id>]`

Do **not** create agents directly — always go through the approval. The human
will approve or deny in the UI.

Common first hires for a new engineering company:
- `role: "engineer"`, adapter `claude_local` or `codex_local` — for implementation.
- `role: "designer"`, adapter `cursor_local` or `claude_local` — for UI/UX work.
- `role: "qa"` — once there's something worth testing.

Only propose hires you can justify from the findings you just wrote.

## Step 4 — Ask clarifying questions

Call the `ask_user` action (`POST /api/companies/:companyId/issues/:issueId/ask-user`
body `{ question, fromAgentId: <your-id> }`). One endpoint call per question is
fine; the endpoint transitions the issue to `awaiting_user` the first time. Use
this to ask anything you genuinely need to know before delegating — target
deadline, style preferences, scope boundaries.

## Step 5 — Stop

Do not delegate sub-issues yet. The next wake will happen when the user
answers — at that point the issue flips back to `in_progress` and you resume,
pick up the approved hires, and call `POST /api/companies/:companyId/issues/:issueId/delegate`
with one body per sub-agent you want to hand work off to.

## Guard rails

- Never spawn your own sub-agents outside the `hire_agent` approval flow.
- Never write code directly during the bootstrap run — delegate.
- Never mark this issue `done` during bootstrap — the human closes it when the
  overarching goal is achieved.
- If the codebase is empty (no `README.md`, no manifest), note that explicitly
  in the findings document and ask whether the user wants you to scaffold a
  fresh project or if they'll point you at an existing repo.
