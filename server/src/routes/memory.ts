import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agentHandoffs, issues } from "@combyne/db";
import type { MemoryPassdownPacket } from "@combyne/shared";
import { isPassdownPacket } from "../services/em-passdown.js";
import {
  createMemoryEntrySchema,
  createGlobalMemoryEntrySchema,
  memoryPromoteGlobalSchema,
  updateMemoryEntrySchema,
  memoryQuerySchema,
  memoryManifestQuerySchema,
  memoryCoreBuildSchema,
  memoryRecordUsageSchema,
  memoryProposePromotionSchema,
  memoryDecidePromotionSchema,
  memoryResolveConflictSchema,
  memoryResolveRedactionSchema,
  MEMORY_PROVENANCES,
  MEMORY_VERIFICATION_STATES,
  type MemoryOwnerType,
  type MemoryProvenance,
  type MemoryVerificationState,
} from "@combyne/shared";
import { validate } from "../middleware/validate.js";
import { memoryService, logActivity } from "../services/index.js";
import {
  assertCompanyAccess,
  assertPinnedCompany,
  getActorInfo,
  assertBoard,
  assertInstanceAdmin,
} from "./authz.js";
import { forbidden } from "../errors.js";

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  router.post(
    "/companies/:companyId/memory/entries",
    validate(createMemoryEntrySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertPinnedCompany(companyId);
      const actor = getActorInfo(req);
      const body = req.body as ReturnType<typeof createMemoryEntrySchema.parse>;
      if (body.layer === "personal") {
        const requesterIsOwner =
          (body.ownerType === "agent" && actor.agentId === body.ownerId) ||
          (body.ownerType === "user" && actor.actorType === "user" && actor.actorId === body.ownerId);
        if (!requesterIsOwner) {
          throw forbidden("personal entries can only be created by their owner");
        }
      }

      // Trust spine (§3.2): authorType is derived from the ACTOR, never from the
      // request body. An agent principal can NEVER author a verified row or a
      // human-tier provenance — the service write-gate also enforces this, and
      // here we reject the attempt outright (defense-in-depth + clearer error)
      // so an agent can't even request it. Only a board principal may stamp a
      // verified state or a human-answer/pr-approval provenance.
      const isBoard = req.actor.type === "board";
      const authorType = actor.actorType === "agent" ? "agent" : "user";
      let provenance = body.provenance ?? null;
      let verificationState = body.verificationState ?? undefined;
      let confidence = body.confidence ?? undefined;
      const wantsTrustedProvenance =
        provenance === "human-answer" || provenance === "pr-approval";
      const wantsVerified = verificationState === "verified";
      if (!isBoard && (wantsTrustedProvenance || wantsVerified)) {
        throw forbidden(
          "only a board principal can set a verified state or a human-tier provenance",
        );
      }
      if (authorType === "agent") {
        // Belt-and-braces: strip any trust override before it reaches the service.
        provenance = provenance && wantsTrustedProvenance ? null : provenance;
        verificationState = undefined;
        confidence = undefined;
      }

      const entry = await svc.createEntry({
        companyId,
        layer: body.layer,
        subject: body.subject,
        body: body.body,
        kind: body.kind,
        tags: body.tags,
        serviceScope: body.serviceScope ?? null,
        source: body.source ?? null,
        ownerType: body.ownerType ?? null,
        ownerId: body.ownerId ?? null,
        ttlDays: body.ttlDays ?? null,
        createdBy: actor.actorId,
        provenance,
        verificationState,
        confidence,
        authorType,
        authorId: body.authorId ?? actor.actorId,
        sourceRefType: body.sourceRefType ?? null,
        sourceRefId: body.sourceRefId ?? null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.entry.created",
        entityType: "memory_entry",
        entityId: entry.id,
        details: { layer: entry.layer, subject: entry.subject },
      });
      res.status(201).json(entry);
    },
  );

  // ---------- 0054: instance-wide GLOBAL layer ----------

  // Create an instance-wide GLOBAL entry (company-agnostic, company_id NULL).
  // Instance-admin ONLY (assertInstanceAdmin) — mirrors the shared-layer write
  // fence, but governed at the instance tier rather than the company board. A
  // global entry is retrievable by EVERY company on the instance.
  router.post(
    "/memory/global/entries",
    validate(createGlobalMemoryEntrySchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const body = req.body as ReturnType<typeof createGlobalMemoryEntrySchema.parse>;
      const entry = await svc.createEntry({
        companyId: null,
        layer: "global",
        isInstanceAdmin: true,
        subject: body.subject,
        body: body.body,
        kind: body.kind,
        tags: body.tags,
        serviceScope: body.serviceScope ?? null,
        source: body.source ?? null,
        ttlDays: body.ttlDays ?? null,
        createdBy: actor.actorId,
        // Instance-admin-authored global facts are board-tier human content.
        provenance: "verified-summary",
        verificationState: "verified",
        confidence: 0.9,
        authorType: "user",
        authorId: actor.actorId,
      });
      res.status(201).json(entry);
    },
  );

  // Promote an existing verified workspace/shared entry to the GLOBAL layer.
  // Instance-admin ONLY. Copies the source into a company-agnostic global row;
  // the original is left intact.
  router.post(
    "/memory/global/promote",
    validate(memoryPromoteGlobalSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const body = req.body as ReturnType<typeof memoryPromoteGlobalSchema.parse>;
      // PIN FENCE (Cond 1): global rows bypass the pin BY DESIGN (company_id NULL),
      // so promoting an off-tenant source entry into the global layer would LAUNDER
      // another team's memory past the fence. Load the source first and assert the
      // promoter may access it AND that it belongs to the pinned tenant before the
      // company→global copy. A missing source 404s (same as the service's own guard).
      const source = await svc.getEntry(body.sourceEntryId);
      if (!source) {
        res.status(404).json({ error: "Source entry not found" });
        return;
      }
      assertCompanyAccess(req, source.companyId);
      assertPinnedCompany(source.companyId);
      let entry;
      try {
        entry = await svc.createGlobalFromEntry({
          sourceEntryId: body.sourceEntryId,
          isInstanceAdmin: true,
          createdBy: actor.actorId,
        });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : "Failed to promote to global",
        });
        return;
      }
      if (!entry) {
        res.status(404).json({ error: "Source entry not found" });
        return;
      }
      res.status(201).json(entry);
    },
  );

  router.get("/companies/:companyId/memory/entries", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    const layer = req.query.layer as string | undefined;
    const ownerType = req.query.ownerType as MemoryOwnerType | undefined;
    const ownerId = req.query.ownerId as string | undefined;
    const status = (req.query.status as string | undefined) ?? "active";
    // Trust-spine (0049) browse filters surfaced by the Memory UI (PR-13). Each
    // is validated against its enum/range before being passed to the service so
    // a malformed query string is simply ignored (no filter) rather than 500ing.
    const provenanceRaw = req.query.provenance as string | undefined;
    const provenance =
      provenanceRaw && (MEMORY_PROVENANCES as readonly string[]).includes(provenanceRaw)
        ? (provenanceRaw as MemoryProvenance)
        : undefined;
    const verificationRaw = req.query.verificationState as string | undefined;
    const verificationState =
      verificationRaw &&
      (MEMORY_VERIFICATION_STATES as readonly string[]).includes(verificationRaw)
        ? (verificationRaw as MemoryVerificationState)
        : undefined;
    const minConfidenceRaw = req.query.minConfidence as string | undefined;
    const minConfidenceParsed = minConfidenceRaw ? Number(minConfidenceRaw) : NaN;
    const minConfidence =
      Number.isFinite(minConfidenceParsed) && minConfidenceParsed >= 0 && minConfidenceParsed <= 1
        ? minConfidenceParsed
        : undefined;
    const serviceScope = (req.query.serviceScope as string | undefined) || undefined;
    const ageRaw = req.query.age as string | undefined;
    const ageParsed = ageRaw ? Number(ageRaw) : NaN;
    const ageDays = Number.isFinite(ageParsed) && ageParsed > 0 ? ageParsed : undefined;
    const list = await svc.listEntries({
      companyId,
      // M6: 'global' is honored so ?layer=global returns the instance-wide
      // company_id=NULL rows (service scopes by isNull(companyId) for that layer).
      // Company-scope still applies to every non-global layer.
      layer:
        layer === "workspace" || layer === "personal" || layer === "shared" || layer === "global"
          ? layer
          : undefined,
      ownerType,
      ownerId,
      status,
      provenance,
      verificationState,
      minConfidence,
      serviceScope,
      ageDays,
    });
    res.json(list);
  });

  router.get("/memory/entries/:id", async (req, res) => {
    const id = req.params.id as string;
    const entry = await svc.getEntry(id);
    if (!entry) {
      res.status(404).json({ error: "Memory entry not found" });
      return;
    }
    assertCompanyAccess(req, entry.companyId);
    assertPinnedCompany(entry.companyId);
    if (entry.layer === "personal") {
      const actor = getActorInfo(req);
      const isOwner =
        (entry.ownerType === "agent" && actor.agentId === entry.ownerId) ||
        (entry.ownerType === "user" && actor.actorType === "user" && actor.actorId === entry.ownerId);
      if (!isOwner) {
        throw forbidden("personal entries can only be read by their owner");
      }
    }
    res.json(entry);
  });

  router.patch(
    "/memory/entries/:id",
    validate(updateMemoryEntrySchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getEntry(id);
      if (!existing) {
        res.status(404).json({ error: "Memory entry not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      assertPinnedCompany(existing.companyId);
      const actor = getActorInfo(req);
      if (existing.layer === "personal") {
        const isOwner =
          (existing.ownerType === "agent" && actor.agentId === existing.ownerId) ||
          (existing.ownerType === "user" && actor.actorType === "user" && actor.actorId === existing.ownerId);
        if (!isOwner) {
          throw forbidden("personal entries can only be modified by their owner");
        }
      }
      if (existing.layer === "shared" && actor.actorType !== "user") {
        throw forbidden("shared entries can only be modified by a board user");
      }
      // Instance-wide GLOBAL entries (0054) are governed at the instance tier.
      if (existing.layer === "global") {
        assertInstanceAdmin(req);
      }
      const updated = await svc.updateEntry(id, req.body);
      await logActivity(db, {
        companyId: existing.companyId ?? "instance",
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.entry.updated",
        entityType: "memory_entry",
        entityId: id,
        details: req.body,
      });
      res.json(updated);
    },
  );

  router.delete("/memory/entries/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getEntry(id);
    if (!existing) {
      res.status(404).json({ error: "Memory entry not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    assertPinnedCompany(existing.companyId);
    const actor = getActorInfo(req);
    if (existing.layer === "personal") {
      const isOwner =
        (existing.ownerType === "agent" && actor.agentId === existing.ownerId) ||
        (existing.ownerType === "user" && actor.actorType === "user" && actor.actorId === existing.ownerId);
      if (!isOwner) {
        throw forbidden("personal entries can only be archived by their owner");
      }
    }
    if (existing.layer === "shared") {
      assertBoard(req);
    }
    // Instance-wide GLOBAL entries (0054) are governed at the instance tier.
    if (existing.layer === "global") {
      assertInstanceAdmin(req);
    }
    const archived = await svc.archiveEntry(id);
    await logActivity(db, {
      companyId: existing.companyId ?? "instance",
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.entry.archived",
      entityType: "memory_entry",
      entityId: id,
    });
    res.json(archived);
  });

  router.post(
    "/companies/:companyId/memory/query",
    validate(memoryQuerySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertPinnedCompany(companyId);
      const body = req.body as ReturnType<typeof memoryQuerySchema.parse>;
      const actor = getActorInfo(req);
      const ownerType = body.ownerType ?? (actor.agentId ? "agent" : "user");
      const ownerId = body.ownerId ?? actor.agentId ?? actor.actorId;
      const result = await svc.queryRanked(companyId, body.query, {
        layers: body.layers,
        ownerType,
        ownerId: ownerId === "board" ? undefined : ownerId,
        serviceScope: body.serviceScope,
        limit: body.limit,
        includeSnippets: body.includeSnippets,
        // M5: this query route is agent-reachable (an agent is admitted for its
        // own company). Agents get the §3.2 verified-only retrieval filter so an
        // unverified agent-claim can never be read back as fact; human/board
        // browsing stays unfiltered.
        requireVerified: actor.actorType === "agent",
      });
      res.json(result);
    },
  );

  router.get("/companies/:companyId/memory/manifest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    const parsed = memoryManifestQuerySchema.parse({
      taskId: req.query.taskId,
      ownerId: req.query.ownerId,
      ownerType: req.query.ownerType,
      serviceScope: req.query.serviceScope,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    const actor = getActorInfo(req);
    const ownerType = parsed.ownerType ?? (actor.agentId ? "agent" : "user");
    const ownerId =
      parsed.ownerId ?? (actor.agentId ?? (actor.actorId === "board" ? undefined : actor.actorId));
    const manifest = await svc.buildManifest(
      companyId,
      {
        taskId: parsed.taskId ?? null,
        ownerType,
        ownerId,
        serviceScope: parsed.serviceScope,
        // M5: manifest is agent-reachable — agents get verified-only retrieval,
        // human/board browsing stays unfiltered.
        requireVerified: actor.actorType === "agent",
      },
      parsed.limit,
    );
    res.json(manifest);
  });

  router.post(
    "/companies/:companyId/memory/core/build",
    validate(memoryCoreBuildSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertPinnedCompany(companyId);
      const body = req.body as ReturnType<typeof memoryCoreBuildSchema.parse>;
      const ctx = await svc.buildCoreContext(companyId, body.taskId);
      res.json(ctx);
    },
  );

  router.post(
    "/companies/:companyId/memory/core/refresh",
    validate(memoryCoreBuildSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertPinnedCompany(companyId);
      const body = req.body as ReturnType<typeof memoryCoreBuildSchema.parse>;
      const ctx = await svc.refreshCoreContext(companyId, body.taskId);
      res.json(ctx);
    },
  );

  router.post(
    "/memory/entries/:id/use",
    validate(memoryRecordUsageSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getEntry(id);
      if (!existing) {
        res.status(404).json({ error: "Memory entry not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      assertPinnedCompany(existing.companyId);
      const actor = getActorInfo(req);
      const body = req.body as ReturnType<typeof memoryRecordUsageSchema.parse>;
      await svc.recordUsage({
        // Global entries carry company_id = NULL; recordUsage skips the per-company
        // usage-event row for those but still bumps the entry's usageCount.
        entryId: id,
        companyId: existing.companyId,
        issueId: body.issueId ?? null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        score: body.score ?? null,
      });
      res.status(204).end();
    },
  );

  router.post(
    "/companies/:companyId/memory/promotions",
    validate(memoryProposePromotionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertPinnedCompany(companyId);
      const body = req.body as ReturnType<typeof memoryProposePromotionSchema.parse>;
      const actor = getActorInfo(req);
      const promotion = await svc.proposePromotion({
        companyId,
        sourceEntryId: body.sourceEntryId,
        proposedSubject: body.proposedSubject,
        proposedBody: body.proposedBody,
        proposedTags: body.proposedTags,
        proposedKind: body.proposedKind,
        proposerType: actor.actorType === "agent" ? "agent" : "user",
        proposerId: actor.actorId,
      });
      if (!promotion) {
        res.status(404).json({ error: "Source entry not found" });
        return;
      }
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.promotion.proposed",
        entityType: "memory_promotion",
        entityId: promotion.id,
        details: { sourceEntryId: body.sourceEntryId },
      });
      res.status(201).json(promotion);
    },
  );

  router.get("/companies/:companyId/memory/promotions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    const state = req.query.state as
      | "pending"
      | "approved"
      | "rejected"
      | undefined;
    const list = await svc.listPromotions(companyId, state);
    res.json(list);
  });

  router.post(
    "/memory/promotions/:id/decide",
    validate(memoryDecidePromotionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const actor = getActorInfo(req);
      const body = req.body as ReturnType<typeof memoryDecidePromotionSchema.parse>;
      // PIN FENCE (Cond 1): the /decide route is keyed ONLY by promotion id, but
      // approving inserts a shared memory row for the promotion's company. Fetch the
      // promotion FIRST and assert the board may access its tenant AND that it matches
      // the pin, BEFORE mutating — otherwise a board user on a pinned rail could push a
      // shared row for a different tenant. A missing promotion 404s.
      const existingPromotion = await svc.getPromotion(id);
      if (!existingPromotion) {
        res.status(404).json({ error: "Promotion not found" });
        return;
      }
      assertCompanyAccess(req, existingPromotion.companyId);
      assertPinnedCompany(existingPromotion.companyId);
      const promotion = await svc.decidePromotion(id, {
        decision: body.decision,
        reviewerId: actor.actorId,
        reviewNotes: body.reviewNotes ?? null,
      });
      if (!promotion) {
        res.status(404).json({ error: "Promotion not found" });
        return;
      }
      await logActivity(db, {
        companyId: promotion.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: `memory.promotion.${body.decision}`,
        entityType: "memory_promotion",
        entityId: id,
        details: { reviewNotes: body.reviewNotes ?? null },
      });
      res.json(promotion);
    },
  );

  // ---------- PR-14: Capture / Verify / Conflicts ----------

  // Capture inbox (§3.3): human-tier entries awaiting Confirm/Edit/Dismiss.
  router.get("/companies/:companyId/memory/capture-inbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    const items = await svc.captureInbox(companyId);
    res.json(items);
  });

  // Questions tab (PR-16 §3.1): the ask-don't-hallucinate loop made visible —
  // ALL human-answer entries (acknowledged or not) with their source question,
  // citation, and capture time. Company-scoped (mirrors capture-inbox).
  router.get("/companies/:companyId/memory/questions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    const items = await svc.questions(companyId);
    res.json(items);
  });

  // Verify queue (§3.4 hybrid SLA): agent-claims + reuse evidence + promotions.
  router.get("/companies/:companyId/memory/verify-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    const items = await svc.verifyQueue(companyId);
    res.json(items);
  });

  // Board verify action (§3.4): stamp an entry verified. Board-only.
  router.post("/memory/entries/:id/verify", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getEntry(id);
    if (!existing) {
      res.status(404).json({ error: "Memory entry not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    assertPinnedCompany(existing.companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const verified = await svc.verifyEntry(id, actor.actorId);
    if (!verified) {
      res.status(404).json({ error: "Memory entry not found" });
      return;
    }
    await logActivity(db, {
      companyId: existing.companyId ?? "instance",
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.entry.verified",
      entityType: "memory_entry",
      entityId: id,
    });
    res.json(verified);
  });

  // Detected conflicts (§3.5, the first-class ask): subjectKey groups with >1
  // distinct human-answer body.
  router.get("/companies/:companyId/memory/conflicts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    const groups = await svc.listConflicts(companyId);
    res.json(groups);
  });

  // Resolve a detected conflict (§3.5): override / merge / edit. Board-only.
  // MERGE writes a NEW canonical and supersedes BOTH originals (audit-preserving).
  router.post(
    "/companies/:companyId/memory/conflicts/:subjectKey/resolve",
    validate(memoryResolveConflictSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertPinnedCompany(companyId);
      assertBoard(req);
      const subjectKey = req.params.subjectKey as string;
      const actor = getActorInfo(req);
      const body = req.body as ReturnType<typeof memoryResolveConflictSchema.parse>;
      let canonical;
      try {
        canonical = await svc.resolveConflict({
          companyId,
          subjectKey,
          action: body.action,
          canonicalEntryId: body.canonicalEntryId,
          body: body.body,
          resolvedBy: actor.actorId,
        });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : "Failed to resolve conflict",
        });
        return;
      }
      if (!canonical) {
        res.status(404).json({ error: "No active conflict for that subject" });
        return;
      }
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: `memory.conflict.${body.action}`,
        entityType: "memory_entry",
        entityId: canonical.id,
        details: { subjectKey },
      });
      res.json(canonical);
    },
  );

  // ---------- PR-15: Redaction queue (§3.6, the blocking redact-before-embed gate) ----------

  // Lists `needs_review` entries held OUT of retrieval (secret-quarantine).
  // Board-only because the bodies can carry credential shapes. The UI masks the
  // body by default and only reveals on an explicit, audited board click.
  router.get("/companies/:companyId/memory/redaction-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    assertBoard(req);
    const entries = await svc.redactionQueue(companyId);
    res.json(entries);
  });

  // Resolve a redaction entry: approve-as-clean (→ verified, re-enters retrieval)
  // or reject/keep-redacted (→ archived). Board-only.
  router.post(
    "/memory/entries/:id/redaction/resolve",
    validate(memoryResolveRedactionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getEntry(id);
      if (!existing) {
        res.status(404).json({ error: "Memory entry not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      assertPinnedCompany(existing.companyId);
      assertBoard(req);
      const actor = getActorInfo(req);
      const body = req.body as ReturnType<typeof memoryResolveRedactionSchema.parse>;
      const resolved = await svc.resolveRedaction(id, body.action, actor.actorId);
      if (!resolved) {
        res.status(404).json({ error: "No needs_review entry for that id" });
        return;
      }
      await logActivity(db, {
        companyId: existing.companyId ?? "instance",
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: `memory.redaction.${body.action}`,
        entityType: "memory_entry",
        entityId: id,
      });
      res.json(resolved);
    },
  );

  router.post("/companies/:companyId/memory/decay", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    assertBoard(req);
    const archived = await svc.runDecayPass(companyId);
    res.json({ archived });
  });

  router.post("/companies/:companyId/memory/auto-distill", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    assertBoard(req);
    const minUsage = req.body?.minUsage ? Number(req.body.minUsage) : undefined;
    const max = req.body?.max ? Number(req.body.max) : undefined;
    const proposals = await svc.runAutoDistill(companyId, { minUsage, max });
    res.json({ proposals });
  });

  // Ops visibility for the embedding stack (§1.9): version coverage %,
  // hash-fallback rate, re-embed backlog, redaction-blocked count, HNSW index
  // presence, and config-vs-reality echoes. Read-only; board-scoped because it
  // exposes corpus-wide operational counts. This is the surface an operator
  // checks BEFORE flipping vectorSearchEnabled (backlog must be 0 first) and
  // mid-backfill to watch progress so "recall silently dropped" becomes visible.
  router.get("/companies/:companyId/memory/embedding-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    assertBoard(req);
    const status = await svc.embeddingStatus(companyId);
    res.json(status);
  });

  // Passdown audit (PR-16 §3.1 / §3.8): read-only list of recent EM passdown
  // packets — the vetted manifest each handoff carried into a delegated child
  // issue. Reads agent_handoffs joined to issues and parses the artifactRefs
  // jsonb via isPassdownPacket (the same guard the heartbeat re-hydration uses).
  // Curation lives in the delegate dialog (MemoryPassdownPicker); this is the
  // after-the-fact audit of what was pinned/retrieved.
  router.get("/companies/:companyId/memory/passdown-packets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertPinnedCompany(companyId);
    const rows = await db
      .select({
        handoffId: agentHandoffs.id,
        artifactRefs: agentHandoffs.artifactRefs,
        createdAt: agentHandoffs.createdAt,
        issueId: issues.id,
        issueTitle: issues.title,
        issueIdentifier: issues.identifier,
      })
      .from(agentHandoffs)
      .innerJoin(issues, eq(agentHandoffs.issueId, issues.id))
      .where(eq(agentHandoffs.companyId, companyId))
      .orderBy(desc(agentHandoffs.createdAt))
      .limit(100);

    const packets: MemoryPassdownPacket[] = [];
    for (const row of rows) {
      // artifactRefs is a jsonb manifest array; the passdown packet is the entry
      // whose `kind === 'passdown'`. A handoff may carry zero (no vetted context).
      const refs = Array.isArray(row.artifactRefs) ? row.artifactRefs : [];
      const packet = refs.find((ref) => isPassdownPacket(ref));
      if (!packet || !isPassdownPacket(packet)) continue;
      packets.push({
        handoffId: row.handoffId,
        childIssueId: row.issueId,
        childIssueTitle: row.issueTitle ?? null,
        childIssueIdentifier: row.issueIdentifier ?? null,
        complexity: packet.complexity,
        serviceScope: packet.serviceScope ?? null,
        entryCount: packet.items.length,
        estimatedTokens: packet.estimatedTokens,
        items: packet.items.map((item) => ({
          entryId: item.entryId,
          layer: item.layer,
          subject: item.subject,
          kind: item.kind,
          serviceScope: item.serviceScope,
          provenance: item.provenance,
          confidence: item.confidence,
          curated: item.curated,
        })),
        generatedAt: packet.generatedAt,
        createdAt: row.createdAt.toISOString(),
      });
    }
    res.json(packets);
  });

  return router;
}
