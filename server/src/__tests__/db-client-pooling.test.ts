import { describe, it, expect } from "vitest";
import { resolvePgOptionsForTest } from "@combyne/db";

// RDB-1 / PASS-3: the shared context rail is a REMOTE Postgres (Cloud SQL over the
// public internet). createDb() must apply TLS + bounded pool/connect/statement
// timeouts for non-loopback hosts, while leaving the embedded LOCAL pool relaxed.
// These are otherwise only exercised against a live remote DB, so lock them here.
describe("pgOptions remote-aware pooling (RDB-1/PASS-3)", () => {
  it("leaves the LOOPBACK embedded pool relaxed (no TLS, no idle reaping)", () => {
    const opts = resolvePgOptionsForTest("postgresql://combyne:combyne@127.0.0.1:54329/combyne") as Record<
      string,
      unknown
    >;
    expect(opts.ssl).toBeUndefined();
    expect(opts.idle_timeout).toBeUndefined();
    expect(opts.connect_timeout).toBeUndefined();
  });

  it("tunes a REMOTE pool: TLS required, bounded pool + connect timeout", () => {
    const opts = resolvePgOptionsForTest("postgresql://u:p@203.0.113.10:5432/postgres") as Record<
      string,
      unknown
    >;
    expect(opts.ssl).toBe("require");
    expect(opts.max).toBeLessThanOrEqual(4);
    expect(typeof opts.idle_timeout).toBe("number");
    expect(opts.connect_timeout as number).toBeLessThanOrEqual(10);
  });

  it("HONORS an explicit sslmode in the URL (operator override not overwritten)", () => {
    const opts = resolvePgOptionsForTest(
      "postgresql://u:p@203.0.113.10:5432/postgres?sslmode=verify-full",
    ) as Record<string, unknown>;
    expect(opts.ssl).toBe("verify-full");
  });

  it("sslmode=disable on a remote host disables TLS (honored, not forced)", () => {
    const opts = resolvePgOptionsForTest(
      "postgresql://u:p@db.internal:5432/postgres?sslmode=disable",
    ) as Record<string, unknown>;
    expect(opts.ssl).toBe(false);
  });

  it("deep-merges connection so a context pool can add statement_timeout without losing remote SSL", () => {
    const opts = resolvePgOptionsForTest("postgresql://u:p@203.0.113.10:5432/postgres", {
      connection: { statement_timeout: 5000 },
    } as never) as Record<string, unknown>;
    expect(opts.ssl).toBe("require");
    expect((opts.connection as Record<string, unknown>).statement_timeout).toBe(5000);
  });
});
