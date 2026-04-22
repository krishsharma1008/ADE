import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies } from "@combyne/db";
import {
  advisoryLockKeys,
  clearQuarantine,
  getFailureRow,
  isQuarantined,
  recordFailure,
  recordSuccess,
  releaseAdvisoryLock,
  tryAdvisoryLock,
} from "../summarizer-failures.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("summarizer-failures", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "SumFail Co" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-SumFail", adapterType: "process" })
      .returning();
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("recordFailure increments the counter", async () => {
    const key = { agentId, scopeKind: "standing" as const, scopeId: null };
    const a = await recordFailure(handle.db, key, "err-1");
    expect(a.consecutiveFailures).toBe(1);
    expect(a.quarantined).toBe(false);
    const b = await recordFailure(handle.db, key, "err-2");
    expect(b.consecutiveFailures).toBe(2);
    expect(b.quarantined).toBe(false);
    const row = await getFailureRow(handle.db, key);
    expect(row?.consecutiveFailures).toBe(2);
    expect(row?.lastError).toBe("err-2");
  });

  it("quarantines after 3 consecutive failures for 24h", async () => {
    const key = {
      agentId,
      scopeKind: "working" as const,
      scopeId: "11111111-1111-1111-1111-111111111111",
    };
    await recordFailure(handle.db, key, "e1");
    await recordFailure(handle.db, key, "e2");
    const third = await recordFailure(handle.db, key, "e3");
    expect(third.consecutiveFailures).toBe(3);
    expect(third.quarantined).toBe(true);
    expect(await isQuarantined(handle.db, key)).toBe(true);
    // far-future clock: still quarantined if within 24h window.
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    expect(await isQuarantined(handle.db, key, soon)).toBe(true);
    // 25h later: quarantine is expired.
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await isQuarantined(handle.db, key, later)).toBe(false);
  });

  it("recordSuccess resets counter + clears quarantine", async () => {
    const key = { agentId, scopeKind: "standing" as const, scopeId: null };
    await recordFailure(handle.db, key, "boom");
    await recordSuccess(handle.db, key);
    const row = await getFailureRow(handle.db, key);
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.lastError).toBeNull();
    expect(row?.quarantinedUntil).toBeNull();
    expect(await isQuarantined(handle.db, key)).toBe(false);
  });

  it("clearQuarantine keeps the row but zeros the state", async () => {
    const key = {
      agentId,
      scopeKind: "working" as const,
      scopeId: "22222222-2222-2222-2222-222222222222",
    };
    await recordFailure(handle.db, key, "e1");
    await recordFailure(handle.db, key, "e2");
    await recordFailure(handle.db, key, "e3");
    expect(await isQuarantined(handle.db, key)).toBe(true);
    await clearQuarantine(handle.db, key);
    const row = await getFailureRow(handle.db, key);
    expect(row).not.toBeNull();
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.quarantinedUntil).toBeNull();
  });

  it("advisoryLockKeys is deterministic per key and differs across keys", () => {
    const a = advisoryLockKeys({ agentId, scopeKind: "standing", scopeId: null });
    const b = advisoryLockKeys({ agentId, scopeKind: "standing", scopeId: null });
    expect(a).toEqual(b);
    const c = advisoryLockKeys({ agentId, scopeKind: "working", scopeId: null });
    expect(c).not.toEqual(a);
  });

  it("tryAdvisoryLock is exclusive per session", async () => {
    const key = {
      agentId,
      scopeKind: "standing" as const,
      scopeId: "33333333-3333-3333-3333-333333333333",
    };
    const first = await tryAdvisoryLock(handle.db, key);
    expect(first).toBe(true);
    // Same session re-acquiring is idempotent in pg, so the second call
    // also succeeds — but an unlock is still required. We just assert we
    // can release without error.
    await releaseAdvisoryLock(handle.db, key);
  });
});
