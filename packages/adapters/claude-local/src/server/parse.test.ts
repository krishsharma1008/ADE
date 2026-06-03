import { describe, expect, it } from "vitest";
import { detectMcpToolAuthError, isClaudeUsageLimitReached } from "./parse.js";

// Build the final stream-json `result` block the CLI emits, with optional
// errors[] entries. This is the shape parseClaudeStreamJson returns as `parsed`.
function resultBlock(opts: {
  subtype?: string;
  result?: string;
  errors?: unknown[];
  isError?: boolean;
}): Record<string, unknown> {
  return {
    type: "result",
    subtype: opts.subtype ?? "success",
    session_id: "sess_usage",
    result: opts.result ?? "",
    is_error: opts.isError ?? false,
    ...(opts.errors ? { errors: opts.errors } : {}),
  };
}

// Build a `type:"user"` stream-json line carrying a tool_result block, the
// exact shape Claude emits when an MCP tool returns an error. parseClaudeStreamJson
// never reads these blocks — detectMcpToolAuthError re-scans for them.
function toolResultLine(opts: {
  toolUseId?: string;
  isError: boolean;
  content: unknown;
}): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.toolUseId ?? "toolu_default",
          is_error: opts.isError,
          content: opts.content,
        },
      ],
    },
  });
}

// Build the preceding `type:"assistant"` tool_use line so the detector can
// attribute a provider via the tool name even when the tool_result body is
// generic (e.g. "401").
function toolUseLine(opts: { toolUseId: string; name: string }): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: opts.toolUseId,
          name: opts.name,
          input: {},
        },
      ],
    },
  });
}

const SYSTEM_INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess_1",
  model: "claude-opus-4",
});

const RESULT_OK = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "sess_1",
  result: "Done.",
  total_cost_usd: 0.01,
});

describe("detectMcpToolAuthError", () => {
  it("flags an Atlassian/Jira 401 tool_result at exit 0", () => {
    const stdout = [
      SYSTEM_INIT,
      toolUseLine({ toolUseId: "toolu_a", name: "mcp__claude_ai_Atlassian__getJiraIssue" }),
      toolResultLine({
        toolUseId: "toolu_a",
        isError: true,
        content: [{ type: "text", text: "Request failed with status 401: Unauthorized" }],
      }),
      RESULT_OK,
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("atlassian");
    expect(result.toolName).toBe("mcp__claude_ai_Atlassian__getJiraIssue");
  });

  it("flags a Linear unauthenticated tool_result", () => {
    const stdout = [
      toolUseLine({ toolUseId: "toolu_l", name: "mcp__claude_ai_Linear__list_issues" }),
      toolResultLine({
        toolUseId: "toolu_l",
        isError: true,
        content: "Authentication required. Please authenticate to continue.",
      }),
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("linear");
  });

  it("flags a Slack 403 tool_result", () => {
    const stdout = toolResultLineWithUse("mcp__claude_ai_Slack__authenticate", {
      isError: true,
      content: "403 Forbidden: not_authed",
    });

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("slack");
  });

  it("flags a Google Drive expired token tool_result", () => {
    const stdout = toolResultLineWithUse("mcp__claude_ai_Google_Drive__authenticate", {
      isError: true,
      content: "OAuth error: invalid or expired access token",
    });

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("google-drive");
  });

  it("flags a Gmail re-authenticate tool_result", () => {
    const stdout = toolResultLineWithUse("mcp__claude_ai_Gmail__authenticate", {
      isError: true,
      content: "Token expired. Please re-authenticate.",
    });

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("gmail");
  });

  it("flags a Google Calendar unauthorized tool_result", () => {
    const stdout = toolResultLineWithUse("mcp__claude_ai_Google_Calendar__authenticate", {
      isError: true,
      content: "401 unauthorized",
    });

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("google-calendar");
  });

  it("flags a Supabase unauthenticated tool_result", () => {
    const stdout = toolResultLineWithUse("mcp__plugin_supabase_supabase__authenticate", {
      isError: true,
      content: "unauthenticated: please authenticate",
    });

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("supabase");
  });

  it("flags a generic mcp__* tool 401 with null provider", () => {
    const stdout = toolResultLineWithUse("mcp__some_unknown_server__do_thing", {
      isError: true,
      content: "401 unauthorized",
    });

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBeNull();
    expect(result.toolName).toBe("mcp__some_unknown_server__do_thing");
  });

  it("ignores tool_result blocks where is_error===false", () => {
    const stdout = [
      toolUseLine({ toolUseId: "toolu_a", name: "mcp__claude_ai_Atlassian__getJiraIssue" }),
      toolResultLine({
        toolUseId: "toolu_a",
        isError: false,
        content: "Issue PROJ-1: 401 appears in the issue body text but this is a success",
      }),
      RESULT_OK,
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(false);
    expect(result.provider).toBeNull();
  });

  it("does NOT flag a 'File not found' error as an auth failure", () => {
    const stdout = [
      toolUseLine({ toolUseId: "toolu_a", name: "mcp__claude_ai_Atlassian__getJiraIssue" }),
      toolResultLine({
        toolUseId: "toolu_a",
        isError: true,
        content: "Error: File not found",
      }),
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(false);
  });

  it("does NOT flag a generic non-MCP tool error mentioning 401", () => {
    // A built-in tool (Bash) whose output mentions 401 should not trip the
    // breaker — only named providers or mcp__* tools qualify.
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: {} }],
        },
      }),
      toolResultLine({
        toolUseId: "toolu_bash",
        isError: true,
        content: "curl: server returned HTTP 401 for https://example.com",
      }),
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(false);
  });

  it("tolerates malformed / partial JSON lines", () => {
    const stdout = [
      "{ this is not valid json",
      SYSTEM_INIT,
      "",
      "   ",
      '{"type":"user","message":{"content":[{"type":"tool_result","is_error"', // truncated
      toolUseLine({ toolUseId: "toolu_a", name: "mcp__claude_ai_Atlassian__getJiraIssue" }),
      toolResultLine({
        toolUseId: "toolu_a",
        isError: true,
        content: "401 unauthorized",
      }),
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("atlassian");
  });

  it("returns a no-auth result for empty stdout", () => {
    expect(detectMcpToolAuthError("")).toEqual({
      requiresAuth: false,
      provider: null,
      toolName: null,
    });
  });

  it("matches a provider via tool name even when the body is a bare status code", () => {
    const stdout = [
      toolUseLine({ toolUseId: "toolu_l", name: "mcp__claude_ai_Linear__get_issue" }),
      toolResultLine({ toolUseId: "toolu_l", isError: true, content: "401" }),
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("linear");
  });

  // ── Edge cases (IMPROVE/CRITIC pass) ─────────────────────────────────────

  it("flags a 401 on an early turn even when a later turn exits cleanly (auth wins)", () => {
    // Auth fails on the first MCP call; the model then does unrelated work and
    // the run ends with a normal success result block. The auth failure must
    // still surface — exit-0 success must not paper over the 401.
    const stdout = [
      SYSTEM_INIT,
      toolUseLine({ toolUseId: "toolu_a", name: "mcp__claude_ai_Atlassian__getJiraIssue" }),
      toolResultLine({
        toolUseId: "toolu_a",
        isError: true,
        content: "Request failed with status 401: Unauthorized",
      }),
      // Later turn: a successful (non-MCP) tool call.
      toolUseLine({ toolUseId: "toolu_b", name: "Read" }),
      toolResultLine({ toolUseId: "toolu_b", isError: false, content: "file contents here" }),
      RESULT_OK,
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("atlassian");
  });

  it("captures the FIRST auth provider when multiple MCP tools fail auth", () => {
    // Linear fails first, then Slack fails. We attribute the run to the first
    // auth failure so the escalation/auth-link points at the earliest break.
    const stdout = [
      SYSTEM_INIT,
      toolUseLine({ toolUseId: "toolu_l", name: "mcp__claude_ai_Linear__list_issues" }),
      toolResultLine({ toolUseId: "toolu_l", isError: true, content: "401 unauthorized" }),
      toolUseLine({ toolUseId: "toolu_s", name: "mcp__claude_ai_Slack__list_channels" }),
      toolResultLine({ toolUseId: "toolu_s", isError: true, content: "403 not_authed" }),
      RESULT_OK,
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(true);
    expect(result.provider).toBe("linear");
  });

  it("does NOT flag when a tool fails auth then SUCCEEDS on retry within the same run", () => {
    // The auth 'failure' lives only in an is_error===false success block (the
    // body mentions "401" in passing). The detector requires is_error===true,
    // so a self-healed retry whose only auth-ish text is in the SUCCESS result
    // must not false-positive.
    const stdout = [
      SYSTEM_INIT,
      // First attempt: a transient generic (non-MCP) error, no auth pattern.
      toolUseLine({ toolUseId: "toolu_a", name: "mcp__claude_ai_Atlassian__getJiraIssue" }),
      toolResultLine({
        toolUseId: "toolu_a",
        isError: true,
        content: "Network timeout, retrying",
      }),
      // Retry SUCCEEDS — the success body happens to echo a 401 from a log line.
      toolUseLine({ toolUseId: "toolu_b", name: "mcp__claude_ai_Atlassian__getJiraIssue" }),
      toolResultLine({
        toolUseId: "toolu_b",
        isError: false,
        content: "Issue PROJ-7 fetched. (prior attempt logged a 401 unauthorized that was retried)",
      }),
      RESULT_OK,
    ].join("\n");

    const result = detectMcpToolAuthError(stdout);
    expect(result.requiresAuth).toBe(false);
    expect(result.provider).toBeNull();
  });
});

// Helper: a tool_use line immediately followed by its tool_result line.
function toolResultLineWithUse(
  name: string,
  opts: { isError: boolean; content: unknown },
): string {
  const id = `toolu_${Math.random().toString(36).slice(2, 8)}`;
  return [
    toolUseLine({ toolUseId: id, name }),
    toolResultLine({ toolUseId: id, isError: opts.isError, content: opts.content }),
  ].join("\n");
}

describe("isClaudeUsageLimitReached", () => {
  // ── Real-pattern positives ─────────────────────────────────────────────

  it("flags the Claude Code 5-hour subscription window message", () => {
    const parsed = resultBlock({
      subtype: "error",
      isError: true,
      result:
        "Claude usage limit reached. Your limit will reset at 6pm. You've reached your usage limit for the current 5-hour window.",
    });
    const res = isClaudeUsageLimitReached({ parsed, stdout: "", stderr: "" });
    expect(res.isLimit).toBe(true);
    expect(res.message).toContain("usage limit");
  });

  it("flags a 429 / rate limit error on stderr", () => {
    const res = isClaudeUsageLimitReached({
      parsed: null,
      stdout: "",
      stderr: "API Error: 429 Too Many Requests - rate limit exceeded",
    });
    expect(res.isLimit).toBe(true);
    expect(res.message).toMatch(/429|rate limit/i);
  });

  it("flags 'usage limit exceeded' phrasing in errors[]", () => {
    const parsed = resultBlock({
      subtype: "error",
      isError: true,
      errors: [{ message: "Your usage has exceeded the subscription limit for this window." }],
    });
    const res = isClaudeUsageLimitReached({ parsed, stdout: "", stderr: "" });
    expect(res.isLimit).toBe(true);
  });

  it("flags an Anthropic-style overloaded/limit message in the result text", () => {
    const parsed = resultBlock({
      subtype: "error_during_execution",
      isError: true,
      result: "Request failed: you have hit your rate limit. Please slow down.",
    });
    const res = isClaudeUsageLimitReached({ parsed, stdout: "", stderr: "" });
    expect(res.isLimit).toBe(true);
  });

  it("flags a subtype the CLI itself tags as a usage limit", () => {
    const parsed = resultBlock({
      subtype: "error_usage_limit",
      isError: true,
      result: "Stopped.",
    });
    const res = isClaudeUsageLimitReached({ parsed, stdout: "", stderr: "" });
    expect(res.isLimit).toBe(true);
  });

  it("flags a bare 'quota' message on a non-JSON stdout error", () => {
    const res = isClaudeUsageLimitReached({
      parsed: null,
      stdout: "Error: monthly quota exhausted for this organization",
      stderr: "",
    });
    expect(res.isLimit).toBe(true);
  });

  // ── resetsAt extraction ────────────────────────────────────────────────

  it("extracts an ISO resetsAt when the CLI reports one", () => {
    const parsed = resultBlock({
      subtype: "error",
      isError: true,
      result: "Usage limit reached. Your window resets at 2025-06-02T18:00:00Z.",
    });
    const res = isClaudeUsageLimitReached({ parsed, stdout: "", stderr: "" });
    expect(res.isLimit).toBe(true);
    expect(res.resetsAt).toBe("2025-06-02T18:00:00.000Z");
  });

  it("derives resetsAt from a retry-after seconds value", () => {
    const before = Date.now();
    const res = isClaudeUsageLimitReached({
      parsed: null,
      stdout: "",
      stderr: "429 Too Many Requests. retry-after: 3600",
    });
    expect(res.isLimit).toBe(true);
    expect(res.resetsAt).not.toBeNull();
    const resetMs = Date.parse(res.resetsAt!);
    // ~1h out, allowing a generous window for test timing.
    expect(resetMs).toBeGreaterThanOrEqual(before + 3_590_000);
    expect(resetMs).toBeLessThanOrEqual(before + 3_700_000);
  });

  it("derives resetsAt from a 'try again in N minutes' relative delay", () => {
    const before = Date.now();
    const res = isClaudeUsageLimitReached({
      parsed: null,
      stdout: "",
      stderr: "rate limit hit, please try again in 45 minutes",
    });
    expect(res.isLimit).toBe(true);
    const resetMs = Date.parse(res.resetsAt!);
    expect(resetMs).toBeGreaterThanOrEqual(before + 44 * 60_000);
    expect(resetMs).toBeLessThanOrEqual(before + 46 * 60_000);
  });

  it("derives resetsAt from a unix-epoch reset value", () => {
    const parsed = resultBlock({
      subtype: "error",
      isError: true,
      // 1748883600 = 2025-06-02T17:00:00Z
      result: "rate limit exceeded. resets at 1748883600.",
    });
    const res = isClaudeUsageLimitReached({ parsed, stdout: "", stderr: "" });
    expect(res.isLimit).toBe(true);
    expect(res.resetsAt).toBe("2025-06-02T17:00:00.000Z");
  });

  it("returns isLimit=true with null resetsAt when no reset is reported", () => {
    const res = isClaudeUsageLimitReached({
      parsed: null,
      stdout: "",
      stderr: "429 Too Many Requests",
    });
    expect(res.isLimit).toBe(true);
    expect(res.resetsAt).toBeNull();
  });

  // ── Negatives / non-regressions ────────────────────────────────────────

  it("does NOT flag a successful result", () => {
    const parsed = resultBlock({ subtype: "success", result: "Done. Implemented the feature." });
    const res = isClaudeUsageLimitReached({ parsed, stdout: "", stderr: "" });
    expect(res.isLimit).toBe(false);
    expect(res.message).toBeNull();
  });

  it("does NOT flag a max-turns error (handled as a separate condition)", () => {
    const parsed = resultBlock({
      subtype: "error_max_turns",
      isError: true,
      result: "Reached the maximum number of turns (limit) for this run.",
    });
    const res = isClaudeUsageLimitReached({ parsed, stdout: "", stderr: "" });
    expect(res.isLimit).toBe(false);
  });

  it("does NOT flag a context/token-size limit error", () => {
    const parsed = resultBlock({
      subtype: "error",
      isError: true,
      result: "Prompt is too long: it exceeds the token limit for the context window.",
    });
    const res = isClaudeUsageLimitReached({ parsed, stdout: "", stderr: "" });
    expect(res.isLimit).toBe(false);
  });

  it("does NOT flag a tool_result body mentioning 'rate limit' (scoped to top-level)", () => {
    // A model READING a doc that mentions rate limits, then succeeding, must not
    // trip the engine — detection is scoped to the top-level result/error text,
    // never tool_result output embedded in the stream-json stdout.
    const parsed = resultBlock({ subtype: "success", result: "Summarized the rate-limit docs." });
    const stdout = [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_x",
              is_error: false,
              content: "The API returns 429 Too Many Requests when the rate limit is exceeded.",
            },
          ],
        },
      }),
      JSON.stringify(parsed),
    ].join("\n");
    const res = isClaudeUsageLimitReached({ parsed, stdout, stderr: "" });
    expect(res.isLimit).toBe(false);
  });

  it("returns a no-limit result for empty input", () => {
    expect(isClaudeUsageLimitReached({ parsed: null, stdout: "", stderr: "" })).toEqual({
      isLimit: false,
      resetsAt: null,
      message: null,
    });
  });
});
