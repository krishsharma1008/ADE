import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, heartbeatRuns, usagePauseWindows } from "@combyne/db";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

// Issue 4 Part 1 — verifies the migration applied (the table exists) and that
// the schema's columns / defaults / UNIQUE(runId) behave as designed. The test
// DB boots embedded Postgres and applies the file-based drizzle migrations via
// migratePostgresIfEmpty, so a green insert/select here proves 0047 landed.
describe("usage_pause_windows schema", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let runId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Usage Pause Test Co", issuePrefix: "UPW" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", adapterType: "claude_local" })
      .returning();
    agentId = agent.id;
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "paused_usage", invocationSource: "on_demand" })
      .returning();
    runId = run.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("inserts a row and applies column defaults", async () => {
    const resetsAt = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const [row] = await handle.db
      .insert(usagePauseWindows)
      .values({
        companyId,
        agentId,
        runId,
        sessionIdToResume: "sess_abc123",
        sessionCwd: "/tmp/workspace",
        resetsAt,
        pauseReason: "subscription_limit",
        nextRetryAt: resetsAt,
        lastErrorMessage: "Claude usage limit reached. Resets at 6pm.",
        lastResumeAttemptResult: { ok: false, code: "claude_usage_limit_reached" },
      })
      .returning();

    expect(row.id).toBeTruthy();
    expect(row.sessionIdToResume).toBe("sess_abc123");
    expect(row.pauseReason).toBe("subscription_limit");
    // Defaults from the schema.
    expect(row.attemptCount).toBe(0);
    expect(row.retryBackoffMs).toBe(30000);
    expect(row.maxRetries).toBe(10);
    expect(row.pausedAt).toBeInstanceOf(Date);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.lastResumeAttemptResult).toEqual({
      ok: false,
      code: "claude_usage_limit_reached",
    });

    const [selected] = await handle.db
      .select()
      .from(usagePauseWindows)
      .where(eq(usagePauseWindows.runId, runId));
    expect(selected.id).toBe(row.id);
    expect(selected.resetsAt?.getTime()).toBe(resetsAt.getTime());
  });

  it("enforces UNIQUE(runId) — a second window for the same run is rejected", async () => {
    await expect(
      handle.db.insert(usagePauseWindows).values({
        companyId,
        agentId,
        runId,
        sessionIdToResume: "sess_dup",
        pauseReason: "unknown_reset_time",
      }),
    ).rejects.toThrow();
  });

  it("supports the 'unknown_reset_time' pause reason with a null resetsAt", async () => {
    const [run2] = await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "paused_usage", invocationSource: "on_demand" })
      .returning();

    const [row] = await handle.db
      .insert(usagePauseWindows)
      .values({
        companyId,
        agentId,
        runId: run2.id,
        sessionIdToResume: "sess_noreset",
        pauseReason: "unknown_reset_time",
      })
      .returning();

    expect(row.resetsAt).toBeNull();
    expect(row.nextRetryAt).toBeNull();
    expect(row.pauseReason).toBe("unknown_reset_time");
  });
});
