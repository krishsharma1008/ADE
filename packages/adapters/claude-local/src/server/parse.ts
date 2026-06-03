import type { UsageSummary } from "@combyne/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@combyne/adapter-utils/server-utils";

const CLAUDE_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?claude\s+login`?|login\s+required|requires\s+login|unauthorized|authentication\s+required)/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const resultText = asString(input.parsed?.result, "").trim();
  const messages = [resultText, ...extractClaudeErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresLogin = messages.some((line) => CLAUDE_AUTH_REQUIRED_RE.test(line));
  return {
    requiresLogin,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const stopReason = asString(parsed.stop_reason, "").trim().toLowerCase();
  if (stopReason === "max_turns") return true;

  const resultText = asString(parsed.result, "").trim();
  return /max(?:imum)?\s+turns?/i.test(resultText);
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found/i.test(msg),
  );
}

// ── Usage / subscription-limit detection (Issue 4) ───────────────────────
//
// When Claude hits a usage / subscription-window limit (the 5-hour window, a
// rate limit, a 429, "usage exceeded", "too many requests"), the CLI surfaces
// it at the TOP LEVEL — the `result` text and/or the `errors[]` on the final
// result block, or on stderr / a non-JSON stdout error. We deliberately scope
// detection to that top-level result/error text (exactly like
// detectClaudeLoginRequired / isClaudeMaxTurnsResult) and NOT to arbitrary
// tool_result output, so a model that merely READS a doc mentioning "rate
// limit" doesn't trip the engine.
//
// On a hit the adapter PRESERVES the session and emits
// `claude_usage_limit_reached` so the usage-pause engine can resume the exact
// conversation once the window resets.

const CLAUDE_USAGE_LIMIT_RE =
  /limit|quota|rate.?limit|429|usage.*exceeded|subscription.*window|5.?hour|too many requests/i;

// Phrases that mention "limit"-family words but are NOT usage/quota limits, so
// we don't false-positive on e.g. a max-turns error (handled separately) or a
// character/size limit in tool output that leaked into the result text.
const CLAUDE_USAGE_LIMIT_NEGATIVE_RE =
  /max(?:imum)?\s+turns?|turn\s+limit|character\s+limit|size\s+limit|token\s+limit\s+for\s+(?:the\s+)?(?:prompt|context|message)|context\s+(?:window\s+)?limit|line\s+limit|time\s+limit\s+exceeded/i;

export interface ClaudeUsageLimitResult {
  isLimit: boolean;
  /** ISO-8601 reset time when the CLI reported one (or one was derivable), else null. */
  resetsAt: string | null;
  /** The matching message text, surfaced as the run errorMessage. Null when not a limit. */
  message: string | null;
}

/**
 * Try to pull an ISO reset timestamp out of a usage-limit message. Handles, in
 * order: an explicit ISO-8601 timestamp; a unix-epoch "resets at <seconds>";
 * a "retry-after: <n>s/<n> seconds" relative delay; a "try again in N
 * minutes/hours" relative delay. Returns null when nothing parseable is found.
 */
function extractResetsAt(text: string, now: number = Date.now()): string | null {
  if (!text) return null;

  // 1) Explicit ISO-8601 timestamp (e.g. "resets at 2025-06-02T18:00:00Z").
  const isoMatch = text.match(
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
  );
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0].replace(" ", "T"));
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }

  // 2) Unix epoch seconds, typically "resets at 1748883600" or
  //    "resetsInSeconds"/"reset": <epoch>. Only accept 10-digit values in a
  //    plausible range so we don't grab an unrelated long number.
  const epochMatch = text.match(/(?:resets?|reset[_-]?at)[^0-9]{0,12}(\d{10})\b/i);
  if (epochMatch) {
    const seconds = Number(epochMatch[1]);
    if (Number.isFinite(seconds) && seconds > 1_000_000_000 && seconds < 5_000_000_000) {
      return new Date(seconds * 1000).toISOString();
    }
  }

  // 3) retry-after header style: "retry-after: 3600" / "retry after 3600 seconds".
  const retryAfterMatch = text.match(/retry[\s-]?after[^0-9]{0,6}(\d+)\s*(s|sec|secs|seconds)?\b/i);
  if (retryAfterMatch) {
    const secs = Number(retryAfterMatch[1]);
    if (Number.isFinite(secs) && secs > 0) {
      return new Date(now + secs * 1000).toISOString();
    }
  }

  // 4) Relative delay: "try again in 2 hours" / "available in 45 minutes" /
  //    "wait 30 seconds". First numeric+unit wins.
  const relMatch = text.match(
    /(?:in|after|wait|within)\s+(\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr)s?\b/i,
  );
  if (relMatch) {
    const amount = Number(relMatch[1]);
    const unit = relMatch[2]!.toLowerCase();
    const unitMs = unit.startsWith("hour") || unit === "hr" ? 3_600_000
      : unit.startsWith("min") ? 60_000
      : 1_000;
    if (Number.isFinite(amount) && amount > 0) {
      return new Date(now + amount * unitMs).toISOString();
    }
  }

  return null;
}

/**
 * Detect a Claude usage / subscription-window limit from the top-level
 * result/error text. Scoped to: the final result block's `result` string, its
 * `errors[]`, plus stderr and a non-JSON stdout error body — NOT tool_result
 * output. Returns the first matching line as `message` and a best-effort
 * `resetsAt`. `isClaudeMaxTurnsResult` is checked first so a max-turns error
 * (which also contains the word "turns"/"limit") never misclassifies here.
 */
export function isClaudeUsageLimitReached(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): ClaudeUsageLimitResult {
  // A genuine max-turns result is a separate, non-usage condition.
  if (isClaudeMaxTurnsResult(input.parsed)) {
    return { isLimit: false, resetsAt: null, message: null };
  }

  const resultText = asString(input.parsed?.result, "").trim();
  const subtype = asString(input.parsed?.subtype, "").trim().toLowerCase();

  // The result block's `result`/`errors[]` text is only a limit signal when the
  // block itself is an ERROR — a successful run whose result text merely mentions
  // "rate limit" (e.g. summarizing rate-limit docs) must NOT trip the engine. A
  // result is an error when subtype != "success" OR is_error === true. stderr and
  // a bare (non-JSON) stdout body are always top-level CLI errors, so they're
  // scanned regardless of the parsed block.
  const resultIsError =
    input.parsed != null &&
    (input.parsed.is_error === true || (subtype.length > 0 && subtype !== "success"));
  const resultErrorLines = resultIsError
    ? [resultText, ...extractClaudeErrorMessages(input.parsed ?? {})]
    : [];
  const candidateLines = [
    ...resultErrorLines,
    input.stderr,
    // Only fall back to stdout when it ISN'T parseable stream-json (i.e. the CLI
    // printed a bare error). When stdout parsed into `result`, the result lines
    // above already cover it, and we must not scan tool_result bodies embedded in
    // the stream-json stdout.
    input.parsed ? "" : input.stdout,
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // A subtype the CLI itself tags as a usage/limit error is an unambiguous hit.
  const subtypeIsLimit = /usage[_-]?limit|rate[_-]?limit|limit[_-]?reached|quota/.test(subtype);

  let matchedLine: string | null = null;
  if (subtypeIsLimit) {
    matchedLine = resultText || candidateLines[0] || `Claude usage limit reached (${subtype})`;
  } else {
    for (const line of candidateLines) {
      if (CLAUDE_USAGE_LIMIT_NEGATIVE_RE.test(line)) continue;
      if (CLAUDE_USAGE_LIMIT_RE.test(line)) {
        matchedLine = line;
        break;
      }
    }
  }

  if (!matchedLine) {
    return { isLimit: false, resetsAt: null, message: null };
  }

  // Search all candidate text for a reset time, not just the matched line —
  // the timestamp is sometimes on a neighbouring error entry.
  const resetsAt = extractResetsAt(candidateLines.join("\n"));
  return { isLimit: true, resetsAt, message: matchedLine };
}

// ── MCP / integration auth-failure detection ─────────────────────────────
//
// Issue 3. When an MCP tool (Atlassian/Jira, Linear, Slack, Google Drive /
// Gmail / Calendar, Supabase, …) returns a 401/403/unauthenticated
// `tool_result`, Claude can STILL exit 0 and emit a perfectly-formed result
// block — so the run looks like a success and the issue auto-closes even
// though no real work happened. parseClaudeStreamJson only walks
// system/assistant/result events; it never reads `type:"user"` ->
// content[].type:"tool_result" blocks, which is where MCP tool errors live.
// So this is a SEPARATE re-scan of raw stdout that does NOT touch
// parseClaudeStreamJson's return shape.

/**
 * Per-provider matchers. `name` maps an MCP tool name (e.g.
 * `mcp__claude_ai_Atlassian__getJiraIssue`) to a stable provider slug; the
 * generic `content` patterns catch auth phrasing in the tool_result body for
 * any `mcp__*` tool we don't have a named matcher for.
 */
interface McpAuthProviderMatcher {
  provider: string;
  /** Matches the tool `name` field on the tool_use/tool_result. */
  name: RegExp;
}

const MCP_AUTH_PROVIDER_MATCHERS: McpAuthProviderMatcher[] = [
  { provider: "atlassian", name: /atlassian|jira|confluence/i },
  { provider: "linear", name: /linear/i },
  { provider: "slack", name: /slack/i },
  { provider: "google-drive", name: /google[_-]?drive|gdrive/i },
  { provider: "gmail", name: /gmail/i },
  { provider: "google-calendar", name: /google[_-]?calendar|gcal/i },
  { provider: "supabase", name: /supabase/i },
];

/**
 * Auth-failure phrasing in a tool_result body. Deliberately narrow: we only
 * flag genuine authentication/authorization failures, NOT generic tool errors
 * like "File not found" or "Issue does not exist". Each entry is tested
 * against the full (lower-cased) text of the tool_result content.
 */
const MCP_AUTH_FAILURE_PATTERNS: RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /\bunauthenticated\b/i,
  /\bunauthorized\b/i,
  /\bauthentication\s+required\b/i,
  /\bauthentication\s+failed\b/i,
  /\bplease\s+authenticate\b/i,
  /\bplease\s+(?:re-?)?(?:log\s*in|login)\b/i,
  /\bnot\s+authenticated\b/i,
  /\binvalid(?:\s+or\s+expired)?\s+(?:access\s+)?token\b/i,
  /\b(?:access\s+)?token\s+(?:has\s+)?expired\b/i,
  /\bpermission\s+denied\b/i,
  /\binvalid_grant\b/i,
  /\bre-?authenticate\b/i,
  /\boauth\b.*\b(?:error|failed|expired|invalid)\b/i,
];

const MCP_TOOL_NAME_RE = /^mcp__/i;

function isMcpAuthFailureText(text: string): boolean {
  if (!text) return false;
  return MCP_AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
}

function providerForToolName(toolName: string | null): string | null {
  if (!toolName) return null;
  for (const matcher of MCP_AUTH_PROVIDER_MATCHERS) {
    if (matcher.name.test(toolName)) return matcher.provider;
  }
  return null;
}

/**
 * Flatten a tool_result `content` value to a single searchable string.
 * Claude emits tool_result content either as a plain string or as an array of
 * `{ type:"text", text:"…" }` blocks (and occasionally nested objects).
 */
function flattenToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const block = entry as Record<string, unknown>;
          const text = asString(block.text, "");
          if (text) return text;
          try {
            return JSON.stringify(block);
          } catch {
            return "";
          }
        }
        return "";
      })
      .join("\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

export interface McpToolAuthErrorResult {
  requiresAuth: boolean;
  provider: string | null;
  toolName: string | null;
}

/**
 * Re-scan raw Claude stream-json stdout for an MCP `tool_result` block that
 * (a) carries `is_error === true` AND (b) matches an auth-failure pattern.
 * Returns the FIRST such block found, with its resolved provider slug and the
 * originating tool name. Tolerates malformed JSON lines (a partial/garbage
 * line is skipped, not thrown).
 *
 * Provider resolution order: (1) the tool name on the tool_result, if Claude
 * stamped one; (2) the named matcher against the tool_result body / id; (3)
 * the `tool_use_id`/content text. When nothing resolves we still report
 * `requiresAuth: true` with `provider: null` (the breaker treats a null
 * provider as a generic integration-auth failure).
 */
export function detectMcpToolAuthError(stdout: string): McpToolAuthErrorResult {
  if (!stdout) return { requiresAuth: false, provider: null, toolName: null };

  // Track the last seen tool name keyed by tool_use_id so we can resolve a
  // provider even when the tool_result itself doesn't echo the tool name.
  const toolNameByUseId = new Map<string, string>();

  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue; // tolerate malformed / partial JSON lines

    const message = parseObject(event.message);
    const content = Array.isArray(message.content) ? message.content : [];

    // First pass on assistant blocks: remember tool_use id -> name so we can
    // attribute a provider to the matching tool_result later on the same line
    // or a subsequent line.
    if (asString(event.type, "") === "assistant") {
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "tool_use") {
          const id = asString(block.id, "");
          const name = asString(block.name, "");
          if (id && name) toolNameByUseId.set(id, name);
        }
      }
    }

    // We only care about user blocks for tool_result detection.
    if (asString(event.type, "") !== "user") continue;

    for (const entry of content) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      if (asString(block.type, "") !== "tool_result") continue;
      // Only error results are candidates. is_error must be strictly true.
      if (block.is_error !== true) continue;

      const bodyText = flattenToolResultContent(block.content);
      if (!isMcpAuthFailureText(bodyText)) continue;

      const useId = asString(block.tool_use_id, "");
      const stampedName = asString(block.name, "");
      const resolvedName =
        stampedName || (useId ? (toolNameByUseId.get(useId) ?? "") : "") || "";

      // Restrict generic-pattern matches to MCP tools. A named provider match
      // (atlassian/linear/…) is enough on its own; otherwise the tool name
      // must look like an `mcp__*` tool so we don't misclassify built-in tool
      // errors (Bash, Read, …) that happen to mention "401" in their output.
      const namedProvider = providerForToolName(resolvedName) ?? providerForToolName(bodyText);
      const isMcpTool = MCP_TOOL_NAME_RE.test(resolvedName);
      if (!namedProvider && !isMcpTool) continue;

      return {
        requiresAuth: true,
        provider: namedProvider,
        toolName: resolvedName || null,
      };
    }
  }

  return { requiresAuth: false, provider: null, toolName: null };
}
