import { Router } from "express";
import type { Db } from "@combyne/db";
import {
  createMemoryEntrySchema,
  updateMemoryEntrySchema,
  memoryQuerySchema,
  memoryManifestQuerySchema,
  memoryCoreBuildSchema,
  memoryRecordUsageSchema,
  memoryProposePromotionSchema,
  memoryDecidePromotionSchema,
  MEMORY_PROVENANCES,
  MEMORY_VERIFICATION_STATES,
  type MemoryOwnerType,
  type MemoryProvenance,
  type MemoryVerificationState,
} from "@combyne/shared";
import { validate } from "../middleware/validate.js";
import { memoryService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo, assertBoard } from "./authz.js";
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

  router.get("/companies/:companyId/memory/entries", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
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
      layer: layer === "workspace" || layer === "personal" || layer === "shared" ? layer : undefined,
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
      const updated = await svc.updateEntry(id, req.body);
      await logActivity(db, {
        companyId: existing.companyId,
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
    const archived = await svc.archiveEntry(id);
    await logActivity(db, {
      companyId: existing.companyId,
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
      });
      res.json(result);
    },
  );

  router.get("/companies/:companyId/memory/manifest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
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
      const actor = getActorInfo(req);
      const body = req.body as ReturnType<typeof memoryRecordUsageSchema.parse>;
      await svc.recordUsage({
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

  router.post("/companies/:companyId/memory/decay", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const archived = await svc.runDecayPass(companyId);
    res.json({ archived });
  });

  router.post("/companies/:companyId/memory/auto-distill", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
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
    assertBoard(req);
    const status = await svc.embeddingStatus(companyId);
    res.json(status);
  });

  return router;
}
