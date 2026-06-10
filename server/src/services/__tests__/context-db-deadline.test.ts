// Fix #25 (e2e-run-2026-06-10 round 2): when the central context rail's network
// blackholed (TCP to the rail silently dropped), warm pooled sockets hung
// queries FOREVER client-side — the server-side statement_timeout never arrives
// over a dead link. Live impact: agent runs hung BEFORE adapter spawn (no run
// log at all) on memory recall, and the 5-minute reaper killed them in a loop.
// Every rail call now races a client-side wall-clock deadline that evicts the
// pool and flips the health surface, so runs fail fast and get re-delivered.

import { describe, expect, it } from "vitest";
import {
  ContextDbDeadlineError,
  getContextDbHealth,
  recordContextDbHealth,
  withContextDeadline,
} from "../context-db.js";

describe("fix #25: client-side context-DB deadline", () => {
  it("rejects a hung rail call with ContextDbDeadlineError and flips the health surface", async () => {
    recordContextDbHealth({ status: "ok" });
    const hungForever = () => new Promise<never>(() => {});

    await expect(withContextDeadline(hungForever, 50)).rejects.toBeInstanceOf(
      ContextDbDeadlineError,
    );
    expect(getContextDbHealth().status).toBe("unreachable");
    expect(getContextDbHealth().lastError).toContain("deadline");
  });

  it("passes through a fast call untouched", async () => {
    const result = await withContextDeadline(async () => "fast-value", 1_000);
    expect(result).toBe("fast-value");
  });

  it("propagates the inner error (not a deadline) when the call fails fast", async () => {
    await expect(
      withContextDeadline(async () => {
        throw new Error("query failed");
      }, 1_000),
    ).rejects.toThrow("query failed");
  });

  it("the deadline error names the configured budget so operators can tune it", () => {
    const err = new ContextDbDeadlineError(20_000);
    expect(err.message).toContain("20000ms");
    expect(err.name).toBe("ContextDbDeadlineError");
  });
});
