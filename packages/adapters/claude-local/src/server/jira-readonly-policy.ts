// Jira read-only policy for agent runs.
//
// Users who connect Jira via the Atlassian integration reported "too much
// intrusion": agents were not only reading the ticket they were assigned, they
// were mutating the board (creating/editing/transitioning issues, leaving
// comments, logging work, linking issues) AND fanning out across every linked /
// remote ticket. This module is the single source of truth that decides, for an
// agent caller, which Atlassian/Jira MCP tools are allowed (READ) and which are
// blocked (WRITE / board mutation).
//
// Why here: the Atlassian MCP tools (`mcp__claude_ai_Atlassian__*`) are exposed
// DIRECTLY to the Claude CLI by this adapter — there is no server proxy in the
// hot path for the MCP surface — so the clearest enforcement point is the
// `--disallowedTools` list we hand the CLI when we spawn a run. The Combyne REST
// Jira proxy (server/src/routes/integrations.ts) enforces the SAME policy as
// defense-in-depth for the few flows that go through it.
//
// Design rules (mirrors push-remote-allowlist.ts):
// - STRICT by default: the policy is ON unless an operator explicitly opts out.
// - Classification is conservative — anything that creates/changes/transitions/
//   comments/links/worklogs is WRITE; only get/search/fetch/list/lookup/metadata
//   reads are allowed.
// - Pure + side-effect free so it is unit-testable and reusable by the server.

/** Env flag controlling the read-only Jira policy for agents. Default ON. */
export const JIRA_AGENT_READONLY_ENV = "COMBYNE_JIRA_AGENT_READONLY";

/** Env flag bounding how many JQL/search results an agent may pull in one call. */
export const JIRA_AGENT_MAX_SEARCH_RESULTS_ENV = "COMBYNE_JIRA_AGENT_MAX_SEARCH_RESULTS";

/**
 * Default cap on JQL / issue-search result counts for agent callers. Keeps an
 * agent from auto-expanding across the whole board (the "intrusion" the user
 * complained about) while still returning enough context for the assigned task.
 */
export const DEFAULT_JIRA_AGENT_MAX_SEARCH_RESULTS = 10;

/**
 * The exact Atlassian/Jira MCP tool names that MUTATE the board. These are the
 * tools we block for agent callers under the read-only policy. Names match the
 * MCP surface (`mcp__claude_ai_Atlassian__<op>`); we list the bare op so the
 * policy is reusable for the server-side REST classification too.
 *
 * Confluence write tools are included because the same Atlassian connection
 * exposes them and the user asked that agents "can't edit the board directly" —
 * we read-only the whole Atlassian write surface, not just Jira issues.
 */
export const JIRA_WRITE_OPERATIONS: readonly string[] = [
  // Jira board mutations
  "createJiraIssue",
  "editJiraIssue",
  "transitionJiraIssue",
  "addCommentToJiraIssue",
  "addWorklogToJiraIssue",
  "createIssueLink",
  // Confluence mutations (same Atlassian connection)
  "createConfluencePage",
  "updateConfluencePage",
  "createConfluenceFooterComment",
  "createConfluenceInlineComment",
];

/**
 * Fully-namespaced MCP tool names for the Atlassian write operations — exactly
 * what the Claude CLI expects in `--disallowedTools`.
 */
export const JIRA_WRITE_MCP_TOOLS: readonly string[] = JIRA_WRITE_OPERATIONS.map(
  (op) => `mcp__claude_ai_Atlassian__${op}`,
);

// Word fragments that indicate a MUTATION regardless of the provider prefix.
// Used as a fallback so a renamed/aliased Atlassian write tool is still caught
// (fail-closed: when the policy is on we would rather over-block a write than
// let a board mutation slip through).
const WRITE_VERB_FRAGMENTS = [
  "create",
  "edit",
  "update",
  "transition",
  "addcomment",
  "addworklog",
  "worklog",
  "delete",
  "move",
  "assign",
  "link", // createIssueLink / linkIssue style
  "archive",
  "rank",
] as const;

// Read verbs are an allow-signal. A name that STARTS with one of these is a read
// regardless of any write-verb substring later in the name (e.g.
// `getTransitionsForJiraIssue` starts with `get` and is a READ even though it
// contains the substring `transition`). Order longest-first is irrelevant here
// since we test `startsWith`.
const READ_VERB_PREFIXES = [
  "get",
  "search",
  "fetch",
  "list",
  "lookup",
] as const;

// Read verbs that may appear anywhere in the name (weaker signal than a prefix);
// used only when there is no write verb present.
const READ_VERB_FRAGMENTS = [
  "get",
  "search",
  "fetch",
  "list",
  "lookup",
  "visible",
  "accessible",
  "metadata",
  "meta",
  "info",
] as const;

/** Strip the MCP provider prefix so we classify on the bare operation name. */
function bareOpName(toolName: string): string {
  // mcp__claude_ai_Atlassian__getJiraIssue -> getJiraIssue
  const lastSep = toolName.lastIndexOf("__");
  return (lastSep >= 0 ? toolName.slice(lastSep + 2) : toolName).trim();
}

/** True when the tool name belongs to the Atlassian (Jira/Confluence) surface. */
export function isAtlassianTool(toolName: string): boolean {
  return /atlassian|jira|confluence/i.test(toolName);
}

/**
 * Classify an Atlassian/Jira MCP tool (or bare operation name) as a WRITE
 * (board-mutating) operation. Read operations — get / search / fetch / list /
 * lookup / metadata — return false.
 *
 * Conservative + fail-closed: an unknown Atlassian tool whose name contains a
 * write verb (and no read verb) is treated as a WRITE so the read-only policy
 * does not leak a mutation. A name that is purely a read verb is a READ.
 */
export function isJiraWriteOperation(toolName: string): boolean {
  if (typeof toolName !== "string" || toolName.trim().length === 0) return false;
  const bare = bareOpName(toolName).toLowerCase();

  // 1) Exact known-write match (namespaced or bare).
  for (const op of JIRA_WRITE_OPERATIONS) {
    if (bare === op.toLowerCase()) return true;
  }

  // 2) Verb heuristics.
  //    a) A name that STARTS with a read verb is a READ even if a write-verb
  //       substring appears later — e.g. `getTransitionsForJiraIssue` starts
  //       with `get` (lists transitions) and must not be confused with the
  //       `transitionJiraIssue` mutation.
  const startsWithReadVerb = READ_VERB_PREFIXES.some((v) => bare.startsWith(v));
  if (startsWithReadVerb) return false;

  //    b) Otherwise: a write verb anywhere signals a mutation; a read verb with
  //       no write verb is a READ.
  const hasReadVerb = READ_VERB_FRAGMENTS.some((v) => bare.includes(v));
  const hasWriteVerb = WRITE_VERB_FRAGMENTS.some((v) => bare.includes(v));

  if (hasWriteVerb) return true;
  if (hasReadVerb) return false;

  // 3) Default: unknown, no verb signal → treat as READ (do not over-block
  //    benign reads). The exact write list above covers the real mutations.
  return false;
}

/** READ classification is just the inverse of WRITE for Atlassian tools. */
export function isJiraReadOperation(toolName: string): boolean {
  return !isJiraWriteOperation(toolName);
}

/** Truthy-string parser matching the codebase's `=== "true"` env convention, default-aware. */
function parseBoolEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return defaultValue;
}

/** Whether the read-only Jira policy is active. Default ON (strict). */
export function isJiraReadOnlyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseBoolEnv(env[JIRA_AGENT_READONLY_ENV], true);
}

/** Resolve the JQL/search result cap for agents. Default {@link DEFAULT_JIRA_AGENT_MAX_SEARCH_RESULTS}. */
export function resolveJiraAgentMaxSearchResults(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env[JIRA_AGENT_MAX_SEARCH_RESULTS_ENV]);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_JIRA_AGENT_MAX_SEARCH_RESULTS;
}

/**
 * The list of namespaced Atlassian write MCP tools to pass to the Claude CLI as
 * `--disallowedTools` when the read-only policy is on. Empty when the policy is
 * off (operator opt-out), so behavior is unchanged in that case.
 */
export function jiraDisallowedMcpTools(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!isJiraReadOnlyEnabled(env)) return [];
  return [...JIRA_WRITE_MCP_TOOLS];
}
