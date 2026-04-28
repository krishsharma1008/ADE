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
  type MemoryOwnerType,
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
    const list = await svc.listEntries({
      companyId,
      layer: layer === "workspace" || layer === "personal" || layer === "shared" ? layer : undefined,
      ownerType,
      ownerId,
      status,
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

  return router;
}
