// Comprehensive END-TO-END edge-case integration suite for the central context DB.
//
// Exercises the REAL service layer (memoryService / passdownService / the pure
// sufficiency + ranker functions) against a real embedded Postgres — no mocks
// of the service under test. Covers, in BOTH single-DB and 2-DB modes:
//
//   A) No context bleed (company + personal-owner isolation, physical 2-DB split)
//   B) No embedding issues (version-guard, no-key path, redact-before-embed, mixed corpus)
//   C) Right quality & amount per task (passdown tiering + sufficiency verdicts)
//   D) Answers & approved context routed correctly (HOOK 1 / HOOK 2 shapes, write-gate,
//      conflict precedence, and the close-the-loop human-answer → passdown path)
//
// The hash-64 embedder is the deterministic test oracle (no network). Where a
// "real-version" embedder is needed (B1/B4) we inject a stub driver so a non-hash
// embedding_version is stamped WITHOUT any provider call.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companies,
  createDb,
  issues,
  issueComments,
  approvals,
  agents,
  memoryEntries,
  type Db,
} from "@combyne/db";
import { memoryService } from "../memory.js";
import { passdownService, PASSDOWN_TIERS } from "../em-passdown.js";
import {
  evaluateSufficiency,
  extractRequirementTokens,
  LEGACY_HASH_EMBEDDING_VERSION,
} from "../memory-sufficiency.js";
import {
  makeMemoryEmbedder,
  HASH_EMBEDDING_VERSION,
  type MakeEmbedderDeps,
} from "../memory-embedder.js";
import { resolveContextDb } from "../context-db.js";
import {
  startTestDb,
  startIsolatedTestDb,
  stopTestDb,
  type TestDbHandle,
} from "./_test-db.js";

const CTX_ENV_KEY = "COMBYNE_CONTEXT_DATABASE_URL";

/** Create an isolated company on the MAIN db and return its id. */
async function makeCompany(db: Db, name: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const [c] = await db
    .insert(companies)
    .values({ name: `${name}-${suffix}`, issuePrefix: `P${suffix}` })
    .returning();
  return c.id;
}

/**
 * A real-version embedder backed by a stub driver: NO network. It stamps a
 * non-hash embedding_version ('openai:test:4') and produces a deterministic
 * 4-dim vector seeded from the input text. Used to prove the version-guard
 * (B1) and the mixed-version corpus (B4) without any provider call.
 */
const REAL_TEST_VERSION = "openai:test:4";
// The driver type is taken structurally from MakeEmbedderDeps so this test never
// imports embedding-driver.ts directly (the redact-before-embed lint boundary).
type StubDriver = NonNullable<MakeEmbedderDeps["driver"]>;
function makeRealVersionEmbedder(egressed?: string[]) {
  const driver: StubDriver = {
    version: REAL_TEST_VERSION,
    async embed(texts: string[]) {
      // Record exactly what would be sent to the provider so a test can assert the
      // redact-before-embed boundary scrubbed the secret BEFORE this point.
      if (egressed) egressed.push(...texts);
      const vectors = texts.map((t) => {
        // Deterministic tiny vector — distinct space from the 64-dim hash oracle.
        let a = 0;
        let b = 0;
        for (let i = 0; i < t.length; i++) {
          if (i % 2 === 0) a += t.charCodeAt(i);
          else b += t.charCodeAt(i);
        }
        const norm = Math.sqrt(a * a + b * b) || 1;
        return [a / norm, b / norm, 0, 0];
      });
      return {
        vectors,
        model: "test-embed",
        dim: 4,
        version: REAL_TEST_VERSION,
        inputTokens: 0,
      };
    },
  };
  return makeMemoryEmbedder({
    config: {
      vectorSearchEnabled: true,
      embeddingApiKey: "test-key",
      embeddingProvider: "openai",
      embeddingModel: "test",
      embeddingDim: 4,
    },
    driver,
  });
}

describe("central-db integration — A) no context bleed (single-DB)", () => {
  let handle: TestDbHandle;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    handle = await startTestDb();
    companyA = await makeCompany(handle.db, "BleedCoA");
    companyB = await makeCompany(handle.db, "BleedCoB");
  }, 120_000);

  afterAll(async () => {
    await stopTestDb();
  });

  it("A1: company-scoped — queryRanked as A never returns B's workspace entries", async () => {
    const svc = memoryService(handle.db);
    const aEntry = await svc.createEntry({
      companyId: companyA,
      layer: "workspace",
      subject: "Widget pricing rounding rule for invoices",
      body: "Round widget invoice totals to two decimals before tax.",
      tags: ["pricing", "invoice"],
      serviceScope: "billing",
    });
    const bEntry = await svc.createEntry({
      companyId: companyB,
      layer: "workspace",
      subject: "Widget pricing rounding rule for invoices",
      body: "Round widget invoice totals up to the nearest dollar.",
      tags: ["pricing", "invoice"],
      serviceScope: "billing",
    });

    const asA = await svc.queryRanked(companyA, "widget pricing rounding invoice rule", {
      limit: 25,
    });
    const aIds = asA.items.map((i) => i.id);
    expect(aIds).toContain(aEntry.id);
    expect(aIds).not.toContain(bEntry.id);

    const asB = await svc.queryRanked(companyB, "widget pricing rounding invoice rule", {
      limit: 25,
    });
    const bIds = asB.items.map((i) => i.id);
    expect(bIds).toContain(bEntry.id);
    expect(bIds).not.toContain(aEntry.id);
  });

  it("A2: personal owner-fence — P1's personal entry is returned to P1 but not P2", async () => {
    const svc = memoryService(handle.db);
    const p1Entry = await svc.createEntry({
      companyId: companyA,
      layer: "personal",
      ownerType: "user",
      ownerId: "principal-P1",
      subject: "P1 prefers tabs over spaces in config files",
      body: "Personal preference: indent config with tabs.",
      tags: ["preference"],
    });

    // P1 (the owner) sees their own personal entry.
    const asP1 = await svc.queryRanked(companyA, "tabs spaces config indent preference", {
      limit: 25,
      ownerType: "user",
      ownerId: "principal-P1",
    });
    expect(asP1.items.map((i) => i.id)).toContain(p1Entry.id);

    // A DIFFERENT principal P2 in the same company never sees P1's personal row.
    const asP2 = await svc.queryRanked(companyA, "tabs spaces config indent preference", {
      limit: 25,
      ownerType: "user",
      ownerId: "principal-P2",
    });
    expect(asP2.items.map((i) => i.id)).not.toContain(p1Entry.id);

    // And a query with NO owner context (workspace-only view) never leaks personal.
    const noOwner = await svc.queryRanked(companyA, "tabs spaces config indent preference", {
      limit: 25,
    });
    expect(noOwner.items.map((i) => i.id)).not.toContain(p1Entry.id);
  });
});

describe("central-db integration — A3) 2-DB mode physical separation + tenant isolation", () => {
  let main: TestDbHandle;
  let context: TestDbHandle;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    main = await startTestDb();
    context = await startIsolatedTestDb();
    companyA = await makeCompany(main.db, "TwoDbCoA");
    companyB = await makeCompany(main.db, "TwoDbCoB");
  }, 120_000);

  afterEach(() => {
    delete process.env[CTX_ENV_KEY];
  });

  afterAll(async () => {
    delete process.env[CTX_ENV_KEY];
    if (context) await context.stop();
    if (main) await stopTestDb();
  });

  it("A3: two companies coexist in the CONTEXT db, stay company-scoped, and the MAIN db memory_entries stays empty", async () => {
    process.env[CTX_ENV_KEY] = context.connectionString;
    // Service resolves its context db at construction → build AFTER env is set.
    expect(resolveContextDb(main.db)).not.toBe(main.db);
    const svc = memoryService(main.db);

    const aEntry = await svc.createEntry({
      companyId: companyA,
      layer: "workspace",
      subject: "Two-DB tenant A retention policy",
      body: "Tenant A keeps audit logs for 7 years.",
      tags: ["retention"],
      serviceScope: "compliance",
    });
    const bEntry = await svc.createEntry({
      companyId: companyB,
      layer: "workspace",
      subject: "Two-DB tenant B retention policy",
      body: "Tenant B keeps audit logs for 90 days.",
      tags: ["retention"],
      serviceScope: "compliance",
    });

    // Company-scoped retrieval in 2-DB mode: A never sees B (and vice-versa).
    const asA = await svc.queryRanked(companyA, "audit log retention policy", { limit: 25 });
    expect(asA.items.map((i) => i.id)).toEqual(
      expect.arrayContaining([aEntry.id]),
    );
    expect(asA.items.map((i) => i.id)).not.toContain(bEntry.id);

    const asB = await svc.queryRanked(companyB, "audit log retention policy", { limit: 25 });
    expect(asB.items.map((i) => i.id)).toContain(bEntry.id);
    expect(asB.items.map((i) => i.id)).not.toContain(aEntry.id);

    // PHYSICAL SEPARATION: both rows live in the CONTEXT db.
    const ctxDirect = createDb(context.connectionString);
    const inContext = await ctxDirect
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.id, aEntry.id));
    expect(inContext).toHaveLength(1);
    const inContextB = await ctxDirect
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.id, bEntry.id));
    expect(inContextB).toHaveLength(1);

    // ...and the MAIN db's memory_entries is empty for BOTH companies.
    const inMainA = await main.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.companyId, companyA));
    expect(inMainA).toHaveLength(0);
    const inMainB = await main.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.companyId, companyB));
    expect(inMainB).toHaveLength(0);
  }, 60_000);
});

describe("central-db integration — B) no embedding issues (single-DB)", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    companyId = await makeCompany(handle.db, "EmbedCo");
  }, 120_000);

  afterAll(async () => {
    await stopTestDb();
  });

  it("B1: version-guard — a hash-64 entry is NOT semantically cross-scored by a real-version query (semantic 0, lexical-only)", async () => {
    // Store via the DEFAULT (hash-64) embedder → embedding_version 'hash-64:64'.
    const hashSvc = memoryService(handle.db);
    const stored = await hashSvc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Versionguard zephyr token rotation cadence",
      body: "Rotate the zephyr token every quarter.",
      tags: ["security"],
    });
    const row = await hashSvc.getEntry(stored.id);
    expect(row?.embeddingVersion).toBe(HASH_EMBEDDING_VERSION);

    // Query through a REAL-version embedder (stub driver, no network). Its query
    // embedding carries version 'openai:test:4'; the entry is 'hash-64:64', so
    // the cosine version-guard MUST refuse to cross-score → semantic contribution
    // is 0 and the only signal is lexical (shared "zephyr token rotation" tokens).
    const realSvc = memoryService(handle.db, makeRealVersionEmbedder());
    const res = await realSvc.queryRanked(companyId, "versionguard zephyr token rotation cadence", {
      limit: 10,
      includeSnippets: false,
    });
    const hit = res.items.find((i) => i.id === stored.id);
    expect(hit).toBeTruthy();
    // The hit must come from lexical overlap, never a garbage cross-space cosine.
    // Make the guard LOAD-BEARING: build a query vector that OVERLAPS a nonzero
    // dimension of the stored hash entry so an UNGUARDED dot would be > 0. The zero
    // below can then ONLY come from the version-guard, not a coincidental miss.
    const { rankEntries, cosineSimilarity } = await import("../memory.js");
    const entryVec = row!.embedding as number[];
    const firstNonZero = entryVec.findIndex((x) => x !== 0);
    expect(firstNonZero).toBeGreaterThanOrEqual(0);
    const qVec = new Array<number>(entryVec.length).fill(0);
    qVec[firstNonZero] = 1; // unit vector overlapping the entry's occupied dim
    // Positive control: same-space cosine (no version args) is genuinely > 0 …
    expect(cosineSimilarity(qVec, entryVec)).toBeGreaterThan(0);
    // … but the cross-version guard (real query vs hash entry) refuses to score.
    expect(cosineSimilarity(qVec, entryVec, REAL_TEST_VERSION, HASH_EMBEDDING_VERSION)).toBe(0);
    const [ranked] = rankEntries(
      "versionguard zephyr token rotation cadence",
      [
        {
          id: stored.id,
          layer: "workspace",
          subject: row!.subject,
          body: row!.body,
          tags: row!.tags,
          embedding: entryVec,
          embeddingVersion: HASH_EMBEDDING_VERSION,
          lastUsedAt: null,
          updatedAt: new Date(),
        },
      ],
      {},
      { vector: qVec, version: REAL_TEST_VERSION },
    );
    expect(ranked.semantic).toBe(0);
    expect(ranked.lexical).toBeGreaterThan(0);
  });

  it("B2: no-key path — createEntry + queryRanked work via hash-64 with zero driver calls and never throw", async () => {
    // The default embedder is disabled (no key in test env): assert that.
    const defaultEmbedder = makeMemoryEmbedder();
    expect(defaultEmbedder.enabled).toBe(false);
    expect(defaultEmbedder.version).toBe(HASH_EMBEDDING_VERSION);

    const svc = memoryService(handle.db);
    const created = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Nokeypath quokka deployment checklist",
      body: "Always run the quokka smoke test before deploy.",
      tags: ["deploy"],
    });
    expect(created.embeddingVersion).toBe(HASH_EMBEDDING_VERSION);

    const res = await svc.queryRanked(companyId, "nokeypath quokka deployment checklist", {
      limit: 10,
    });
    expect(res.items.map((i) => i.id)).toContain(created.id);
  });

  it("B3: redact-before-embed — a body with an sk- secret quarantines the entry to needs_review (excluded from requireVerified), and the secret never egresses to the embedder", async () => {
    // The redact-before-embed boundary lives INSIDE the real embedder: scanBody
    // runs BEFORE any provider egress, the secret is stripped from the EGRESSED
    // text, and the storage path REPORTS the findings so createEntry quarantines
    // the row to needs_review (the stored `body` column is intentionally left
    // verbatim — body redaction is the capture HOOK's job; the trust-tier
    // quarantine is the central-DB invariant under test here).
    const secret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWX";
    const body = `The grault prod key is ${secret} do not share.`;

    // (a) The egress boundary: the embedder's scanBody redacts the secret out of
    //     the text it would send to the provider, and reports the finding. We
    //     capture exactly what reached the (stub) driver and assert the raw secret
    //     is NOT in it — proving the scrub happened BEFORE egress, not just that a
    //     finding was reported.
    const egressed: string[] = [];
    const realEmbedder = makeRealVersionEmbedder(egressed);
    const embedResult = await realEmbedder.embedForStorage("Redactme grault prod credential note", body);
    expect(embedResult.redactedFindings.length).toBeGreaterThan(0);
    expect(embedResult.contentHash).toBeTruthy();
    expect(egressed.length).toBeGreaterThan(0);
    for (const sent of egressed) expect(sent).not.toContain(secret);

    // (b) The central-DB invariant: a body that tripped the scanner forces the
    //     entry to needs_review so a leaked secret can never land in the
    //     highest-trust verified tier.
    const svc = memoryService(handle.db, realEmbedder);
    const created = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Redactme grault prod credential note",
      body,
      tags: ["secret"],
    });

    const row = await svc.getEntry(created.id);
    expect(row).toBeTruthy();
    expect(row!.verificationState).toBe("needs_review");

    // A requireVerified retrieval (the trust filter) must NOT surface a
    // needs_review row even though it lexically matches.
    const verifiedOnly = await svc.queryRanked(companyId, "redactme grault prod credential note", {
      limit: 10,
      requireVerified: true,
    });
    expect(verifiedOnly.items.map((i) => i.id)).not.toContain(created.id);

    // ...but a label-only (no requireVerified) retrieval still finds it.
    const labelOnly = await svc.queryRanked(companyId, "redactme grault prod credential note", {
      limit: 10,
    });
    expect(labelOnly.items.map((i) => i.id)).toContain(created.id);
  });

  it("B4: mixed-version corpus — hash-64 and real-version entries coexist; queryRanked returns sensibly and never throws", async () => {
    const hashSvc = memoryService(handle.db);
    const realSvc = memoryService(handle.db, makeRealVersionEmbedder());

    const hashEntry = await hashSvc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Mixedcorpus garply caching strategy hash",
      body: "Cache garply responses for 60 seconds.",
      tags: ["cache"],
    });
    const realEntry = await realSvc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Mixedcorpus garply caching strategy real",
      body: "Cache garply responses for 120 seconds.",
      tags: ["cache"],
    });
    const hashRow = await hashSvc.getEntry(hashEntry.id);
    const realRow = await realSvc.getEntry(realEntry.id);
    expect(hashRow!.embeddingVersion).toBe(HASH_EMBEDDING_VERSION);
    expect(realRow!.embeddingVersion).toBe(REAL_TEST_VERSION);

    // Query both ways — neither path throws, and the matching-version entry is
    // surfaced (with lexical carrying the cross-version one).
    const viaHash = await hashSvc.queryRanked(companyId, "mixedcorpus garply caching strategy", {
      limit: 25,
    });
    expect(viaHash.items.length).toBeGreaterThan(0);
    expect(viaHash.items.map((i) => i.id)).toContain(hashEntry.id);

    const viaReal = await realSvc.queryRanked(companyId, "mixedcorpus garply caching strategy", {
      limit: 25,
    });
    expect(viaReal.items.length).toBeGreaterThan(0);
    expect(viaReal.items.map((i) => i.id)).toContain(realEntry.id);
  });
});

describe("central-db integration — C) right quality & amount per task (passdown + sufficiency)", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    companyId = await makeCompany(handle.db, "TierCo");
  }, 120_000);

  afterAll(async () => {
    await stopTestDb();
  });

  /**
   * Seed a verified SHARED entry via the promotion path (the only way to create
   * a shared row), which lands verified/verified-summary/0.9. Returns the entry.
   */
  async function seedSharedVerified(svc: ReturnType<typeof memoryService>, subject: string, body: string) {
    const src = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject,
      body,
      tags: ["shared-seed"],
    });
    const promo = await svc.proposePromotion({
      companyId,
      sourceEntryId: src.id,
      proposerType: "user",
      proposerId: "em-user",
    });
    const decided = await svc.decidePromotion(promo!.id, {
      decision: "approved",
      reviewerId: "em-user",
    });
    return svc.getEntry(decided!.promotedEntryId!);
  }

  it("C1: tiering — small ≤3 shared-only within budget; large up to 12 spanning shared+workspace", async () => {
    const svc = memoryService(handle.db);
    const passdown = passdownService(handle.db);

    // Seed many SHARED verified entries (≥ small's cap) + WORKSPACE verified
    // entries (the human-answer shape gives a verified workspace row).
    const sharedSubjects = [
      "Tiering alpha gateway timeout convention applies broadly",
      "Tiering beta gateway retry policy convention applies broadly",
      "Tiering gamma gateway auth header convention applies broadly",
      "Tiering delta gateway rate limit convention applies broadly",
    ];
    for (const s of sharedSubjects) {
      await seedSharedVerified(svc, s, `${s} — body text for the gateway convention.`);
    }
    for (let i = 0; i < 5; i++) {
      await svc.createEntry({
        companyId,
        layer: "workspace",
        subject: `Tiering workspace gateway note ${i} applies broadly`,
        body: `Workspace gateway operational note ${i} for the gateway service.`,
        tags: ["gateway"],
        serviceScope: "gateway",
        provenance: "human-answer",
        verificationState: "verified",
        confidence: 0.95,
        authorType: "user",
      });
    }

    const query = {
      companyId,
      childIssueId: "00000000-0000-0000-0000-000000000001",
      title: "Tiering gateway convention applies broadly",
      description: "Implement the gateway timeout retry auth rate limit conventions.",
      serviceScope: "gateway",
    };

    const small = await passdown.buildPassdownPacket({ ...query, complexity: "small" });
    expect(small.items.length).toBeGreaterThan(0);
    expect(small.items.length).toBeLessThanOrEqual(PASSDOWN_TIERS.small.maxEntries);
    // small is SHARED-only.
    expect(small.items.every((i) => i.layer === "shared")).toBe(true);
    expect(small.estimatedTokens).toBeLessThanOrEqual(PASSDOWN_TIERS.small.maxTokens);

    const large = await passdown.buildPassdownPacket({ ...query, complexity: "large" });
    expect(large.items.length).toBeLessThanOrEqual(PASSDOWN_TIERS.large.maxEntries);
    // large may span shared + workspace, never personal.
    const largeLayers = new Set(large.items.map((i) => i.layer));
    expect(largeLayers.has("personal")).toBe(false);
    expect(large.estimatedTokens).toBeLessThanOrEqual(PASSDOWN_TIERS.large.maxTokens);
    // large carries MORE context than small (broader budget + layers).
    expect(large.items.length).toBeGreaterThanOrEqual(small.items.length);
    // And large reaches into the workspace layer the small tier excludes.
    expect(largeLayers.has("workspace")).toBe(true);
  });

  it("C2: passdown requireVerified — an unverified agent-claim is EXCLUDED, a verified human-answer is INCLUDED", async () => {
    const svc = memoryService(handle.db);
    const passdown = passdownService(handle.db);

    const verified = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Requireverify zorp webhook signature is mandatory",
      body: "Always validate the zorp webhook signature before processing.",
      tags: ["zorp", "webhook"],
      serviceScope: "zorp",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
    });
    // An agent-claim on the SAME topic — forced unverified by the write-gate.
    const agentClaim = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Requireverify zorp webhook signature is optional probably",
      body: "I think the zorp webhook signature might be optional.",
      tags: ["zorp", "webhook"],
      serviceScope: "zorp",
      provenance: "agent-claim",
      authorType: "agent",
      confidence: 0.9,
    });
    expect((await svc.getEntry(agentClaim.id))!.verificationState).toBe("unverified");

    const packet = await passdown.buildPassdownPacket({
      companyId,
      childIssueId: "00000000-0000-0000-0000-000000000002",
      title: "Requireverify zorp webhook signature handling",
      description: "Handle zorp webhook signature validation.",
      serviceScope: "zorp",
      complexity: "large",
    });
    const ids = packet.items.map((i) => i.entryId);
    expect(ids).toContain(verified.id);
    expect(ids).not.toContain(agentClaim.id);
  });

  it("C3: sufficiency — insufficient when no verified item + zero entity coverage + low requirement coverage; sufficient on a strong verified match", async () => {
    // INSUFFICIENT: a single unverified low-coverage hit. With the hash-64
    // calibrated thresholds all three insufficiency conditions hold.
    const insufficient = evaluateSufficiency({
      items: [
        {
          score: 0.05,
          verificationState: "unverified",
          provenance: "agent-claim",
          confidence: 0.3,
          serviceScope: "unrelated",
          subject: "totally unrelated note",
        },
      ],
      serviceScope: "payments-ledger",
      requirementTokens: extractRequirementTokens(
        "implement the payments ledger reconciliation settlement window",
      ),
      complexity: "medium",
      embeddingVersion: LEGACY_HASH_EMBEDDING_VERSION,
    });
    expect(insufficient.verdict).toBe("insufficient");
    expect(insufficient.verifiedCovered).toBe(false);
    expect(insufficient.entityCoverage).toBe(0);
    expect(insufficient.reasons).toContain("no_verified_trusted_item");
    expect(insufficient.reasons).toContain("entity_coverage_zero");

    // SUFFICIENT: a strong verified human-answer that covers the ticket scope +
    // the requirement tokens.
    const sufficient = evaluateSufficiency({
      items: [
        {
          score: 0.9,
          verificationState: "verified",
          provenance: "human-answer",
          confidence: 0.95,
          serviceScope: "payments-ledger",
          subject: "payments ledger reconciliation settlement window default",
        },
      ],
      serviceScope: "payments-ledger",
      requirementTokens: extractRequirementTokens(
        "payments ledger reconciliation settlement window",
      ),
      complexity: "medium",
      embeddingVersion: LEGACY_HASH_EMBEDDING_VERSION,
    });
    expect(sufficient.verdict).toBe("sufficient");
    expect(sufficient.verifiedCovered).toBe(true);
    expect(sufficient.entityCoverage).toBeGreaterThan(0);
    expect(sufficient.requirementCoverage).toBeGreaterThanOrEqual(sufficient.thresholds.reqCover);
  });
});

describe("central-db integration — D) answers & approved context routed correctly", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    companyId = await makeCompany(handle.db, "RouteCo");
  }, 120_000);

  afterAll(async () => {
    await stopTestDb();
  });

  it("D1: HOOK 1 shape — a human-answer createEntry lands as human-answer/verified/workspace with the canonical source", async () => {
    const svc = memoryService(handle.db);
    const issueId = "11111111-1111-1111-1111-111111111111";
    const commentId = "22222222-2222-2222-2222-222222222222";
    const source = `human-answer:${issueId}:${commentId}`;
    const entry = await svc.createEntry({
      companyId,
      layer: "workspace",
      kind: "fact",
      subject: "Should missing spouse income default to zero?",
      body: "Q: Should missing spouse income default to zero?\nA: Yes, default it to zero.",
      source,
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
      sourceRefType: "comment",
      sourceRefId: commentId,
    });
    expect(entry.provenance).toBe("human-answer");
    expect(entry.verificationState).toBe("verified");
    expect(entry.layer).toBe("workspace");
    expect(entry.source).toBe(source);
    expect(entry.authorType).toBe("user");
  });

  it("D2: HOOK 2 shape — a pr-approval createEntry lands as pr-approval/verified/convention with the approval source", async () => {
    const svc = memoryService(handle.db);
    const approvalId = "33333333-3333-3333-3333-333333333333";
    const source = `pr-approval:${approvalId}`;
    const entry = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "EM approved PR ade#123: feat: durable change",
      body: "Always validate webhook signatures before processing.\n\napproved by lead-reviewer",
      kind: "convention",
      source,
      provenance: "pr-approval",
      verificationState: "verified",
      confidence: 0.8,
      authorType: "user",
      createdBy: "em-user-1",
      sourceRefType: "approval",
      sourceRefId: approvalId,
    });
    expect(entry.provenance).toBe("pr-approval");
    expect(entry.verificationState).toBe("verified");
    expect(entry.kind).toBe("convention");
    expect(entry.source).toBe(source);
  });

  it("D3: write-gate — an agent-authored createEntry is forced unverified/agent-claim and excluded from a requireVerified query", async () => {
    const svc = memoryService(handle.db);
    // The agent ASKS for verified/0.95 — the write-gate must clamp it.
    const entry = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Writegate flarn caching ttl is thirty seconds",
      body: "The flarn cache TTL is 30 seconds.",
      tags: ["flarn"],
      authorType: "agent",
      verificationState: "verified",
      confidence: 0.95,
    });
    expect(entry.verificationState).toBe("unverified");
    expect(entry.provenance).toBe("agent-claim");
    expect(entry.confidence).toBeLessThanOrEqual(0.4);

    const verifiedOnly = await svc.queryRanked(companyId, "writegate flarn caching ttl thirty seconds", {
      limit: 10,
      requireVerified: true,
    });
    expect(verifiedOnly.items.map((i) => i.id)).not.toContain(entry.id);

    // It is still retrievable in a label-only query (it was written, not dropped).
    const labelOnly = await svc.queryRanked(companyId, "writegate flarn caching ttl thirty seconds", {
      limit: 10,
    });
    expect(labelOnly.items.map((i) => i.id)).toContain(entry.id);
  });

  it("D4: conflict precedence — on the same subjectKey, queryRanked surfaces only the human-answer; the agent-claim loser is dropped", async () => {
    const svc = memoryService(handle.db);
    // Identical SUBJECT → identical subjectKey, so they conflict.
    const subject = "Conflictkey snarf retention window is fourteen days";
    const human = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject,
      body: "Human-verified: the snarf retention window is 14 days.",
      tags: ["snarf"],
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
    });
    const agent = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject,
      body: "Agent claim: the snarf retention window is 30 days.",
      tags: ["snarf"],
      provenance: "agent-claim",
      authorType: "agent",
    });
    // Same subjectKey assigned to both.
    const humanRow = await svc.getEntry(human.id);
    const agentRow = await svc.getEntry(agent.id);
    expect(humanRow!.subjectKey).toBe(agentRow!.subjectKey);
    expect(humanRow!.subjectKey).toBeTruthy();

    const res = await svc.queryRanked(companyId, "conflictkey snarf retention window fourteen days", {
      limit: 25,
    });
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain(human.id);
    expect(ids).not.toContain(agent.id);
  });

  it("D5: close the loop — a human answer (HOOK 1 verified workspace entry) is INCLUDED in a later EM passdown for a related child ticket", async () => {
    const svc = memoryService(handle.db);
    const passdown = passdownService(handle.db);
    const issueId = "44444444-4444-4444-4444-444444444444";
    const commentId = "55555555-5555-5555-5555-555555555555";

    // HOOK 1: a human answers a question about the plonk service auth model.
    const answer = await svc.createEntry({
      companyId,
      layer: "workspace",
      kind: "fact",
      subject: "How should the plonk service authenticate inbound requests?",
      body:
        "Q: How should the plonk service authenticate inbound requests?\n" +
        "A: Use mutual TLS with the shared plonk client certificate.",
      source: `human-answer:${issueId}:${commentId}`,
      serviceScope: "plonk",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
      sourceRefType: "comment",
      sourceRefId: commentId,
    });

    // Later: an EM builds a passdown for a RELATED child ticket on the same service.
    const packet = await passdown.buildPassdownPacket({
      companyId,
      childIssueId: "66666666-6666-6666-6666-666666666666",
      title: "Wire up plonk service inbound authentication",
      description: "Implement how the plonk service should authenticate inbound requests.",
      serviceScope: "plonk",
      complexity: "large",
    });
    expect(packet.items.map((i) => i.entryId)).toContain(answer.id);
    // The rendered body carries the verified answer text the child agent will read.
    expect(packet.body).toContain("mutual TLS");
  });
});
