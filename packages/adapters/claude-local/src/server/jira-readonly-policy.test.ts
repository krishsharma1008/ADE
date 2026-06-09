import { describe, expect, it } from "vitest";
import {
  DEFAULT_JIRA_AGENT_MAX_SEARCH_RESULTS,
  JIRA_AGENT_READONLY_ENV,
  JIRA_AGENT_MAX_SEARCH_RESULTS_ENV,
  JIRA_WRITE_MCP_TOOLS,
  isAtlassianTool,
  isJiraReadOnlyEnabled,
  isJiraReadOperation,
  isJiraWriteOperation,
  jiraDisallowedMcpTools,
  resolveJiraAgentMaxSearchResults,
} from "./jira-readonly-policy.js";

// The Atlassian MCP write tools the user wants blocked for agents — these MUST
// classify as WRITE (board mutations) so the policy blocks them.
const WRITE_TOOLS = [
  "mcp__claude_ai_Atlassian__createJiraIssue",
  "mcp__claude_ai_Atlassian__editJiraIssue",
  "mcp__claude_ai_Atlassian__transitionJiraIssue",
  "mcp__claude_ai_Atlassian__addCommentToJiraIssue",
  "mcp__claude_ai_Atlassian__addWorklogToJiraIssue",
  "mcp__claude_ai_Atlassian__createIssueLink",
  "mcp__claude_ai_Atlassian__createConfluencePage",
  "mcp__claude_ai_Atlassian__updateConfluencePage",
  "mcp__claude_ai_Atlassian__createConfluenceFooterComment",
  "mcp__claude_ai_Atlassian__createConfluenceInlineComment",
];

// The READ tools that agents must still be able to use.
const READ_TOOLS = [
  "mcp__claude_ai_Atlassian__getJiraIssue",
  "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql",
  "mcp__claude_ai_Atlassian__fetch",
  "mcp__claude_ai_Atlassian__search",
  "mcp__claude_ai_Atlassian__getVisibleJiraProjects",
  "mcp__claude_ai_Atlassian__getTransitionsForJiraIssue", // lists transitions — a READ
  "mcp__claude_ai_Atlassian__getJiraIssueRemoteIssueLinks",
  "mcp__claude_ai_Atlassian__lookupJiraAccountId",
  "mcp__claude_ai_Atlassian__getJiraProjectIssueTypesMetadata",
  "mcp__claude_ai_Atlassian__getIssueLinkTypes",
  "mcp__claude_ai_Atlassian__atlassianUserInfo",
  "mcp__claude_ai_Atlassian__getConfluencePage",
];

describe("jira read-only policy — operation classification", () => {
  it("classifies every Atlassian/Jira write tool as a WRITE", () => {
    for (const tool of WRITE_TOOLS) {
      expect(isJiraWriteOperation(tool), `${tool} should be WRITE`).toBe(true);
      expect(isJiraReadOperation(tool), `${tool} should NOT be READ`).toBe(false);
    }
  });

  it("classifies every Atlassian/Jira read tool as a READ", () => {
    for (const tool of READ_TOOLS) {
      expect(isJiraWriteOperation(tool), `${tool} should NOT be WRITE`).toBe(false);
      expect(isJiraReadOperation(tool), `${tool} should be READ`).toBe(true);
    }
  });

  it("does not confuse getTransitionsForJiraIssue (READ) with transitionJiraIssue (WRITE)", () => {
    expect(isJiraWriteOperation("getTransitionsForJiraIssue")).toBe(false);
    expect(isJiraWriteOperation("transitionJiraIssue")).toBe(true);
  });

  it("classifies bare op names (no MCP prefix) the same as namespaced names", () => {
    expect(isJiraWriteOperation("createJiraIssue")).toBe(true);
    expect(isJiraWriteOperation("getJiraIssue")).toBe(false);
  });

  it("fail-closed: an unknown Atlassian write-verb tool is treated as WRITE", () => {
    expect(isJiraWriteOperation("mcp__claude_ai_Atlassian__deleteJiraIssue")).toBe(true);
    expect(isJiraWriteOperation("mcp__claude_ai_Atlassian__assignJiraIssue")).toBe(true);
    expect(isJiraWriteOperation("mcp__claude_ai_Atlassian__moveJiraIssue")).toBe(true);
  });

  it("treats empty / non-string input as not-a-write (no crash)", () => {
    expect(isJiraWriteOperation("")).toBe(false);
    // @ts-expect-error — exercising the runtime guard against non-string input
    expect(isJiraWriteOperation(undefined)).toBe(false);
  });

  it("identifies Atlassian tools by name", () => {
    expect(isAtlassianTool("mcp__claude_ai_Atlassian__getJiraIssue")).toBe(true);
    expect(isAtlassianTool("mcp__claude_ai_Linear__get_issue")).toBe(false);
  });
});

describe("jira read-only policy — flag + disallowed tool list", () => {
  it("is ON by default (no env var set)", () => {
    expect(isJiraReadOnlyEnabled({})).toBe(true);
  });

  it("can be turned off via COMBYNE_JIRA_AGENT_READONLY=false", () => {
    expect(isJiraReadOnlyEnabled({ [JIRA_AGENT_READONLY_ENV]: "false" })).toBe(false);
    expect(isJiraReadOnlyEnabled({ [JIRA_AGENT_READONLY_ENV]: "0" })).toBe(false);
  });

  it("emits the namespaced write tools for --disallowedTools when ON", () => {
    const disallowed = jiraDisallowedMcpTools({});
    expect(disallowed).toEqual([...JIRA_WRITE_MCP_TOOLS]);
    expect(disallowed).toContain("mcp__claude_ai_Atlassian__createJiraIssue");
    expect(disallowed).toContain("mcp__claude_ai_Atlassian__transitionJiraIssue");
    // READ tools are never in the disallow list.
    expect(disallowed).not.toContain("mcp__claude_ai_Atlassian__getJiraIssue");
    expect(disallowed).not.toContain("mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql");
  });

  it("emits an empty disallow list when the policy is OFF (operator opt-out)", () => {
    expect(jiraDisallowedMcpTools({ [JIRA_AGENT_READONLY_ENV]: "false" })).toEqual([]);
  });
});

describe("jira read-only policy — search result cap", () => {
  it("defaults to the bounded result cap", () => {
    expect(resolveJiraAgentMaxSearchResults({})).toBe(DEFAULT_JIRA_AGENT_MAX_SEARCH_RESULTS);
  });

  it("honors a valid override", () => {
    expect(resolveJiraAgentMaxSearchResults({ [JIRA_AGENT_MAX_SEARCH_RESULTS_ENV]: "5" })).toBe(5);
  });

  it("falls back to the default for invalid / non-positive overrides", () => {
    expect(resolveJiraAgentMaxSearchResults({ [JIRA_AGENT_MAX_SEARCH_RESULTS_ENV]: "0" })).toBe(
      DEFAULT_JIRA_AGENT_MAX_SEARCH_RESULTS,
    );
    expect(resolveJiraAgentMaxSearchResults({ [JIRA_AGENT_MAX_SEARCH_RESULTS_ENV]: "abc" })).toBe(
      DEFAULT_JIRA_AGENT_MAX_SEARCH_RESULTS,
    );
  });
});
