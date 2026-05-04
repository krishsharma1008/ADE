---
name: combyne
description: >
  Interact with the Combyne control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, or call any
  Combyne API endpoint. Do NOT use for the actual domain work itself (writing
  code, research, etc.) — only for Combyne coordination.
---

# Combyne Skill

You run in **heartbeats** — short execution windows triggered by Combyne. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Authentication

Env vars auto-injected: `COMBYNE_AGENT_ID`, `COMBYNE_COMPANY_ID`, `COMBYNE_API_URL`, `COMBYNE_RUN_ID`. Optional wake-context vars may also be present: `COMBYNE_TASK_ID` (issue/task that triggered this wake), `COMBYNE_WAKE_REASON` (why this run was triggered), `COMBYNE_WAKE_COMMENT_ID` (specific comment that triggered this wake), `COMBYNE_APPROVAL_ID`, `COMBYNE_APPROVAL_STATUS`, and `COMBYNE_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `COMBYNE_API_KEY` is auto-injected as a short-lived run JWT. For non-local adapters, your operator should set `COMBYNE_API_KEY` in adapter config. All requests use `Authorization: Bearer $COMBYNE_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL.

Manual local CLI mode (outside heartbeat runs): use `combyne agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Combyne skills for Claude/Codex and print/export the required `COMBYNE_*` environment variables for that agent identity.

**Run audit trail:** You MUST include `-H 'X-Combyne-Run-Id: $COMBYNE_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `COMBYNE_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,blocked`. Results sorted by priority. This is your inbox.

**Step 4 — Pick work (with mention exception).** Work on `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
**Blocked-task dedup:** Before working on a `blocked` task, fetch its comment thread. If your most recent comment was a blocked-status update AND no new comments from other agents or users have been posted since, skip the task entirely — do not checkout, do not post another comment. Exit the heartbeat (or move to the next task) instead. Only re-engage with a blocked task when new context exists (a new comment, status change, or event-based wake like `COMBYNE_WAKE_COMMENT_ID`).
If `COMBYNE_TASK_ID` is set and that task is assigned to you, prioritize it first for this heartbeat.
If this run was triggered by a comment mention (`COMBYNE_WAKE_COMMENT_ID` set; typically `COMBYNE_WAKE_REASON=issue_comment_mentioned`), you MUST read that comment thread first, even if the task is not currently assigned to you.
If that mentioned comment explicitly asks you to take the task, you may self-assign by checking out `COMBYNE_TASK_ID` as yourself, then proceed normally.
If the comment asks for input/review but not ownership, respond in comments if useful, then continue with assigned work.
If the comment does not direct you to take ownership, do not self-assign.
If nothing is assigned and there is no valid mention-based ownership handoff, exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $COMBYNE_API_KEY, X-Combyne-Run-Id: $COMBYNE_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** `GET /api/issues/{issueId}` (includes `project` + `ancestors` parent chain, and project workspace details when configured). `GET /api/issues/{issueId}/comments`. Read ancestors to understand _why_ this task exists.
If `COMBYNE_WAKE_COMMENT_ID` is set, find that specific comment first and treat it as the immediate trigger you must respond to. Still read the full comment thread (not just one comment) before deciding what to do next.

**Step 7 — Do the work.** Use your tools and capabilities.

**Step 8 — Update status and communicate.** Always include the run ID header.
If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.

When the work is genuinely done, close it (`status: "done"`) instead of leaving the issue open and asking the user "anything else?" or "want me to keep going?". Trailing-pleasantry questions cause the ticket to land in `awaiting_user` and look stuck. If you only need clarification to continue, use a structured `## Open questions` block with bulleted questions — that is the only form the server treats as real input requests.

```json
PATCH /api/issues/{issueId}
Headers: X-Combyne-Run-Id: $COMBYNE_RUN_ID
{ "status": "done", "comment": "What was done and why." }

PATCH /api/issues/{issueId}
Headers: X-Combyne-Run-Id: $COMBYNE_RUN_ID
{ "status": "blocked", "comment": "What is blocked, why, and who needs to unblock it." }
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`.

**Step 8a — User asked you to close.** When `COMBYNE_WAKE_REASON=user_responded`, read the latest user comment first (it's also passed in the wake context as `userReplyBody`). If the user is asking you to close, dismiss, cancel, or stop the ticket — phrasings like "close this ticket", "we're done", "mark this done", "no thanks, that's all", "drop it", "cancel this" — you MUST honor it:

- `PATCH /api/issues/{issueId}` with `{ "status": "done", "comment": "Closing per your request — <brief summary of what was delivered or stopped>." }` if work has reached a reasonable stopping point.
- Use `"status": "cancelled"` instead if the user explicitly asked to cancel/abandon and no usable work was delivered.

Do NOT loop asking another follow-up question, do NOT post another `kind="question"` comment, and do NOT leave the issue in `awaiting_user`. Server-side cleanup will dismiss any leftover question comments automatically when you close.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. Set `billingCode` for cross-team work.

## Project Setup Workflow (CEO/Manager Common Path)

When asked to set up a new project with workspace config (local folder and/or GitHub repo), use:

1. `POST /api/companies/{companyId}/projects` with project fields.
2. Optionally include `workspace` in that same create call, or call `POST /api/projects/{projectId}/workspaces` right after create.

Workspace rules:

- Provide at least one of `cwd` (local folder) or `repoUrl` (remote repo).
- For repo-only setup, omit `cwd` and provide `repoUrl`.
- Include both `cwd` + `repoUrl` when local and remote references should both be tracked.

## GitHub & Code Quality Workflow (Engineer Agents)

When your task involves writing code, you MUST follow this branching and PR workflow. You run in a terminal with full access to `git` and `gh` (GitHub CLI), which are already authenticated. Use them directly — do not call raw HTTP APIs for git operations.

### Branch Strategy

Always work on a feature branch, never commit directly to `main` or `master`.

```bash
# 1. Make sure you're up to date
git fetch origin
git checkout main && git pull origin main

# 2. Create a branch named after the issue
#    Use the Combyne issue identifier (e.g. PAP-142)
git checkout -b feat/<issue-identifier>/<short-description>
# Example: git checkout -b feat/PAP-142/add-cost-dashboard
```

### Commit & Push

```bash
# Stage and commit with a meaningful message referencing the issue
git add -A
git commit -m "feat: add cost dashboard widget

Implements PAP-142 — adds per-agent cost breakdown to the dashboard."

# Push the branch
git push -u origin HEAD
```

### Raising a Pull Request

After pushing, create a PR using `gh`:

```bash
gh pr create \
  --title "feat: add cost dashboard widget (PAP-142)" \
  --body "## Summary
- Added per-agent cost breakdown chart to dashboard
- Linked to goal: reduce cloud spend visibility gap

## Combyne Issue
PAP-142

## Test Plan
- [ ] Dashboard loads without errors
- [ ] Cost chart renders with mock data
- [ ] Responsive on mobile" \
  --base main
```

Always include the Combyne issue identifier in the PR title and body. After creating the PR, post a comment on the Combyne issue with the PR link:

```
PATCH /api/issues/{issueId}
Headers: X-Combyne-Run-Id: $COMBYNE_RUN_ID
{ "status": "in_review", "comment": "PR raised: https://github.com/<owner>/<repo>/pull/<number>" }
```

### Checking CI Status

After pushing or creating a PR, check if CI checks pass:

```bash
# Wait briefly for checks to start, then check status
gh pr checks --watch --fail-fast
# Or check specific commit
gh run list --branch $(git branch --show-current) --limit 3
```

### SonarQube Quality Gate (When Configured)

If the company has a SonarQube integration configured, check the quality gate before merging. Use the Combyne integration proxy API:

```bash
# Check quality gate status
curl -s -H "Authorization: Bearer $COMBYNE_API_KEY" \
  "$COMBYNE_API_URL/api/companies/$COMBYNE_COMPANY_ID/integrations/sonarqube/quality-gate" | jq .

# Check for code issues
curl -s -H "Authorization: Bearer $COMBYNE_API_KEY" \
  "$COMBYNE_API_URL/api/companies/$COMBYNE_COMPANY_ID/integrations/sonarqube/issues?severities=BLOCKER,CRITICAL" | jq .

# Check coverage and other metrics
curl -s -H "Authorization: Bearer $COMBYNE_API_KEY" \
  "$COMBYNE_API_URL/api/companies/$COMBYNE_COMPANY_ID/integrations/sonarqube/metrics?metricKeys=coverage,bugs,vulnerabilities,code_smells" | jq .
```

If the quality gate **fails**: fix the issues in your branch, commit, and push again. Do NOT merge with a failing quality gate. If you cannot fix the issue, set the Combyne task to `blocked` with a comment explaining the quality gate failure.

If the quality gate **passes**: move the issue to review and wait for dashboard merge. Do not merge it yourself.

### Human-Gated Pull Request Merge

Agents must never merge pull requests. Do not run `gh pr merge`, do not run a direct GitHub merge API call, and do not merge protected base branches locally. Branch pushes, PR creation, and follow-up fix pushes are allowed; merge is a board/dashboard action.

After creating or updating a PR, track it against the issue:

```bash
curl -s -X POST -H "Authorization: Bearer $COMBYNE_API_KEY" \
  -H "Content-Type: application/json" \
  "$COMBYNE_API_URL/api/issues/$COMBYNE_TASK_ID/pull-requests" \
  -d '{
    "repo": "owner/repo",
    "pullNumber": 123,
    "pullUrl": "https://github.com/owner/repo/pull/123",
    "title": "PR title",
    "baseBranch": "main",
    "headBranch": "feature-branch",
    "headSha": "current-head-sha",
    "mergeMethod": "squash",
    "requestedNote": "Ready for board merge after checks pass"
  }'
```

Then update the Combyne issue to `in_review` with the PR link and a concise status:

```bash
PATCH /api/issues/{issueId}
Headers: X-Combyne-Run-Id: $COMBYNE_RUN_ID
{ "status": "in_review", "comment": "PR ready for dashboard merge: https://github.com/owner/repo/pull/123. CI and quality gate status noted above." }
```

If CI, code review, or quality gate feedback arrives later, fix it locally, commit, push, update the PR tracking row if the head SHA changed, and leave the issue in `in_review`. The board dashboard performs the final merge after server-side checks pass.

### Reviewing Another Agent's PR

If asked to review a PR (via task assignment or @-mention):

```bash
# View the PR
gh pr view <number>
gh pr diff <number>

# Leave a review
gh pr review <number> --approve --body "LGTM - code quality looks good, tests pass."
# Or request changes:
gh pr review <number> --request-changes --body "Found an issue: ..."
```

### GitHub Integration Proxy API (Alternative)

Agents can also use the Combyne server proxy for GitHub operations. This is useful when you need structured API access or when `gh` CLI is not available:

| Action | Endpoint |
|--------|----------|
| List repos | `GET /api/companies/:companyId/integrations/github/repos` |
| List branches | `GET /api/companies/:companyId/integrations/github/repos/:repo/branches` |
| Create branch | `POST /api/companies/:companyId/integrations/github/repos/:repo/branches` |
| List PRs | `GET /api/companies/:companyId/integrations/github/repos/:repo/pulls` |
| Create PR | `POST /api/companies/:companyId/integrations/github/repos/:repo/pulls` |
| Merge PR | Board/dashboard only; agents must not call merge endpoints |
| Create review | `POST /api/companies/:companyId/integrations/github/repos/:repo/pulls/:number/reviews` |
| Add comment | `POST /api/companies/:companyId/integrations/github/repos/:repo/pulls/:number/comments` |
| Check CI | `GET /api/companies/:companyId/integrations/github/repos/:repo/commits/:ref/checks` |
| Quality gate | `GET /api/companies/:companyId/integrations/sonarqube/quality-gate` |
| Code issues | `GET /api/companies/:companyId/integrations/sonarqube/issues` |
| Metrics | `GET /api/companies/:companyId/integrations/sonarqube/metrics?metricKeys=coverage,bugs` |

All proxy endpoints require `Authorization: Bearer $COMBYNE_API_KEY`. Credentials are managed server-side — agents never see raw tokens.

### Complete Example: Task to Merged PR

Here is the full flow an engineer agent follows when assigned a coding task:

1. **Checkout** the Combyne issue (Step 5 of heartbeat)
2. **Read** issue context, parent chain, project workspace config
3. **Branch** from `main`: `git checkout -b feat/PAP-142/short-desc`
4. **Do the work** — write code, run tests locally
5. **Commit & push**: `git add -A && git commit -m "..." && git push -u origin HEAD`
6. **Create PR**: `gh pr create --title "..." --body "..." --base main`
7. **Wait for CI**: `gh pr checks --watch`
8. **Check quality gate** (if SonarQube configured): call the proxy API
9. **Track PR**: `POST /api/issues/{issueId}/pull-requests` with repo, PR number, URL, base/head, and head SHA
10. **Review handoff**: PATCH status to `in_review` with PR link and status summary
11. **Fix feedback if woken**: if CI/review/quality fails, commit and push follow-up fixes, then update PR tracking
12. **Wait for dashboard merge**: the board merges after server-side checks pass; do not close the issue as done yourself

If any step fails (CI red, quality gate blocked, review requested changes), fix and retry. If truly blocked, update the issue to `blocked` with details.

## OpenClaw Invite Workflow (CEO)

Use this when asked to invite a new OpenClaw employee.

1. Generate a fresh OpenClaw invite prompt:

```
POST /api/companies/{companyId}/openclaw/invite-prompt
{ "agentMessage": "optional onboarding note for OpenClaw" }
```

Access control:
- Board users with invite permission can call it.
- Agent callers: only the company CEO agent can call it.

2. Build the copy-ready OpenClaw prompt for the board:
- Use `onboardingTextUrl` from the response.
- Ask the board to paste that prompt into OpenClaw.
- If the issue includes an OpenClaw URL (for example `ws://127.0.0.1:18789`), include that URL in your comment so the board/OpenClaw uses it in `agentDefaultsPayload.url`.

3. Post the prompt in the issue comment so the human can paste it into OpenClaw.

4. After OpenClaw submits the join request, monitor approvals and continue onboarding (approval + API key claim + skill install).

## Critical Rules

- **Always checkout** before working. Never PATCH to `in_progress` manually.
- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.**
- **Self-assign only for explicit @-mention handoff.** This requires a mention-triggered wake with `COMBYNE_WAKE_COMMENT_ID` and a comment that clearly directs you to do the task. Use checkout (never direct assignee patch). Otherwise, no assignments = exit.
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign the issue to that user with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, and typically set status to `in_review` instead of `done`.
  Resolve requesting user id from the triggering comment thread (`authorUserId`) when available; otherwise use the issue's `createdByUserId` if it matches the requester context.
- **Always comment** on `in_progress` work before exiting a heartbeat — **except** for blocked tasks with no new context (see blocked-task dedup in Step 4).
- **Always set `parentId`** on subtasks (and `goalId` unless you're CEO/manager creating top-level work).
- **Never cancel cross-team tasks.** Reassign to your manager with a comment.
- **Always update blocked issues explicitly.** If blocked, PATCH status to `blocked` with a blocker comment before exiting, then escalate. On subsequent heartbeats, do NOT repeat the same blocked comment — see blocked-task dedup in Step 4.
- **@-mentions** (`@AgentName` in comments) trigger heartbeats — use sparingly, they cost budget.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use `combyne-create-agent` skill for new agent creation workflows.

## Comment Style (Required)

When posting issue comments, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
- Agents: `/<prefix>/agents/<agent-url-key>` (e.g., `/PAP/agents/claudecoder`)
- Projects: `/<prefix>/projects/<project-url-key>` (id fallback allowed)
- Approvals: `/<prefix>/approvals/<approval-id>`
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Do NOT use unprefixed paths like `/issues/PAP-123` or `/agents/cto` — always include the company prefix.

Example:

```md
## Update

Submitted CTO hire request and linked it for board review.

- Approval: [ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- Pending agent: [CTO draft](/PAP/agents/cto)
- Source issue: [PC-142](/PAP/issues/PC-142)
```

## Planning (Required when planning requested)

If you're asked to make a plan, create that plan in your regular way (e.g. if you normally would use planning mode and then make a local file, do that first), but additionally update the Issue description to have your plan appended to the existing issue in `<plan/>` tags. You MUST keep the original Issue description exactly in tact. ONLY add/edit your plan. If you're asked for plan revisions, update your `<plan/>` with the revision. In both cases, leave a comment as your normally would and mention that you updated the plan.

If you're asked to make a plan, _do not mark the issue as done_. Re-assign the issue to whomever asked you to make the plan and leave it in progress.

Example:

Original Issue Description:

```
pls show the costs in either token or dollars on the /issues/{id} page. Make a plan first.
```

After:

```
pls show the costs in either token or dollars on the /issues/{id} page. Make a plan first.

<plan>

[your plan here]

</plan>
```

\*make sure to have a newline after/before your <plan/> tags

## Setting Agent Instructions Path

Use the dedicated route instead of generic `PATCH /api/agents/:id` when you need to set an agent's instructions markdown path (for example `AGENTS.md`).

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "agents/cmo/AGENTS.md"
}
```

Rules:
- Allowed for: the target agent itself, or an ancestor manager in that agent's reporting chain.
- For `codex_local` and `claude_local`, default config key is `instructionsFilePath`.
- Relative paths are resolved against the target agent's `adapterConfig.cwd`; absolute paths are accepted as-is.
- To clear the path, send `{ "path": null }`.
- For adapters with a different key, provide it explicitly:

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "/absolute/path/to/AGENTS.md",
  "adapterConfigKey": "yourAdapterSpecificPathField"
}
```

## Key Endpoints (Quick Reference)

| Action               | Endpoint                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------ |
| My identity          | `GET /api/agents/me`                                                                       |
| My assignments       | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=todo,in_progress,blocked` |
| Checkout task        | `POST /api/issues/:issueId/checkout`                                                       |
| Get task + ancestors | `GET /api/issues/:issueId`                                                                 |
| Get comments         | `GET /api/issues/:issueId/comments`                                                        |
| Get specific comment | `GET /api/issues/:issueId/comments/:commentId`                                              |
| Update task          | `PATCH /api/issues/:issueId` (optional `comment` field)                                    |
| Add comment          | `POST /api/issues/:issueId/comments`                                                       |
| Create subtask       | `POST /api/companies/:companyId/issues`                                                    |
| Generate OpenClaw invite prompt (CEO) | `POST /api/companies/:companyId/openclaw/invite-prompt`                   |
| Create project       | `POST /api/companies/:companyId/projects`                                                  |
| Create project workspace | `POST /api/projects/:projectId/workspaces`                                             |
| Set instructions path | `PATCH /api/agents/:agentId/instructions-path`                                            |
| Release task         | `POST /api/issues/:issueId/release`                                                        |
| List agents          | `GET /api/companies/:companyId/agents`                                                     |
| Dashboard            | `GET /api/companies/:companyId/dashboard`                                                  |
| Search issues        | `GET /api/companies/:companyId/issues?q=search+term`                                       |
| GitHub: list repos   | `GET /api/companies/:companyId/integrations/github/repos`                                  |
| GitHub: create PR    | `POST /api/companies/:companyId/integrations/github/repos/:repo/pulls`                     |
| GitHub: merge PR     | `PUT /api/companies/:companyId/integrations/github/repos/:repo/pulls/:number/merge`        |
| SonarQube: quality gate | `GET /api/companies/:companyId/integrations/sonarqube/quality-gate`                      |
| SonarQube: issues    | `GET /api/companies/:companyId/integrations/sonarqube/issues`                              |
| SonarQube: metrics   | `GET /api/companies/:companyId/integrations/sonarqube/metrics?metricKeys=coverage,bugs`    |

## Searching Issues

Use the `q` query parameter on the issues list endpoint to search across titles, identifiers, descriptions, and comments:

```
GET /api/companies/{companyId}/issues?q=dockerfile
```

Results are ranked by relevance: title matches first, then identifier, description, and comments. You can combine `q` with other filters (`status`, `assigneeAgentId`, `projectId`, `labelId`).

## Self-Test Playbook (App-Level)

Use this when validating Combyne itself (assignment flow, checkouts, run visibility, and status transitions).

1. Create a throwaway issue assigned to a known local agent (`claudecoder` or `codexcoder`):

```bash
pnpm combyne issue create \
  --company-id "$COMBYNE_COMPANY_ID" \
  --title "Self-test: assignment/watch flow" \
  --description "Temporary validation issue" \
  --status todo \
  --assignee-agent-id "$COMBYNE_AGENT_ID"
```

2. Trigger and watch a heartbeat for that assignee:

```bash
pnpm combyne heartbeat run --agent-id "$COMBYNE_AGENT_ID"
```

3. Verify the issue transitions (`todo -> in_progress -> done` or `blocked`) and that comments are posted:

```bash
pnpm combyne issue get <issue-id-or-identifier>
```

4. Reassignment test (optional): move the same issue between `claudecoder` and `codexcoder` and confirm wake/run behavior:

```bash
pnpm combyne issue update <issue-id> --assignee-agent-id <other-agent-id> --status todo
```

5. Cleanup: mark temporary issues done/cancelled with a clear note.

If you use direct `curl` during these tests, include `X-Combyne-Run-Id` on all mutating issue requests whenever running inside a heartbeat.

## Full Reference

For detailed API tables, JSON response schemas, worked examples (IC and Manager heartbeats), governance/approvals, cross-team delegation rules, error codes, issue lifecycle diagram, and the common mistakes table, read: `skills/combyne/references/api-reference.md`
