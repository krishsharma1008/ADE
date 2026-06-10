import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentHandoffs, companies, issues } from "@combyne/db";
import { memoryService } from "../memory.js";
import { passdownService, isPassdownPacket, PASSDOWN_TIERS } from "../em-passdown.js";
import { createHandoff } from "../agent-handoff.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

/**
 * PR-9 acceptance — the EM passdown packet (CENTRAL_CONTEXT_DB_PLAN §5).
 *
 *  - the packet is requireVerified-only, drawn from [shared,workspace] (NEVER personal)
 *  - it unions the EM-pinned curatedMemoryEntryIds, with a launder guard
 *  - it respects the small/medium/large size tiers
 *  - it is persisted into agent_handoffs.artifactRefs (no longer always [])
 */
describe("em-passdown packet (PR-9)", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentA: string;
  let agentB: string;
  let childIssueId: string;

  // Seeded entry ids for assertions.
  let verifiedSharedId: string;
  let verifiedWorkspaceId: string;
  let unverifiedWorkspaceId: string;
  let verifiedPersonalLikeId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const svc = memoryService(handle.db);

    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Passdown Co", issuePrefix: "PD" })
      .returning();
    companyId = company.id;

    const [a] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Manager", adapterType: "process" })
      .returning();
    const [b] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Worker", adapterType: "process" })
      .returning();
    agentA = a.id;
    agentB = b.id;

    const [child] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: "Wire up auth middleware with JWT cookies",
        description: "Replace legacy session storage with signed JWT auth on the server.",
        serviceScope: "server",
        assigneeAgentId: agentB,
      })
      .returning();
    childIssueId = child.id;

    // (1) Verified SHARED entry (the promotion path stamps verified/0.9).
    const sharedSource = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Auth tokens are signed JWTs in httpOnly cookies",
      body: "All auth uses signed JWT cookies; refresh handled by /auth/refresh on the server.",
      tags: ["auth", "jwt"],
      serviceScope: "server",
    });
    const proposal = await svc.proposePromotion({
      companyId,
      sourceEntryId: sharedSource.id,
      proposerType: "agent",
      proposerId: agentA,
    });
    const decided = await svc.decidePromotion(proposal!.id, {
      decision: "approved",
      reviewerId: "board-user",
    });
    verifiedSharedId = decided!.promotedEntryId!;

    // (2) Verified WORKSPACE entry (human-answer capture, authorType=user).
    const vw = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "JWT auth middleware convention",
      body: "Server JWT middleware lives in server/src/middleware/auth.ts and validates the cookie.",
      tags: ["auth", "jwt", "middleware"],
      serviceScope: "server",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
      authorId: "board-user",
    });
    verifiedWorkspaceId = vw.id;

    // (3) UNVERIFIED workspace entry (must NEVER appear in the vetted packet).
    const uw = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Unverified guess about JWT auth rotation",
      body: "An agent guessed JWT rotation is every 24h for the auth middleware — unverified.",
      tags: ["auth", "jwt"],
      serviceScope: "server",
      provenance: "agent-claim",
      authorType: "agent",
    });
    unverifiedWorkspaceId = uw.id;

    // (4) A verified PERSONAL entry (must NEVER appear — personal is excluded).
    const vp = await svc.createEntry({
      companyId,
      layer: "personal",
      ownerType: "agent",
      ownerId: agentB,
      subject: "Personal note about JWT auth middleware",
      body: "My private working note about the JWT auth middleware task.",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
      authorId: "board-user",
    });
    verifiedPersonalLikeId = vp.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("returns only requireVerified entries from [shared,workspace], never personal/unverified", async () => {
    const pkt = await passdownService(handle.db).buildPassdownPacket({
      companyId,
      childIssueId,
      title: "Wire up auth middleware with JWT cookies",
      description: "Replace legacy session storage with signed JWT auth on the server.",
      serviceScope: "server",
      complexity: "large",
    });

    const ids = pkt.items.map((i) => i.entryId);
    // verified shared + verified workspace are eligible
    expect(ids).toContain(verifiedSharedId);
    expect(ids).toContain(verifiedWorkspaceId);
    // unverified + personal are excluded on BOTH the trust and the layer axis
    expect(ids).not.toContain(unverifiedWorkspaceId);
    expect(ids).not.toContain(verifiedPersonalLikeId);
    expect(pkt.items.every((i) => i.layer === "shared" || i.layer === "workspace")).toBe(true);
    expect(pkt.body).toMatch(/Vetted context from your manager/);
  });

  it("small tier ranks over shared+workspace and stays capped at the tier entry count", async () => {
    const pkt = await passdownService(handle.db).buildPassdownPacket({
      companyId,
      childIssueId,
      title: "Wire up auth middleware with JWT cookies",
      description: "Replace legacy session storage with signed JWT auth on the server.",
      serviceScope: "server",
      complexity: "small",
    });
    expect(pkt.items.length).toBeLessThanOrEqual(PASSDOWN_TIERS.small.maxEntries);
    // Recall fix (e2e round-2): small tier ranks over the SAME layers as
    // medium/large — shared-only starved young corpora where every verified
    // fact lives in workspace. The tight entry/token budget is the small-tier
    // constraint, not layer starvation. Personal stays excluded.
    expect(PASSDOWN_TIERS.small.layers).toEqual(["shared", "workspace"]);
    expect(pkt.items.every((i) => i.layer === "shared" || i.layer === "workspace")).toBe(true);
  });

  it("unions EM-pinned curatedMemoryEntryIds and flags them, even off-query", async () => {
    const svc = memoryService(handle.db);
    // A verified entry that does NOT match the auth/jwt query vocabulary, so it
    // would not be retrieved by the ranker — only the curated pin surfaces it.
    const offTopic = await svc.createEntry({
      companyId,
      layer: "workspace",
      subject: "Deployment runbook for the billing cron",
      body: "The billing cron is paused during deploy windows; resume via the ops dashboard.",
      serviceScope: "ops",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
      authorId: "board-user",
    });

    const pkt = await passdownService(handle.db).buildPassdownPacket({
      companyId,
      childIssueId,
      title: "Wire up auth middleware with JWT cookies",
      description: "Replace legacy session storage with signed JWT auth.",
      serviceScope: "server",
      complexity: "large",
      curatedMemoryEntryIds: [offTopic.id],
    });
    const pinned = pkt.items.find((i) => i.entryId === offTopic.id);
    expect(pinned).toBeDefined();
    expect(pinned!.curated).toBe(true);
  });

  it("LAUNDER GUARD: a pinned UNVERIFIED or personal id cannot enter the packet", async () => {
    const pkt = await passdownService(handle.db).buildPassdownPacket({
      companyId,
      childIssueId,
      title: "Wire up auth middleware with JWT cookies",
      description: "Replace legacy session storage with signed JWT auth.",
      serviceScope: "server",
      complexity: "large",
      curatedMemoryEntryIds: [unverifiedWorkspaceId, verifiedPersonalLikeId],
    });
    const ids = pkt.items.map((i) => i.entryId);
    expect(ids).not.toContain(unverifiedWorkspaceId);
    expect(ids).not.toContain(verifiedPersonalLikeId);
  });

  it("createHandoff persists the packet into agent_handoffs.artifactRefs (no longer always [])", async () => {
    const row = await createHandoff(handle.db, {
      companyId,
      issueId: childIssueId,
      fromAgentId: agentA,
      toAgentId: agentB,
      complexity: "large",
      serviceScope: "server",
    });
    expect(row).not.toBeNull();

    const [persisted] = await handle.db
      .select()
      .from(agentHandoffs)
      .where(eq(agentHandoffs.id, row!.id));
    const refs = (persisted.artifactRefs ?? []) as unknown[];
    expect(refs.length).toBeGreaterThan(0);
    const packet = refs.find(isPassdownPacket);
    expect(packet).toBeDefined();
    expect(packet!.childIssueId).toBe(childIssueId);
    expect(packet!.items.length).toBeGreaterThan(0);
    expect(packet!.items.every((i) => i.layer !== "personal")).toBe(true);
    // The vetted packet is also embedded into the brief markdown for the
    // brief-fallback adapters (cursor/gemini/opencode/pi).
    expect(row!.brief).toMatch(/Vetted context from your manager/);
  });

  it("createHandoff with no vetted matches leaves artifactRefs empty", async () => {
    // A fresh company with no verified entries → empty packet → artifactRefs [].
    const [emptyCo] = await handle.db
      .insert(companies)
      .values({ name: "Empty Co", issuePrefix: "EC" })
      .returning();
    const [worker] = await handle.db
      .insert(agents)
      .values({ companyId: emptyCo.id, name: "W", adapterType: "process" })
      .returning();
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId: emptyCo.id, title: "Nothing vetted here", description: "x" })
      .returning();
    const row = await createHandoff(handle.db, {
      companyId: emptyCo.id,
      issueId: issue.id,
      fromAgentId: null,
      toAgentId: worker.id,
      complexity: "small",
    });
    expect(row).not.toBeNull();
    expect(row!.artifactRefs).toEqual([]);
  });
});
