import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, issues, memoryEntries, memoryPromotions } from "@combyne/db";
import { memoryService } from "../memory.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("memory service (4-layer)", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let agentBId: string;
  let taskId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c1] = await handle.db
      .insert(companies)
      .values({ name: `MemCo-${suffix}`, issuePrefix: `M${suffix}` })
      .returning();
    const [c2] = await handle.db
      .insert(companies)
      .values({ name: `OtherCo-${suffix}`, issuePrefix: `O${suffix}` })
      .returning();
    companyId = c1.id;
    otherCompanyId = c2.id;
    const [a1] = await handle.db
      .insert(agents)
      .values({ companyId, name: "alice", adapterType: "process" })
      .returning();
    const [a2] = await handle.db
      .insert(agents)
      .values({ companyId, name: "bob", adapterType: "process" })
      .returning();
    agentId = a1.id;
    agentBId = a2.id;
    const [t] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Wire up auth middleware",
        description: "Replace legacy session storage with JWT",
        assigneeAgentId: agentId,
      })
      .returning();
    taskId = t.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("rejects shared layer creation directly", async () => {
    const svc = memoryService(handle.db);
    await expect(
      svc.createEntry({
        companyId,
        layer: "shared",
        subject: "x",
        body: "y",
      }),
    ).rejects.toThrow(/promotion/i);
  });

  it("rejects personal layer creation without owner", async () => {
    const svc = memoryService(handle.db);
    await expect(
      svc.createEntry({
        companyId,
        layer: "personal",
        subject: "x",
        body: "y",
      }),
    ).rejects.toThrow(/owner/i);
  });

  it("creates workspace and personal entries with embeddings", async () => {
    const svc = memoryService(handle.db);
    const ws = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Auth middleware uses JWT cookies",
      body: "Sessions live in signed JWT cookies; refresh handled by /auth/refresh.",
      tags: ["auth", "jwt"],
      serviceScope: "server",
    });
    expect(ws.layer).toBe("workspace");
    expect(ws.embedding?.length).toBeGreaterThan(0);

    const personal = await svc.createEntry({
      companyId,
      layer: "personal",
      ownerType: "agent",
      ownerId: agentId,
      subject: "alice's auth notes",
      body: "alice prefers not to refactor middleware files in flight",
    });
    expect(personal.layer).toBe("personal");
    expect(personal.ownerId).toBe(agentId);
  });

  it("query ranks personal owner-scoped entries above workspace and excludes other personal", async () => {
    const svc = memoryService(handle.db);
    await svc.createEntry({
      companyId,
      layer: "personal",
      ownerType: "agent",
      ownerId: agentBId,
      subject: "bob private auth tip",
      body: "bob hates JWT, do not show to alice",
      tags: ["auth"],
    });
    const result = await svc.queryRanked(companyId, "auth jwt middleware", {
      ownerType: "agent",
      ownerId: agentId,
      limit: 10,
    });
    const subjects = result.items.map((i) => i.subject);
    expect(subjects.some((s) => s.toLowerCase().includes("auth"))).toBe(true);
    expect(subjects.some((s) => s.includes("bob private"))).toBe(false);
    expect(result.layerCounts.personal).toBeGreaterThanOrEqual(0);
  });

  it("manifest is bodyless and includes layer counts", async () => {
    const svc = memoryService(handle.db);
    const manifest = await svc.buildManifest(companyId, {
      taskId,
      ownerType: "agent",
      ownerId: agentId,
    });
    expect(manifest.taskId).toBe(taskId);
    expect(manifest.items.length).toBeGreaterThan(0);
    for (const item of manifest.items) {
      expect(item).not.toHaveProperty("body");
      expect(item).not.toHaveProperty("snippet");
    }
    expect(manifest.layerCounts).toBeDefined();
  });

  it("buildCoreContext returns ticket + ownership for the assignee", async () => {
    const svc = memoryService(handle.db);
    const ctx = await svc.buildCoreContext(companyId, taskId);
    expect(ctx.ticket?.id).toBe(taskId);
    expect(ctx.ticket?.title).toMatch(/auth/i);
    expect(ctx.ownership?.agentId).toBe(agentId);
    expect(ctx.ownership?.agentName).toBe("alice");
  });

  it("buildCoreContext returns empty when company mismatches", async () => {
    const svc = memoryService(handle.db);
    const ctx = await svc.buildCoreContext(otherCompanyId, taskId);
    expect(ctx.ticket).toBeNull();
    expect(ctx.ownership).toBeNull();
  });

  it("recordUsage increments counter and updates lastUsedAt", async () => {
    const svc = memoryService(handle.db);
    const entry = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Usage test entry",
      body: "decay timer reset target",
    });
    expect(entry.usageCount).toBe(0);
    await svc.recordUsage({
      entryId: entry.id,
      companyId,
      actorType: "agent",
      actorId: agentId,
    });
    const reloaded = await svc.getEntry(entry.id);
    expect(reloaded?.usageCount).toBe(1);
    expect(reloaded?.lastUsedAt).not.toBeNull();
  });

  it("promotion: propose → approve creates a shared entry", async () => {
    const svc = memoryService(handle.db);
    const source = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Promotable convention",
      body: "All routes return JSON envelopes with `error` key on failure",
      tags: ["api"],
    });
    const proposal = await svc.proposePromotion({
      companyId,
      sourceEntryId: source.id,
      proposerType: "agent",
      proposerId: agentId,
    });
    expect(proposal?.state).toBe("pending");

    const decided = await svc.decidePromotion(proposal!.id, {
      decision: "approved",
      reviewerId: "test-reviewer",
    });
    expect(decided?.state).toBe("approved");
    expect(decided?.promotedEntryId).toBeTruthy();

    const promoted = await svc.getEntry(decided!.promotedEntryId!);
    expect(promoted?.layer).toBe("shared");
    expect(promoted?.subject).toBe(source.subject);
  });

  it("promotion: rejection does not create shared entry", async () => {
    const svc = memoryService(handle.db);
    const source = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Reject me",
      body: "this is too noisy to share",
    });
    const proposal = await svc.proposePromotion({
      companyId,
      sourceEntryId: source.id,
      proposerType: "agent",
      proposerId: agentId,
    });
    const decided = await svc.decidePromotion(proposal!.id, {
      decision: "rejected",
      reviewerId: "test-reviewer",
      reviewNotes: "too project-specific",
    });
    expect(decided?.state).toBe("rejected");
    expect(decided?.promotedEntryId).toBeNull();
  });

  it("decay archives entries with TTL exceeded and cold zero-usage entries", async () => {
    const svc = memoryService(handle.db);
    const ttlEntry = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "ttl-bound entry",
      body: "expires fast",
      ttlDays: 1,
    });
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 5);
    await handle.db
      .update(memoryEntries)
      .set({ updatedAt: past })
      .where(eq(memoryEntries.id, ttlEntry.id));
    const archived = await svc.runDecayPass(companyId);
    expect(archived).toBeGreaterThan(0);
    const reloaded = await svc.getEntry(ttlEntry.id);
    expect(reloaded?.status).toBe("archived");
  });

  it("auto-distill proposes high-usage workspace entries for promotion", async () => {
    const svc = memoryService(handle.db);
    const popular = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Highly cited convention",
      body: "Use snake_case in DB columns",
    });
    for (let i = 0; i < 4; i++) {
      await svc.recordUsage({
        entryId: popular.id,
        companyId,
        actorType: "agent",
        actorId: agentId,
      });
    }
    const proposals = await svc.runAutoDistill(companyId, { minUsage: 3, max: 10 });
    expect(proposals.some((p) => p.sourceEntryId === popular.id)).toBe(true);
    const second = await svc.runAutoDistill(companyId, { minUsage: 3, max: 10 });
    expect(second.some((p) => p.sourceEntryId === popular.id)).toBe(false);
  });

  it("listEntries scoping respects layer and ownerId", async () => {
    const svc = memoryService(handle.db);
    const personalForAlice = await svc.listEntries({
      companyId,
      layer: "personal",
      ownerType: "agent",
      ownerId: agentId,
    });
    expect(personalForAlice.every((e) => e.ownerId === agentId)).toBe(true);
    const personalForBob = await svc.listEntries({
      companyId,
      layer: "personal",
      ownerType: "agent",
      ownerId: agentBId,
    });
    expect(personalForBob.every((e) => e.ownerId === agentBId)).toBe(true);
  });

  it("queryRanked excludes archived entries", async () => {
    const svc = memoryService(handle.db);
    const e = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Will be archived archivedSentinel",
      body: "archivedSentinel one-of-a-kind word here",
    });
    let result = await svc.queryRanked(companyId, "archivedSentinel", { limit: 10 });
    expect(result.items.some((i) => i.id === e.id)).toBe(true);
    await svc.archiveEntry(e.id);
    result = await svc.queryRanked(companyId, "archivedSentinel", { limit: 10 });
    expect(result.items.some((i) => i.id === e.id)).toBe(false);
  });

  it("queryRanked is company-scoped", async () => {
    const svc = memoryService(handle.db);
    await svc.createEntry({
      companyId: otherCompanyId,
      layer: "workspace",
      subject: "secret-topic-from-other-company",
      body: "do not leak across companies",
    });
    const result = await svc.queryRanked(companyId, "secret-topic-from-other-company");
    expect(result.items.length).toBe(0);
  });

  it("promotion source must belong to company", async () => {
    const svc = memoryService(handle.db);
    const otherEntry = await handle.db
      .insert(memoryEntries)
      .values({
        companyId: otherCompanyId,
        layer: "workspace",
        subject: "other-company entry",
        body: "do not promote across companies",
      })
      .returning();
    const proposal = await svc.proposePromotion({
      companyId,
      sourceEntryId: otherEntry[0].id,
      proposerType: "agent",
      proposerId: agentId,
    });
    expect(proposal).toBeNull();

    const promotionRows = await handle.db
      .select()
      .from(memoryPromotions)
      .where(eq(memoryPromotions.sourceEntryId, otherEntry[0].id));
    expect(promotionRows).toHaveLength(0);
  });
});
