// Cond 1 — the capture chokepoint. captureHumanMemoryDurable is the single path
// EVERY high-value capture funnels through: HOOK 1 human-answer, the manager-answer
// mirror, HOOK 2 PR-approval (which has NO request route to 403 it), and the
// attachment drainer. The pin fence here is what makes those universally enforced.
// An off-tenant capture under an active pin must NOT write AND must NOT enqueue to
// the outbox (so it can never get stuck replaying). The pinned id still writes.

import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, memoryEntries, contextCaptureOutbox } from "@combyne/db";
import { captureHumanMemoryDurable, isPinnedForContext } from "../memory-capture.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

const OFF_TENANT = "99999999-9999-4999-8999-999999999999";

function captureInput(companyId: string, source: string) {
  return {
    companyId,
    layer: "workspace" as const,
    kind: "fact" as const,
    subject: "PR approval capture",
    body: "Approved PR #42: ship the thing.",
    source,
    provenance: "pr-approval" as const,
    verificationState: "verified" as const,
    confidence: 0.9,
    authorType: "user" as const,
  };
}

describe("captureHumanMemoryDurable pin fence (Cond 1)", () => {
  let handle: TestDbHandle;
  let pinnedCompanyId: string;
  const savedUrl = process.env.COMBYNE_CONTEXT_DATABASE_URL;
  const savedPin = process.env.COMBYNE_CONTEXT_COMPANY_ID;

  beforeAll(async () => {
    handle = await startTestDb();
    const [c] = await handle.db
      .insert(companies)
      .values({ name: "Pinned Capture Co", issuePrefix: "PCC" })
      .returning();
    pinnedCompanyId = c.id;
  }, 60_000);

  afterEach(() => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = savedUrl ?? "";
    process.env.COMBYNE_CONTEXT_COMPANY_ID = savedPin ?? "";
  });

  afterAll(async () => {
    await stopTestDb();
  });

  it("isPinnedForContext: off-tenant under an active pin is false; pinned + global are true", () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = handle.connectionString;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;
    expect(isPinnedForContext(OFF_TENANT)).toBe(false);
    expect(isPinnedForContext(pinnedCompanyId)).toBe(true);
    expect(isPinnedForContext(null)).toBe(true);
  });

  it("SKIPS an off-tenant capture (no write, no outbox enqueue) under an active pin", async () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = handle.connectionString;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;

    const source = "pr-approval:off-tenant-test";
    const res = await captureHumanMemoryDurable(handle.db, captureInput(OFF_TENANT, source));
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);

    // Nothing written to memory_entries…
    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, OFF_TENANT), eq(memoryEntries.source, source)));
    expect(rows).toHaveLength(0);
    // …and nothing enqueued to the outbox (so it can never get stuck replaying).
    const queued = await handle.db
      .select()
      .from(contextCaptureOutbox)
      .where(eq(contextCaptureOutbox.source, source));
    expect(queued).toHaveLength(0);
  });

  it("WRITES the pinned-tenant capture (positive control)", async () => {
    process.env.COMBYNE_CONTEXT_DATABASE_URL = handle.connectionString;
    process.env.COMBYNE_CONTEXT_COMPANY_ID = pinnedCompanyId;

    const source = "pr-approval:on-tenant-test";
    const res = await captureHumanMemoryDurable(handle.db, captureInput(pinnedCompanyId, source));
    expect(res.ok).toBe(true);
    expect(res.entryId).toBeTruthy();
    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, pinnedCompanyId), eq(memoryEntries.source, source)));
    expect(rows).toHaveLength(1);
  });
});
