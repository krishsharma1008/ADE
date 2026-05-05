// Hire-agent playbook — injected into the context preamble whenever the
// current issue reads as a hire request AND the agent has permission to
// create agents. Fixes the "CEO says 'standing by' even after user asks
// for a new agent" regression Krish flagged — previously the ceo-bootstrap
// SKILL only fired on the first top-level issue, so hire intent on every
// subsequent issue was effectively invisible to the agent.

export interface HireIntentIssue {
  title: string;
  description: string | null;
}

export interface HireIntentAgent {
  id: string;
  role: string;
  permissions?: Record<string, unknown> | null;
}

const HIRE_KEYWORDS: RegExp[] = [
  /\bcreate\s+(?:a\s+)?(?:new\s+)?agent\b/i,
  /\bhire\s+(?:a\s+|an\s+)?(?:new\s+)?(?:agent|engineer|developer|sdet|qa|pm|designer|analyst)\b/i,
  /\bonboard\s+(?:a\s+|an\s+)?(?:new\s+)?(?:agent|engineer|developer|sdet|qa)\b/i,
  /\badd\s+(?:a\s+|an\s+)?(?:new\s+)?agent\b/i,
  /\bspin\s+up\s+(?:a\s+|an\s+)?(?:new\s+)?agent\b/i,
  /\brecruit\s+(?:a\s+|an\s+)?(?:new\s+)?(?:agent|engineer|developer|sdet|qa|pm|designer|analyst)\b/i,
  /\bnew\s+hire\b/i,
];

export function detectHireIntent(issue: HireIntentIssue | null | undefined): boolean {
  if (!issue) return false;
  const text = [issue.title ?? "", issue.description ?? ""].join("\n").trim();
  if (!text) return false;
  return HIRE_KEYWORDS.some((re) => re.test(text));
}

/**
 * Returns true when the caller is allowed to create hire approvals. Treats
 * a `ceo` role as implicitly having the permission (matches the existing
 * canCreateAgents check in server/src/routes/issues.ts and routes/agents.ts).
 */
export function agentCanHire(agent: HireIntentAgent | null | undefined): boolean {
  if (!agent) return false;
  if (agent.role === "ceo") return true;
  if (!agent.permissions) return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
}

export interface BuildHirePlaybookOptions {
  companyId: string;
  issue: HireIntentIssue;
  agentName?: string;
}

export function buildHirePlaybook(opts: BuildHirePlaybookOptions): string {
  const titlePreview = opts.issue.title?.trim().slice(0, 140) || "(no title)";
  const descPreview = (opts.issue.description ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ")
    .slice(0, 240);

  return [
    `# Hire-agent playbook — this issue reads as a hire request`,
    ``,
    `**Issue**: ${titlePreview}${descPreview ? ` — _${descPreview}_` : ""}`,
    ``,
    `You (the agent working this issue) have permission to create agents. **Do not "stand by"** — the user is explicitly asking you to add to the team. Run the flow below; do not silently skip.`,
    ``,
    `## Step 1 — Clarify any missing details`,
    ``,
    `If the title / description is ambiguous (for example "lending engineer" alone), call \`/ask-user\` with the concrete questions you need answered. At minimum you should know:`,
    `- **Role & title** ("Founding Engineer", "SDET", "Lending API PM", …)`,
    `- **Adapter** — claude_local / codex_local / opencode_local / cursor / gemini_local / pi_local / process / http / openclaw_gateway`,
    `- **Reports to** — which existing agent is the new hire's manager (or null)`,
    `- **Budget** — monthly spend ceiling in cents`,
    `- **Instructions file path** — the \`AGENTS.md\` (or equivalent) this agent should load as its system prompt`,
    ``,
    `Use \`/ask-user\` with structured \`choices[]\` when the answer is one-of-a-known-set (e.g. the adapter list). The Reply-and-Wake UI will render a proper QuestionAnswerCard.`,
    ``,
    `## Step 2 — Post a hire_agent approval`,
    ``,
    `Once you have enough to propose a hire, POST:`,
    ``,
    "```",
    `POST {{COMBYNE_API_URL}}/api/companies/${opts.companyId}/approvals`,
    `Authorization: Bearer {{COMBYNE_API_KEY}}`,
    `Content-Type: application/json`,
    ``,
    `{`,
    `  "type": "hire_agent",`,
    `  "title": "Hire <agent name>",`,
    `  "payload": {`,
    `    "name": "<agent name>",`,
    `    "role": "<engineer | pm | sdet | designer | …>",`,
    `    "title": "<job title>",`,
    `    "capabilities": "<one-line description>",`,
    `    "adapterType": "claude_local",`,
    `    "adapterConfig": { "cwd": "/absolute/project/path", "instructionsFilePath": "/absolute/path/to/AGENTS.md" },`,
    `    "runtimeConfig": {},`,
    `    "permissions": {},`,
    `    "budgetMonthlyCents": 200000,`,
    `    "reportsTo": "<parent-agent-id-or-null>"`,
    `  },`,
    `  "issueIds": ["<this-issue-id>"]`,
    `}`,
    "```",
    ``,
    `When \`runtimeConfig.heartbeat.maxConcurrentRuns\` is omitted, Combyne defaults coordinator hires such as CEO/CTO/PM/EM to 3 concurrent runs and IC coding/QA/devops agents to 1. Override it only when the board explicitly asks for stricter or broader execution.`,
    ``,
    `## Step 3 — Explain the hire`,
    ``,
    `Post a comment on this issue (not a question) summarising _why_ this hire, _what they'll own_, and their first week of work. The board approver will read this alongside the approval.`,
    ``,
    `## Step 4 — Wait for approval`,
    ``,
    `Do **not** try to manually create the agent any other way — the approval flow is the only path; it enforces budget, governance, and audit. Once approved, Combyne auto-creates the agent and wakes the \`onHireApproved\` lifecycle hook. If rejected, surface the reject reason in a comment and ask the user what to change.`,
    ``,
    `## Step 5 — Transition the issue`,
    ``,
    `After posting the approval, flip this issue's status to \`awaiting_user\` (the approval blocks the next step). Do not close it until the hire has actually been made.`,
  ].join("\n");
}
