// Central taxonomy of every run-level `errorCode` the heartbeat / adapter
// layer can emit, plus a user-facing translation.
//
// Pilot feedback kept surfacing the same root-cause bug shape: the server
// set an errorCode (e.g. "adapter_failed"), persisted it in heartbeat_runs,
// and then every UI surface either ignored it or rendered it verbatim —
// leaving the user staring at "adapter_failed" with no idea what to do.
// This file is the single source of truth; UI surfaces (Inbox failed-run
// card, IssueDetail run banner, AgentDetail run row) all resolve against
// it. If the server adds a new code, add an entry here; the UI picks it up
// automatically.

export interface AgentErrorCodeEntry {
  /** The machine-readable code persisted on heartbeat_runs.errorCode. */
  code: string;
  /** One-line human-readable title. Renders as the banner headline. */
  title: string;
  /** Paragraph-length explanation. What went wrong, in plain English. */
  body: string;
  /**
   * Concrete remediation step(s) the user can take. Keep imperative:
   * "Install the Claude CLI", "Set the env var", "Re-run after fixing…".
   * Multi-line allowed.
   */
  remediation: string;
  /**
   * Severity hint for UI tone. `user_action` = the user must do something;
   * `retry` = transient / retry likely works; `investigate` = needs a
   * human looking at the full log.
   */
  severity: "user_action" | "retry" | "investigate";
  /** Optional deep-link for the remediation step (docs, settings, etc.). */
  docsUrl?: string;
}

const ENTRIES: AgentErrorCodeEntry[] = [
  // ── Adapter CLI / auth issues ─────────────────────────────────────
  {
    code: "adapter_cli_missing",
    title: "Adapter CLI not installed",
    body: "The run failed before it could start because the CLI this adapter drives (claude, codex, cursor-agent, etc.) isn't on the server's PATH.",
    remediation:
      "Install the CLI on the machine running Combyne, then re-run. The pre-flight error message in the run log names the exact command you need. You can verify with `combyne doctor`.",
    severity: "user_action",
    docsUrl: "https://docs.claude.com/claude-code",
  },
  {
    code: "adapter_jwt_missing",
    title: "Agent JWT secret not available",
    body: "The server couldn't mint a `COMBYNE_API_KEY` for this agent, so every authenticated endpoint the agent tried to hit returned 401.",
    remediation:
      "Check that `~/.combyne/instances/default/secrets/agent-jwt.key` exists and is readable, or that `COMBYNE_AGENT_JWT_SECRET` is set in the server env. If neither is set, restart the server — local_trusted mode regenerates the secret on first boot.",
    severity: "user_action",
  },
  {
    code: "adapter_failed",
    title: "Adapter failed to complete the run",
    body: "The underlying CLI exited non-zero or produced output the adapter couldn't parse. This is the catch-all when the adapter didn't classify the failure more specifically.",
    remediation:
      "Open the run log and search for the first `stderr` line. If it mentions authentication, run `combyne doctor` to probe the adapter. If it mentions rate limits or quota, wait and retry. Otherwise file the run id.",
    severity: "investigate",
  },

  // ── Agent lifecycle ───────────────────────────────────────────────
  {
    code: "agent_not_found",
    title: "Agent was deleted before this run could start",
    body: "The run was queued for an agent that has since been terminated or removed. Nothing to retry.",
    remediation:
      "If this was unexpected, check the activity log for who removed the agent. Re-assign the issue to a live agent to get it moving again.",
    severity: "user_action",
  },

  // ── Cancellation / timeout / lost ────────────────────────────────
  {
    code: "cancelled",
    title: "Run cancelled",
    body: "Someone (or an automation) cancelled the run while it was in flight.",
    remediation:
      "If this wasn't intentional, check the activity log for the cancellation actor. Re-run the agent to pick up where it left off — shared-context memory will carry prior state.",
    severity: "retry",
  },
  {
    code: "timeout",
    title: "Run hit its timeout",
    body: "The adapter was still working when `timeoutSec` elapsed, so Combyne killed the process and marked the run timed out.",
    remediation:
      "If the task is legitimately long, raise the adapter's `timeoutSec` in the agent's Configure page. If you expect sub-second completion, the run is likely stuck on a tool call — open the run log and look for the last tool_call event.",
    severity: "investigate",
  },
  {
    code: "process_lost",
    title: "Adapter process lost",
    body: "The child process Combyne spawned disappeared without emitting an exit code — usually an OS-level kill (OOM, SIGKILL) or the server restarted mid-run.",
    remediation:
      "Check `dmesg` / Console for an OOM kill. If the server restarted, click the Resume button on the run row — Claude sessions resume via `--resume`; other adapters restart from the last memory summary.",
    severity: "retry",
  },
  {
    code: "runner_script_missing",
    title: "Process adapter script not found",
    body: "The `process` adapter was configured with a `command` whose path doesn't exist on disk.",
    remediation:
      "Edit the agent's adapter config and point `command` at an existing script. You can test with `combyne doctor`.",
    severity: "user_action",
  },

  // ── OpenClaw Gateway (cloud adapter) ─────────────────────────────
  {
    code: "openclaw_gateway_url_missing",
    title: "OpenClaw gateway URL not set",
    body: "The openclaw_gateway adapter has no `url` in its config, so the run couldn't dispatch.",
    remediation:
      "Edit the agent's adapter config and set `url` to the gateway endpoint. Format: `https://<host>/path`.",
    severity: "user_action",
  },
  {
    code: "openclaw_gateway_url_invalid",
    title: "OpenClaw gateway URL invalid",
    body: "The configured `url` didn't parse as a valid URL.",
    remediation:
      "Open the agent's adapter config and correct the URL. It must include a scheme (http/https), a host, and be parseable by URL().",
    severity: "user_action",
  },
  {
    code: "openclaw_gateway_url_protocol",
    title: "OpenClaw gateway URL uses a disallowed protocol",
    body: "Only `http:` and `https:` are allowed for the gateway URL.",
    remediation:
      "Edit the adapter config to use http:// or https://. `file://`, `ssh://`, etc. are rejected at runtime for safety.",
    severity: "user_action",
  },
  {
    code: "openclaw_gateway_wait_timeout",
    title: "OpenClaw gateway didn't respond in time",
    body: "Combyne posted the request and waited but the gateway didn't reply within the configured `waitTimeoutMs`.",
    remediation:
      "Check the gateway's own health endpoint. If the gateway is usually fast, raise `waitTimeoutMs` on the agent's adapter config. If it's routinely slow, consider making the wake async.",
    severity: "retry",
  },
  {
    code: "openclaw_gateway_wait_error",
    title: "OpenClaw gateway returned an error while waiting",
    body: "The gateway accepted the request but surfaced an error during the long-poll.",
    remediation:
      "Open the gateway's logs for the correlation id shown in the run log. Fix upstream; Combyne will retry on the next wake.",
    severity: "investigate",
  },
  {
    code: "openclaw_gateway_wait_status_unexpected",
    title: "OpenClaw gateway returned an unexpected status",
    body: "The gateway completed but with a status Combyne doesn't recognise as success or known-failure.",
    remediation:
      "Check the gateway's API contract; the response status doesn't match the enumeration the adapter expects. If the gateway changed versions, upgrade the adapter.",
    severity: "investigate",
  },
  {
    code: "openclaw_gateway_agent_error",
    title: "OpenClaw gateway reported an agent-side error",
    body: "The agent behind the gateway (on the cloud side) failed to complete the request and reported back an error payload.",
    remediation:
      "Check the cloud agent's logs. The run log contains the payload returned by the gateway, which usually explains the root cause.",
    severity: "investigate",
  },
];

const ENTRY_BY_CODE = new Map<string, AgentErrorCodeEntry>(
  ENTRIES.map((entry) => [entry.code, entry]),
);

/** Fallback when a code isn't known — still surfaces the raw code verbatim. */
function unknownEntry(code: string): AgentErrorCodeEntry {
  return {
    code,
    title: `Run failed: \`${code}\``,
    body: "This error code hasn't been mapped to a user-facing explanation yet. The raw code is surfaced so an operator can still diagnose.",
    remediation:
      "Open the full run log for stderr and the last tool-call event. If this keeps happening, add an entry in `packages/shared/src/agent-error-codes.ts`.",
    severity: "investigate",
  };
}

/**
 * Resolve an `errorCode` to its user-facing entry. `null` / `undefined` /
 * empty-string input returns `null` so callers can render nothing instead
 * of a fake entry. Unknown codes fall through to `unknownEntry()`.
 */
export function resolveAgentErrorCode(
  code: string | null | undefined,
): AgentErrorCodeEntry | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  return ENTRY_BY_CODE.get(trimmed) ?? unknownEntry(trimmed);
}

/** Enumeration of every code the taxonomy ships. Used for tests + docs. */
export const KNOWN_AGENT_ERROR_CODES = ENTRIES.map((e) => e.code);
