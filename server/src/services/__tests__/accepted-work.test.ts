import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { acceptedWorkEvents, agents, companies, issues, memoryEntries } from "@combyne/db";
import { acceptedWorkService } from "../accepted-work.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("accepted work service", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let ceoId: string;
  let emId: string;
  let engineerId: string;
  let parentIssueId: string;
  let childIssueId: string;
  let childIssueIdentifier: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: `AcceptedWork-${suffix}`, issuePrefix: `AW${suffix}` })
      .returning();
    companyId = company.id;
    const [ceo] = await handle.db
      .insert(agents)
      .values({ companyId, name: "CEO", role: "ceo", adapterType: "process" })
      .returning();
    const [em] = await handle.db
      .insert(agents)
      .values({ companyId, name: "EM", role: "em", reportsTo: ceo.id, adapterType: "process" })
      .returning();
    const [engineer] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "Engineer",
        role: "engineer",
        reportsTo: em.id,
        adapterType: "process",
      })
      .returning();
    ceoId = ceo.id;
    emId = em.id;
    engineerId = engineer.id;
    const [parent] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Build accepted work memory",
        identifier: `AW${suffix}-1`,
        assigneeAgentId: em.id,
      })
      .returning();
    const [child] = await handle.db
      .insert(issues)
      .values({
        companyId,
        parentId: parent.id,
        title: "Implement PR detector",
        description: "Branch feat/accepted-work",
        identifier: `AW${suffix}-2`,
        assigneeAgentId: engineer.id,
      })
      .returning();
    parentIssueId = parent.id;
    childIssueId = child.id;
    expect(child.identifier).toBeTruthy();
    childIssueIdentifier = child.identifier!;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("upserts merged PR events idempotently and resolves the parent EM", async () => {
    const svc = acceptedWorkService(handle.db);
    const first = await svc.upsertMergedPull({
      companyId,
      issueId: childIssueId,
      repo: "combyne",
      pullNumber: 42,
      pullUrl: "https://github.com/combyne/combyne/pull/42",
      title: "feat: implement accepted work memory",
      body: "Implements the accepted work detector.",
      headBranch: "feat/accepted-work",
      mergedSha: "abc123",
      mergedAt: "2026-05-03T12:00:00.000Z",
      detectionSource: "simulation",
    });
    expect(first.created).toBe(true);
    expect(first.event.issueId).toBe(childIssueId);
    expect(first.event.contributorAgentId).toBe(engineerId);
    expect(first.event.managerAgentId).toBe(emId);
    expect(first.shouldWakeManager).toBe(true);

    const second = await svc.upsertMergedPull({
      companyId,
      issueId: childIssueId,
      repo: "combyne",
      pullNumber: 42,
      title: "feat: implement accepted work memory",
      detectionSource: "simulation",
    });
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);

    const rows = await handle.db
      .select()
      .from(acceptedWorkEvents)
      .where(eq(acceptedWorkEvents.pullNumber, 42));
    expect(rows).toHaveLength(1);
  });

  it("falls back to the CEO when no issue can be inferred", async () => {
    const svc = acceptedWorkService(handle.db);
    const inferred = await svc.upsertMergedPull({
      companyId,
      repo: "combyne",
      pullNumber: 43,
      title: "fix: finish issue AWZZZ-999 and unrelated work",
      body: "No matching issue here.",
      headBranch: "feat/no-match",
      detectionSource: "simulation",
    });
    expect(inferred.event.issueId).toBeNull();
    expect(inferred.event.managerAgentId).toBe(ceoId);
  });

  it("infers issue identifiers from lowercase branch names", async () => {
    const svc = acceptedWorkService(handle.db);
    const inferred = await svc.upsertMergedPull({
      companyId,
      repo: "combyne",
      pullNumber: 45,
      title: "fix: branch-only issue inference",
      body: "Identifier intentionally omitted from title and body.",
      headBranch: `feature/${childIssueIdentifier.toLowerCase()}-branch-inference`,
      detectionSource: "simulation",
    });
    expect(inferred.event.issueId).toBe(childIssueId);
    expect(inferred.event.contributorAgentId).toBe(engineerId);
    expect(inferred.event.managerAgentId).toBe(emId);
  });

  it("creates workspace memory from accepted work and resolves the event", async () => {
    const svc = acceptedWorkService(handle.db);
    const event = await svc.upsertMergedPull({
      companyId,
      issueId: parentIssueId,
      repo: "combyne",
      pullNumber: 44,
      title: "feat: add shared context",
      detectionSource: "simulation",
    });
    const result = await svc.createMemoryFromEvent({
      eventId: event.event.id,
      subject: "Accepted work memory convention",
      body: "Merged PRs create concise workspace memory entries tagged by repo.",
      kind: "convention",
      tags: ["context"],
      serviceScope: "combyne",
      createdBy: emId,
    });
    expect(result?.event.memoryStatus).toBe("memory_written");
    expect(result?.memory.layer).toBe("workspace");
    expect(result?.memory.source).toBe(`accepted_work:${event.event.id}`);

    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.id, result!.memory.id));
    expect(rows[0]?.tags).toContain("accepted-work");
  });
});
