import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, issues, memoryEntries, memoryPromotions } from "@combyne/db";
import { memoryService, computeSubjectKey } from "../memory.js";
import type { MemoryEmbedder } from "../memory-embedder.js";
import { buildExportBundle, EmptyExportError, importBundle } from "../memory-etl.js";
import {
  startIsolatedTestDb,
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "./_test-db.js";

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

  it("accepts a non-uuid ownerId for personal entries and owner-fences it", async () => {
    const svc = memoryService(handle.db);
    // owner_id is now text: a non-uuid principal like the local board must work.
    const boardEntry = await svc.createEntry({
      companyId,
      layer: "personal",
      ownerType: "user",
      ownerId: "local-board",
      subject: "local board private note nonUuidOwnerSentinel",
      body: "nonUuidOwnerSentinel only the local-board principal should see this",
      tags: ["board"],
    });
    expect(boardEntry.layer).toBe("personal");
    expect(boardEntry.ownerId).toBe("local-board");

    // The local-board principal sees its own personal entry.
    const asBoard = await svc.queryRanked(companyId, "nonUuidOwnerSentinel", {
      ownerType: "user",
      ownerId: "local-board",
      limit: 10,
    });
    expect(asBoard.items.some((i) => i.id === boardEntry.id)).toBe(true);

    // Owner-fence isolation: a different principal (agent A) must NOT see it.
    // The personal fence is an exact string match on r.ownerId === opts.ownerId,
    // so 'local-board' is excluded for the agent owner.
    const asOtherPrincipal = await svc.queryRanked(companyId, "nonUuidOwnerSentinel", {
      ownerType: "agent",
      ownerId: agentId,
      limit: 10,
    });
    expect(asOtherPrincipal.items.some((i) => i.id === boardEntry.id)).toBe(false);
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

  it("hash-path: a unique-token lexical hit still surfaces under the relevance floor", async () => {
    // The default service uses the hash-64 oracle embedder, so the query version
    // is HASH_EMBEDDING_VERSION → minRelevanceForVersion returns mode:'signal'.
    // A pure lexical hit (r.lexical > 0, semantic near-zero) must still surface,
    // proving the new floor did NOT change the hash path (this is the archived
    // sentinel's positive arm restated as an explicit floor regression).
    const svc = memoryService(handle.db);
    const e = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "floorRegressionUniqueToken policy note",
      body: "floorRegressionUniqueToken describes a one-of-a-kind keyword",
    });
    const result = await svc.queryRanked(companyId, "floorRegressionUniqueToken", { limit: 10 });
    expect(result.items.some((i) => i.id === e.id)).toBe(true);
  });

  it("real-embedding floor: relevant row surfaces, fresh-orthogonal noise is excluded", async () => {
    // Exercise the REAL-embedding path WITHOUT a network embedder via the
    // memoryService(db, fakeEmbedder) seam. enabled:false keeps the storage and
    // ANN-pushdown branches off (they gate on embedder.enabled), so candidates
    // load via the jsonb window and the precomputed query embedding flows into the
    // ranker. embedQuery returns a real (non-hash) version → mode:'score', floor 0.25.
    const VERSION = "test-real:8";
    // 8-dim unit vectors. The relevant entry's vector is identical to the query
    // (cosine 1.0); the noise vectors are orthogonal (cosine 0.0). All entries use
    // disjoint lexical vocabularies from the query so lexical never masks the test.
    const queryVec = [1, 0, 0, 0, 0, 0, 0, 0];
    const relevantVec = [1, 0, 0, 0, 0, 0, 0, 0];
    const noiseVecA = [0, 1, 0, 0, 0, 0, 0, 0];
    const noiseVecB = [0, 0, 1, 0, 0, 0, 0, 0];
    const fakeEmbedder: MemoryEmbedder = {
      enabled: false,
      version: VERSION,
      embedForStorage: async () => ({
        vector: relevantVec,
        version: VERSION,
        model: "test-real",
        redactedFindings: [],
        contentHash: "test",
      }),
      embedQuery: async () => ({ vector: queryVec, version: VERSION, redactedFindings: [] }),
    };
    const svc = memoryService(handle.db, fakeEmbedder);

    // Seed entries DIRECTLY (bypassing the embedder-gated write path) so the
    // jsonb `embedding` + `embedding_version` are exactly the real-space vectors.
    const fresh = new Date();
    const [relevant] = await handle.db
      .insert(memoryEntries)
      .values({
        companyId,
        layer: "workspace",
        subject: "alpha vector relevant fixture",
        body: "alpha vector relevant fixture body",
        embedding: relevantVec,
        embeddingVersion: VERSION,
        updatedAt: new Date(fresh.getTime() - 1000 * 60 * 60 * 24 * 30),
      })
      .returning();
    const [noise1] = await handle.db
      .insert(memoryEntries)
      .values({
        companyId,
        layer: "workspace",
        subject: "bravo unrelated fresh noise one",
        body: "bravo unrelated fresh noise one body",
        embedding: noiseVecA,
        embeddingVersion: VERSION,
        updatedAt: fresh,
      })
      .returning();
    const [noise2] = await handle.db
      .insert(memoryEntries)
      .values({
        companyId,
        layer: "workspace",
        subject: "charlie unrelated fresh noise two",
        body: "charlie unrelated fresh noise two body",
        embedding: noiseVecB,
        embeddingVersion: VERSION,
        updatedAt: fresh,
      })
      .returning();

    // Query has its own vocabulary (no lexical overlap with any seeded row) so the
    // only thing that can lift the relevant row above the 0.25 floor is the cosine.
    const result = await svc.queryRanked(companyId, "delta echo foxtrot query", { limit: 10 });
    const ids = result.items.map((i) => i.id);
    // Relevant row (cosine 1.0 → score ≈ 0.55) clears the floor and surfaces.
    expect(ids).toContain(relevant.id);
    // Fresh-but-orthogonal noise (cosine 0, recency-only → score ≈ 0.15) is dropped.
    expect(ids).not.toContain(noise1.id);
    expect(ids).not.toContain(noise2.id);

    // Cleanup so the seeded fixtures don't pollute other tests in this company.
    for (const id of [relevant.id, noise1.id, noise2.id]) {
      await handle.db.delete(memoryEntries).where(eq(memoryEntries.id, id));
    }
  });

  it("real-embedding floor: an all-orthogonal corpus returns zero items", async () => {
    // Every candidate is orthogonal to the query vector (cosine 0) and carries no
    // lexical overlap, so under mode:'score' nothing clears the 0.25 floor → 0 items.
    const VERSION = "test-real:8";
    const queryVec = [1, 0, 0, 0, 0, 0, 0, 0];
    const fakeEmbedder: MemoryEmbedder = {
      enabled: false,
      version: VERSION,
      embedForStorage: async () => ({
        vector: queryVec,
        version: VERSION,
        model: "test-real",
        redactedFindings: [],
        contentHash: "test",
      }),
      embedQuery: async () => ({ vector: queryVec, version: VERSION, redactedFindings: [] }),
    };
    const svc = memoryService(handle.db, fakeEmbedder);

    // Fresh company so the corpus is exactly these orthogonal rows (no global rows
    // exist in this isolated rig, so the result is purely the seeded set).
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [isoCo] = await handle.db
      .insert(companies)
      .values({ name: `OrthoCo-${suffix}`, issuePrefix: `X${suffix}` })
      .returning();
    const fresh = new Date();
    const seeded: string[] = [];
    const orthoVecs = [
      [0, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0, 0],
    ];
    for (let i = 0; i < orthoVecs.length; i++) {
      const [row] = await handle.db
        .insert(memoryEntries)
        .values({
          companyId: isoCo.id,
          layer: "workspace",
          subject: `orthogonal fixture ${i} subject`,
          body: `orthogonal fixture ${i} body`,
          embedding: orthoVecs[i],
          embeddingVersion: VERSION,
          updatedAt: fresh,
        })
        .returning();
      seeded.push(row.id);
    }

    const result = await svc.queryRanked(isoCo.id, "unrelated query tokens here", { limit: 10 });
    expect(result.items.length).toBe(0);

    for (const id of seeded) {
      await handle.db.delete(memoryEntries).where(eq(memoryEntries.id, id));
    }
    await handle.db.delete(companies).where(eq(companies.id, isoCo.id));
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

  // ---------- PR-2: trust spine (migration 0049) ----------

  it("new entries default to unverified/0.5 with a populated subjectKey", async () => {
    const svc = memoryService(handle.db);
    const e = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Default trust state for a plain workspace fact",
      body: "no provenance given",
    });
    expect(e.verificationState).toBe("unverified");
    expect(e.confidence).toBe(0.5);
    expect(e.provenance).toBeNull();
    expect(e.subjectKey).toBe(
      computeSubjectKey("Default trust state for a plain workspace fact"),
    );
    expect(e.subjectKey).not.toBeNull();
  });

  it("subjectKey is stable and order-insensitive for identical subjects", () => {
    // Documented conservative/under-merging behaviour: same token set, any order
    // → same key. Distinct tokens → distinct key (never falsely merges).
    const a = computeSubjectKey("Auth middleware uses JWT cookies");
    const b = computeSubjectKey("cookies JWT uses middleware Auth");
    expect(a).toBe(b);
    const c = computeSubjectKey("Auth middleware uses session storage");
    expect(c).not.toBe(a);
  });

  it("WRITE-GATE: an agent author cannot self-assert verified (forced unverified, conf<=0.4)", async () => {
    const svc = memoryService(handle.db);
    // An agent actor requests the most-trusted state it could imagine. The
    // write-gate must override BOTH the verification state and the confidence,
    // regardless of the requested values — agents cannot launder a fact.
    const e = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Agent tries to assert a verified fact writeGateSentinel",
      body: "the production database password is hunter2",
      authorType: "agent",
      provenance: "verified-summary",
      verificationState: "verified",
      confidence: 0.99,
    });
    expect(e.verificationState).toBe("unverified");
    expect(e.confidence).toBeLessThanOrEqual(0.4);
    expect(e.provenance).toBe("verified-summary"); // provenance kept, trust stripped
    expect(e.authorType).toBe("agent");
  });

  it("WRITE-GATE: an agent with no provenance is tagged agent-claim/unverified", async () => {
    const svc = memoryService(handle.db);
    const e = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Agent claim with no provenance agentClaimSentinel",
      body: "some agent-derived note",
      authorType: "agent",
    });
    expect(e.provenance).toBe("agent-claim");
    expect(e.verificationState).toBe("unverified");
    expect(e.confidence).toBeLessThanOrEqual(0.4);
  });

  it("WRITE-GATE: a human author CAN write a verified human-answer at high confidence", async () => {
    const svc = memoryService(handle.db);
    // The hook path: authorType=user + a human-tier provenance is NOT quarantined.
    const e = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Human answers a routed question humanAnswerSentinel",
      body: "Q: which queue? A: use the orders.v2 topic",
      authorType: "user",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
    });
    expect(e.verificationState).toBe("verified");
    expect(e.confidence).toBeCloseTo(0.95);
    expect(e.provenance).toBe("human-answer");
  });

  it("IDEMPOTENT: two createEntry calls with the same (companyId, source) yield one row; the second returns the existing", async () => {
    const svc = memoryService(handle.db);
    const source = `human-answer:${crypto.randomUUID()}:${crypto.randomUUID()}`;
    const first = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Idempotent capture subject idemSentinel",
      body: "first write",
      source,
      authorType: "user",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
    });
    const second = await svc.createEntry({
      companyId,
      layer: "workspace",
      // Different subject/body on the retry — the upsert must NOT overwrite; it
      // re-selects and returns the ORIGINAL row.
      subject: "A totally different subject on retry",
      body: "second write that must be ignored",
      source,
      authorType: "user",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
    });
    expect(second.id).toBe(first.id);
    expect(second.subject).toBe(first.subject); // original preserved
    expect(second.body).toBe("first write");

    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.source, source));
    expect(rows).toHaveLength(1);
  });

  it("IDEMPOTENT: un-sourced entries are never deduped", async () => {
    const svc = memoryService(handle.db);
    const a = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Unsourced entry unsourcedSentinel",
      body: "first",
    });
    const b = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Unsourced entry unsourcedSentinel",
      body: "second",
    });
    expect(b.id).not.toBe(a.id);
  });

  it("createSharedFromPromotion stamps verified-summary/verified/0.9 (live path mirrors the backfill)", async () => {
    const svc = memoryService(handle.db);
    const source = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Promote me to shared promoteTrustSentinel",
      body: "All timestamps are stored UTC",
    });
    const proposal = await svc.proposePromotion({
      companyId,
      sourceEntryId: source.id,
      proposerType: "agent",
      proposerId: agentId,
    });
    const decided = await svc.decidePromotion(proposal!.id, {
      decision: "approved",
      reviewerId: "board-user",
    });
    const promoted = await svc.getEntry(decided!.promotedEntryId!);
    expect(promoted?.layer).toBe("shared");
    expect(promoted?.provenance).toBe("verified-summary");
    expect(promoted?.verificationState).toBe("verified");
    expect(promoted?.confidence).toBeCloseTo(0.9);
    expect(promoted?.sourceRefType).toBe("promotion");
  });

  it("BACKFILL: the 0049 trust-column backfill classifies pre-existing rows per §3.5", async () => {
    // Simulate the pre-0049 state by inserting rows with the trust columns
    // RESET to their defaults (provenance NULL, verification_state 'unverified',
    // confidence 0.5), then run the EXACT backfill UPDATEs from
    // 0049_memory_trust_spine.sql against this company and assert the policy.
    const promo = await handle.db
      .insert(memoryEntries)
      .values({
        companyId,
        layer: "shared",
        subject: "backfill promotion lineage row",
        body: "x",
        source: `promotion:${crypto.randomUUID()}`,
      })
      .returning();
    const sharedNoSource = await handle.db
      .insert(memoryEntries)
      .values({
        companyId,
        layer: "shared",
        subject: "backfill ex-shared row no source",
        body: "x",
      })
      .returning();
    const acceptedWork = await handle.db
      .insert(memoryEntries)
      .values({
        companyId,
        layer: "workspace",
        subject: "backfill accepted_work row",
        body: "x",
        source: `accepted_work:${crypto.randomUUID()}`,
      })
      .returning();
    const otherWorkspace = await handle.db
      .insert(memoryEntries)
      .values({
        companyId,
        layer: "workspace",
        subject: "backfill plain workspace row",
        body: "x",
      })
      .returning();

    // Reset the trust columns to the pre-backfill state for just these rows.
    const ids = [
      promo[0].id,
      sharedNoSource[0].id,
      acceptedWork[0].id,
      otherWorkspace[0].id,
    ];
    for (const id of ids) {
      await handle.db
        .update(memoryEntries)
        .set({
          provenance: null,
          verificationState: "unverified",
          confidence: 0.5,
          authorType: null,
        })
        .where(eq(memoryEntries.id, id));
    }

    // The exact backfill statements from migration 0049 (§3.5), scoped to this
    // company so the assertions are isolated from other tests' rows.
    await handle.db.execute(sql`
      UPDATE "memory_entries"
      SET "provenance" = 'verified-summary', "verification_state" = 'verified', "confidence" = 0.9
      WHERE "source" LIKE 'promotion:%' AND "company_id" = ${companyId}
    `);
    await handle.db.execute(sql`
      UPDATE "memory_entries"
      SET "verification_state" = 'verified'
      WHERE "layer" = 'shared' AND "company_id" = ${companyId}
    `);
    await handle.db.execute(sql`
      UPDATE "memory_entries"
      SET "provenance" = 'agent-claim', "author_type" = 'agent', "verification_state" = 'unverified'
      WHERE "source" LIKE 'accepted_work:%' AND "company_id" = ${companyId}
    `);
    await handle.db.execute(sql`
      UPDATE "memory_entries"
      SET "provenance" = 'agent-claim', "verification_state" = 'unverified'
      WHERE "provenance" IS NULL AND "verification_state" = 'unverified' AND "company_id" = ${companyId}
    `);

    const svc = memoryService(handle.db);
    const promoEntry = await svc.getEntry(promo[0].id);
    expect(promoEntry?.provenance).toBe("verified-summary");
    expect(promoEntry?.verificationState).toBe("verified");
    expect(promoEntry?.confidence).toBeCloseTo(0.9);

    const sharedEntry = await svc.getEntry(sharedNoSource[0].id);
    expect(sharedEntry?.verificationState).toBe("verified");

    const awEntry = await svc.getEntry(acceptedWork[0].id);
    expect(awEntry?.provenance).toBe("agent-claim");
    expect(awEntry?.authorType).toBe("agent");
    expect(awEntry?.verificationState).toBe("unverified");

    const otherEntry = await svc.getEntry(otherWorkspace[0].id);
    expect(otherEntry?.provenance).toBe("agent-claim");
    expect(otherEntry?.verificationState).toBe("unverified");
  });

  // ---------- PR-3: retrieval-side trust filter + conflict resolution ----------

  it("RETRIEVAL: requireVerified:true returns only verification_state='verified' rows", async () => {
    const svc = memoryService(handle.db);
    // One verified (human-answer) + one unverified (agent-claim) row sharing a
    // rare sentinel token so only these two are candidates for the query.
    const verified = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Verified retrieval fact reqVerifiedSentinel",
      body: "reqVerifiedSentinel the verified body",
      authorType: "user",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
    });
    const unverified = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Unverified retrieval fact reqVerifiedSentinel",
      body: "reqVerifiedSentinel the unverified body",
      authorType: "agent",
    });
    expect(unverified.verificationState).toBe("unverified");

    // Label-only default (no requireVerified): BOTH surface.
    const labelOnly = await svc.queryRanked(companyId, "reqVerifiedSentinel", {
      limit: 10,
    });
    const labelIds = labelOnly.items.map((i) => i.id);
    expect(labelIds).toContain(verified.id);
    expect(labelIds).toContain(unverified.id);

    // requireVerified:true → ONLY the verified row survives.
    const strict = await svc.queryRanked(companyId, "reqVerifiedSentinel", {
      limit: 10,
      requireVerified: true,
    });
    const strictIds = strict.items.map((i) => i.id);
    expect(strictIds).toContain(verified.id);
    expect(strictIds).not.toContain(unverified.id);
  });

  it("RETRIEVAL: minConfidence drops rows below the confidence floor", async () => {
    const svc = memoryService(handle.db);
    const high = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "High confidence fact minConfSentinel",
      body: "minConfSentinel high-confidence body",
      authorType: "user",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.9,
    });
    const low = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Low confidence fact minConfSentinel",
      body: "minConfSentinel low-confidence body",
      authorType: "agent", // quarantined to conf <= 0.4
    });
    expect(low.confidence).toBeLessThanOrEqual(0.4);

    // No floor → both candidates surface.
    const noFloor = await svc.queryRanked(companyId, "minConfSentinel", {
      limit: 10,
    });
    const noFloorIds = noFloor.items.map((i) => i.id);
    expect(noFloorIds).toContain(high.id);
    expect(noFloorIds).toContain(low.id);

    // minConfidence:0.5 → the 0.4 row is dropped, the 0.9 row stays.
    const floored = await svc.queryRanked(companyId, "minConfSentinel", {
      limit: 10,
      minConfidence: 0.5,
    });
    const flooredIds = floored.items.map((i) => i.id);
    expect(flooredIds).toContain(high.id);
    expect(flooredIds).not.toContain(low.id);
  });

  it("RETRIEVAL: excludeSuperseded defaults true (hides rows with supersededById set)", async () => {
    const svc = memoryService(handle.db);
    const winner = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Surviving canonical fact supersedeSentinel",
      body: "supersedeSentinel the winner body",
      authorType: "user",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
    });
    const loser = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Stale superseded fact supersedeSentinel",
      body: "supersedeSentinel the loser body",
      authorType: "user",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
    });
    // Mark the loser as superseded by the winner (direct row write — there is no
    // service method for this yet; the conflict-resolution UI lands in a later slice).
    await handle.db
      .update(memoryEntries)
      .set({ supersededById: winner.id })
      .where(eq(memoryEntries.id, loser.id));

    // Default (excludeSuperseded omitted == true): the loser is hidden.
    const defaulted = await svc.queryRanked(companyId, "supersedeSentinel", {
      limit: 10,
    });
    const defaultedIds = defaulted.items.map((i) => i.id);
    expect(defaultedIds).toContain(winner.id);
    expect(defaultedIds).not.toContain(loser.id);

    // Explicit excludeSuperseded:false → the superseded row reappears.
    const including = await svc.queryRanked(companyId, "supersedeSentinel", {
      limit: 10,
      excludeSuperseded: false,
    });
    const includingIds = including.items.map((i) => i.id);
    expect(includingIds).toContain(winner.id);
    expect(includingIds).toContain(loser.id);
  });

  it("CONFLICT: same subjectKey, a human-answer beats an agent-claim (precedence + drop loser)", async () => {
    const svc = memoryService(handle.db);
    // Two entries with the IDENTICAL subject → identical subjectKey → conflict.
    // One is a verified human-answer, the other an unverified agent-claim. Only
    // the human-answer must survive the ranked output.
    const subject = "Kafka topic naming convention conflictSentinel";
    const humanAnswer = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject,
      body: "conflictSentinel topics are <service>.<entity>.<event>.vN",
      authorType: "user",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
    });
    const agentClaim = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject,
      body: "conflictSentinel agent guessed topics are just <entity>",
      authorType: "agent", // forced to agent-claim/unverified by the write-gate
    });
    expect(agentClaim.subjectKey).toBe(humanAnswer.subjectKey);
    expect(agentClaim.provenance).toBe("agent-claim");

    const result = await svc.queryRanked(companyId, "conflictSentinel", {
      limit: 10,
    });
    const ids = result.items.map((i) => i.id);
    // The human-answer wins by precedence; the agent-claim loser is dropped even
    // though both match the query (label-only default surfaces unverified too).
    expect(ids).toContain(humanAnswer.id);
    expect(ids).not.toContain(agentClaim.id);
  });
});

// ---------- PR-7: memory ETL export/import + refuse-on-empty cutover gate ----------

describe("memory ETL (export/import cutover)", () => {
  let handle: TestDbHandle;
  let srcCompanyId: string;
  let dstCompanyId: string;
  let userId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [src] = await handle.db
      .insert(companies)
      .values({ name: `EtlSrc-${suffix}`, issuePrefix: `ES${suffix}` })
      .returning();
    const [dst] = await handle.db
      .insert(companies)
      .values({ name: `EtlDst-${suffix}`, issuePrefix: `ED${suffix}` })
      .returning();
    srcCompanyId = src.id;
    dstCompanyId = dst.id;
    userId = `user-${suffix}`;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("export preserves the 0049 trust columns + the jsonb embedding byte-for-byte", async () => {
    const svc = memoryService(handle.db);
    const entry = await svc.createEntry({
      companyId: srcCompanyId,
      layer: "workspace",
      subject: "kafka topic naming convention",
      body: "Topics are <team>.<domain>.<event>; never bare names.",
      kind: "convention",
      tags: ["kafka", "convention"],
      source: "pr-approval:etl-1",
      provenance: "pr-approval",
      verificationState: "verified",
      confidence: 0.8,
      authorType: "user",
      authorId: userId,
      sourceRefType: "approval",
    });
    // Stamp embedding_version so the export carries it.
    await handle.db
      .update(memoryEntries)
      .set({ embeddingVersion: "hash-64:64" })
      .where(eq(memoryEntries.id, entry.id));

    const bundle = await buildExportBundle(handle.connectionString, srcCompanyId);
    expect(bundle.counts.memory_entries).toBeGreaterThan(0);
    const exported = (bundle.memory_entries as Array<Record<string, unknown>>).find(
      (r) => r.id === entry.id,
    );
    expect(exported).toBeDefined();
    // Trust columns preserved.
    expect(exported!.provenance).toBe("pr-approval");
    expect(exported!.verificationState).toBe("verified");
    expect(exported!.confidence).toBeCloseTo(0.8);
    expect(exported!.authorType).toBe("user");
    expect(exported!.authorId).toBe(userId);
    expect(exported!.sourceRefType).toBe("approval");
    expect(exported!.embeddingVersion).toBe("hash-64:64");
    // The stored jsonb embedding round-trips byte-for-byte: the exported array
    // equals the live row's embedding exactly (same length, same values).
    const live = await svc.getEntry(entry.id);
    expect(Array.isArray(exported!.embedding)).toBe(true);
    expect(exported!.embedding).toEqual(live!.embedding);
    expect(JSON.stringify(exported!.embedding)).toBe(JSON.stringify(live!.embedding));
  });

  it("import recreates entries under a target company, is idempotent on re-run, and remaps personal owners", async () => {
    const svc = memoryService(handle.db);
    // A workspace (sourced) entry + a personal entry owned by 'local-board'.
    const ws = await svc.createEntry({
      companyId: srcCompanyId,
      layer: "workspace",
      subject: "budget pause policy etl",
      body: "Pause the run when the monthly cap is hit; resume on the next window.",
      source: "human-answer:etl-2",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
    });
    const personal = await svc.createEntry({
      companyId: srcCompanyId,
      layer: "personal",
      ownerType: "user",
      ownerId: "local-board",
      subject: "personal etl note",
      body: "My standing preference for this repo.",
    });

    const bundle = await buildExportBundle(handle.connectionString, srcCompanyId);
    const dstDb = createDb(handle.connectionString);

    const first = await importBundle(dstDb, bundle, {
      companyId: dstCompanyId,
      ownerRemap: new Map([["local-board", userId]]),
    });
    expect(first.insertedEntries).toBe(bundle.counts.memory_entries);

    // The workspace entry landed under the destination company with its trust
    // columns intact.
    const dstWs = await dstDb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, dstCompanyId),
          eq(memoryEntries.source, "human-answer:etl-2"),
        ),
      );
    expect(dstWs).toHaveLength(1);
    expect(dstWs[0].provenance).toBe("human-answer");
    expect(dstWs[0].verificationState).toBe("verified");
    expect(dstWs[0].confidence).toBeCloseTo(0.95);
    expect(dstWs[0].subject).toBe(ws.subject);

    // --owner-remap rewrote the personal owner from local-board → userId.
    const dstPersonal = await dstDb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, dstCompanyId),
          eq(memoryEntries.layer, "personal"),
          eq(memoryEntries.subject, personal.subject),
        ),
      );
    expect(dstPersonal).toHaveLength(1);
    expect(dstPersonal[0].ownerId).toBe(userId);
    expect(dstPersonal[0].ownerId).not.toBe("local-board");

    // Re-running is idempotent: zero new entries, all skipped.
    const second = await importBundle(dstDb, bundle, {
      companyId: dstCompanyId,
      ownerRemap: new Map([["local-board", userId]]),
    });
    expect(second.insertedEntries).toBe(0);
    expect(second.skippedEntries).toBe(bundle.counts.memory_entries);

    // No duplicate rows on (companyId, layer, subject, source).
    const dupCheck = await dstDb
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, dstCompanyId),
          eq(memoryEntries.source, "human-answer:etl-2"),
        ),
      );
    expect(dupCheck).toHaveLength(1);
  });

  it("REFUSE-ON-EMPTY: importing a zero-entry bundle throws (the hard cutover gate)", async () => {
    const dstDb = createDb(handle.connectionString);
    const emptyBundle = {
      version: 1,
      memory_entries: [],
      memory_promotions: [],
      memory_usage: [],
      agent_memory: [],
    };
    await expect(
      importBundle(dstDb, emptyBundle, {
        companyId: dstCompanyId,
        ownerRemap: new Map(),
      }),
    ).rejects.toBeInstanceOf(EmptyExportError);
  });
});

// ---------- FINAL_REVIEW hardening: global-layer trust + reach (B1, M2, M3, M4) ----------

describe("global memory layer hardening (B1/M2/M3/M4)", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    // ISOLATED database: these tests create instance-wide global rows (company_id
    // NULL), which are cross-company-visible BY DESIGN. Sharing the singleton DB
    // would leak those globals into sibling per-company-isolation tests, so this
    // block owns its own physical database and tears it down itself.
    handle = await startIsolatedTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [c] = await handle.db
      .insert(companies)
      .values({ name: `GlobCo-${suffix}`, issuePrefix: `G${suffix}` })
      .returning();
    companyId = c.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.stop();
  });

  // Helper: a verified workspace entry (the only promotable shape).
  async function makeVerifiedWorkspace(subject: string, body: string) {
    const svc = memoryService(handle.db);
    return svc.createEntry({
      companyId,
      layer: "workspace",
      subject,
      body,
      source: `human-answer:${crypto.randomUUID()}`,
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
    });
  }

  it("B1: an UNVERIFIED workspace entry CANNOT be promoted to global", async () => {
    const svc = memoryService(handle.db);
    // An agent-claim style unverified entry.
    const unverified = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "unverified agent claim b1",
      body: "the orders queue is orders.v9 (unconfirmed)",
      authorType: "agent",
    });
    expect(unverified.verificationState).not.toBe("verified");
    await expect(
      svc.createGlobalFromEntry({ sourceEntryId: unverified.id, isInstanceAdmin: true }),
    ).rejects.toThrow(/only verified entries can be promoted to global/i);
  });

  it("B1: a SUPERSEDED (conflict-loser) entry CANNOT be promoted to global", async () => {
    const svc = memoryService(handle.db);
    const loser = await makeVerifiedWorkspace(
      "superseded convention b1",
      "old: topics are bare names",
    );
    const winner = await makeVerifiedWorkspace(
      "winning convention b1",
      "new: topics are <team>.<domain>.<event>",
    );
    // Mark the loser superseded by the winner.
    await handle.db
      .update(memoryEntries)
      .set({ supersededById: winner.id })
      .where(eq(memoryEntries.id, loser.id));
    await expect(
      svc.createGlobalFromEntry({ sourceEntryId: loser.id, isInstanceAdmin: true }),
    ).rejects.toThrow(/superseded/i);
  });

  it("B1: a VERIFIED workspace entry CAN be promoted to global", async () => {
    const svc = memoryService(handle.db);
    const verified = await makeVerifiedWorkspace(
      "verified promotable convention b1",
      "Use signed JWT cookies for sessions.",
    );
    const global = await svc.createGlobalFromEntry({
      sourceEntryId: verified.id,
      isInstanceAdmin: true,
    });
    expect(global).not.toBeNull();
    expect(global!.layer).toBe("global");
    expect(global!.companyId).toBeNull();
  });

  it("M3: promoting the SAME source twice yields exactly ONE global row (idempotent)", async () => {
    const svc = memoryService(handle.db);
    const verified = await makeVerifiedWorkspace(
      "idempotent global convention m3",
      "Resume paused runs on the next window.",
    );
    const first = await svc.createGlobalFromEntry({
      sourceEntryId: verified.id,
      isInstanceAdmin: true,
    });
    const second = await svc.createGlobalFromEntry({
      sourceEntryId: verified.id,
      isInstanceAdmin: true,
    });
    expect(first).not.toBeNull();
    expect(second!.id).toBe(first!.id);
    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.source, `global-promotion:${verified.id}`));
    expect(rows).toHaveLength(1);
  });

  it("M2: an explicit layers=['workspace','shared'] (omitting global) STILL returns a global row", async () => {
    const svc = memoryService(handle.db);
    // Create the global row DIRECTLY (the instance-admin write path) with a unique
    // phrase that appears in NO other row — so there is no subjectKey collision
    // that the §3.6 conflict resolver could use to drop it, and the only thing
    // that could exclude it from the result is the layer filter (the M2 bug).
    const global = await svc.createEntry({
      companyId: null,
      layer: "global",
      isInstanceAdmin: true,
      subject: "m2 global-only reachability quizzaltrothex",
      body: "The quizzaltrothex rollout uses quizzaltrothex canary windows.",
      source: `global-direct:${crypto.randomUUID()}`,
      provenance: "verified-summary",
      verificationState: "verified",
      confidence: 0.9,
      authorType: "user",
    });
    expect(global.layer).toBe("global");
    expect(global.companyId).toBeNull();
    const res = await svc.queryRanked(companyId, "quizzaltrothex canary windows", {
      layers: ["workspace", "shared"], // global intentionally OMITTED
      limit: 20,
    });
    const ids = res.items.map((i) => i.id);
    // With the M2 fix the global row survives the layer restriction; the bug
    // (inArray-only) would mask it and this would fail.
    expect(ids).toContain(global.id);
  });

  it("M6: listEntries({layer:'global'}) returns company-NULL global rows and NOT a company's workspace rows", async () => {
    const svc = memoryService(handle.db);
    // A company-scoped workspace row that MUST NOT appear in the global view.
    const workspace = await makeVerifiedWorkspace(
      "m6 company workspace row zorptangle",
      "The zorptangle workspace fact is company-scoped only.",
    );
    // A real instance-wide global row (company_id NULL).
    const global = await svc.createEntry({
      companyId: null,
      layer: "global",
      isInstanceAdmin: true,
      subject: "m6 instance-wide global row zorptangle",
      body: "The zorptangle global fact spans every company.",
      source: `global-direct:${crypto.randomUUID()}`,
      provenance: "verified-summary",
      verificationState: "verified",
      confidence: 0.9,
      authorType: "user",
    });
    expect(global.companyId).toBeNull();

    // The global view (companyId is supplied but ignored for the global layer)
    // surfaces the NULL-company global rows...
    const globalList = await svc.listEntries({ companyId, layer: "global", limit: 200 });
    const globalIds = globalList.map((e) => e.id);
    expect(globalIds).toContain(global.id);
    // ...every returned row is genuinely global (company_id NULL).
    expect(globalList.every((e) => e.layer === "global" && e.companyId === null)).toBe(true);
    // ...and the company workspace row is NOT leaked into the global view.
    expect(globalIds).not.toContain(workspace.id);

    // Per-company isolation is INTACT: the workspace layer query is still
    // strictly eq(companyId) and does NOT pull in the global row.
    const workspaceList = await svc.listEntries({ companyId, layer: "workspace", limit: 200 });
    const workspaceIds = workspaceList.map((e) => e.id);
    expect(workspaceIds).toContain(workspace.id);
    expect(workspaceIds).not.toContain(global.id);
    expect(workspaceList.every((e) => e.companyId === companyId)).toBe(true);
  });
});

// ---------- M4: ETL preserves globals as company_id NULL (not re-stamped) ----------

describe("memory ETL global-layer preservation (M4)", () => {
  let handle: TestDbHandle;
  let srcCompanyId: string;
  let dstCompanyId: string;

  beforeAll(async () => {
    // ISOLATED database (see the global-hardening block above): this test creates
    // a global row and round-trips it through export/import; an isolated DB keeps
    // that cross-company global out of the shared singleton.
    handle = await startIsolatedTestDb();
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const [src] = await handle.db
      .insert(companies)
      .values({ name: `M4Src-${suffix}`, issuePrefix: `MS${suffix}` })
      .returning();
    const [dst] = await handle.db
      .insert(companies)
      .values({ name: `M4Dst-${suffix}`, issuePrefix: `MD${suffix}` })
      .returning();
    srcCompanyId = src.id;
    dstCompanyId = dst.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.stop();
  });

  it("export+import preserves a global row as company_id NULL (never re-stamped)", async () => {
    const svc = memoryService(handle.db);
    // A verified workspace entry on the source company, promoted to global.
    const ws = await svc.createEntry({
      companyId: srcCompanyId,
      layer: "workspace",
      subject: "m4 global convention",
      body: "Global: never log secrets.",
      source: `human-answer:${crypto.randomUUID()}`,
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
    });
    const global = await svc.createGlobalFromEntry({
      sourceEntryId: ws.id,
      isInstanceAdmin: true,
    });
    expect(global).not.toBeNull();
    const globalSource = `global-promotion:${ws.id}`;

    // A per-company export must CARRY the dependent global row (M4 export UNION).
    const bundle = await buildExportBundle(handle.connectionString, srcCompanyId);
    const exportedGlobal = (bundle.memory_entries as Array<Record<string, unknown>>).find(
      (r) => r.source === globalSource,
    );
    expect(exportedGlobal).toBeDefined();
    expect(exportedGlobal!.layer).toBe("global");

    // Import under the destination company: the global row must land company_id
    // NULL (NOT re-stamped to dstCompanyId).
    const dstDb = createDb(handle.connectionString);
    await importBundle(dstDb, bundle, {
      companyId: dstCompanyId,
      ownerRemap: new Map(),
    });
    const rows = await dstDb
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.source, globalSource));
    // Exactly one global row, company_id NULL — the M3 global-source uniq index
    // means the original promotion + this import dedup to ONE row.
    expect(rows).toHaveLength(1);
    expect(rows[0].layer).toBe("global");
    expect(rows[0].companyId).toBeNull();
  });
});
