import { describe, expect, it } from "vitest";
import {
  KNOWN_AGENT_ERROR_CODES,
  resolveAgentErrorCode,
} from "./agent-error-codes.js";

describe("resolveAgentErrorCode", () => {
  it("returns null for null / undefined / empty input", () => {
    expect(resolveAgentErrorCode(null)).toBeNull();
    expect(resolveAgentErrorCode(undefined)).toBeNull();
    expect(resolveAgentErrorCode("")).toBeNull();
    expect(resolveAgentErrorCode("   ")).toBeNull();
  });

  it("resolves every known code to a complete entry", () => {
    for (const code of KNOWN_AGENT_ERROR_CODES) {
      const entry = resolveAgentErrorCode(code);
      expect(entry, `code ${code} must resolve`).not.toBeNull();
      expect(entry!.code).toBe(code);
      expect(entry!.title.length).toBeGreaterThan(0);
      expect(entry!.body.length).toBeGreaterThan(0);
      expect(entry!.remediation.length).toBeGreaterThan(0);
      expect(["user_action", "retry", "investigate"]).toContain(entry!.severity);
    }
  });

  it("returns a fallback entry for unknown codes without crashing", () => {
    const entry = resolveAgentErrorCode("this_code_was_never_mapped");
    expect(entry).not.toBeNull();
    expect(entry!.code).toBe("this_code_was_never_mapped");
    expect(entry!.severity).toBe("investigate");
    expect(entry!.title).toMatch(/this_code_was_never_mapped/);
  });

  it("flags CLI-missing as user_action (drives UI tone)", () => {
    expect(resolveAgentErrorCode("adapter_cli_missing")?.severity).toBe("user_action");
    expect(resolveAgentErrorCode("adapter_jwt_missing")?.severity).toBe("user_action");
    expect(resolveAgentErrorCode("runner_script_missing")?.severity).toBe("user_action");
    expect(resolveAgentErrorCode("agent_not_found")?.severity).toBe("user_action");
  });

  it("flags cancellations and transient infra failures as retry", () => {
    expect(resolveAgentErrorCode("cancelled")?.severity).toBe("retry");
    expect(resolveAgentErrorCode("process_lost")?.severity).toBe("retry");
    expect(resolveAgentErrorCode("openclaw_gateway_wait_timeout")?.severity).toBe("retry");
  });

  it("flags generic / gateway-side errors as investigate", () => {
    expect(resolveAgentErrorCode("adapter_failed")?.severity).toBe("investigate");
    expect(resolveAgentErrorCode("timeout")?.severity).toBe("investigate");
    expect(resolveAgentErrorCode("openclaw_gateway_agent_error")?.severity).toBe(
      "investigate",
    );
  });

  it("trims whitespace before lookup", () => {
    const trimmed = resolveAgentErrorCode("  adapter_cli_missing  ");
    expect(trimmed?.code).toBe("adapter_cli_missing");
    expect(trimmed?.severity).toBe("user_action");
  });

  it("covers every errorCode currently emitted by the server heartbeat + adapters", () => {
    // This list mirrors the inventory from
    // `grep -rohE 'errorCode:\s*"[a-z_]+"' server/src packages/adapters`.
    // Adding a new errorCode server-side without adding a taxonomy entry
    // here is the exact bug shape this PR exists to prevent — this test
    // is the guardrail.
    const liveServerCodes = [
      "adapter_failed",
      "agent_not_found",
      "cancelled",
      "openclaw_gateway_agent_error",
      "openclaw_gateway_url_invalid",
      "openclaw_gateway_url_missing",
      "openclaw_gateway_url_protocol",
      "openclaw_gateway_wait_error",
      "openclaw_gateway_wait_status_unexpected",
      "openclaw_gateway_wait_timeout",
      "process_lost",
      "runner_script_missing",
      "timeout",
    ];
    for (const code of liveServerCodes) {
      expect(KNOWN_AGENT_ERROR_CODES, `missing taxonomy entry for ${code}`).toContain(code);
    }
  });
});
