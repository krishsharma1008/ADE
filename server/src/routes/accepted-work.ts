import { Router } from "express";
import type { Db } from "@combyne/db";
import {
  acceptedWorkCreateMemorySchema,
  acceptedWorkResolveSchema,
  acceptedWorkSimulateMergeSchema,
  type AcceptedWorkMemoryStatus,
} from "@combyne/shared";
import { validate } from "../middleware/validate.js";
import { acceptedWorkService, heartbeatService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, notFound } from "../errors.js";

function simulationEnabled() {
  return process.env.NODE_ENV !== "production" || process.env.COMBYNE_ENABLE_ACCEPTED_WORK_SIMULATION === "1";
}

export function acceptedWorkRoutes(db: Db) {
  const router = Router();
  const svc = acceptedWorkService(db);
  const heartbeat = heartbeatService(db);

  async function wakeManagerForEvent(event: { id: string; companyId: string; managerAgentId: string | null }) {
    if (!event.managerAgentId) return;
    await heartbeat.wakeup(event.managerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "accepted_work_merged_pr",
      payload: { acceptedWorkEventId: event.id },
      requestedByActorType: "system",
      requestedByActorId: "accepted-work",
      contextSnapshot: {
        acceptedWorkEventId: event.id,
        source: "accepted_work.merged_pr",
      },
    });
    await svc.markWakeRequested(event.id);
  }

  router.get("/companies/:companyId/accepted-work/events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as AcceptedWorkMemoryStatus | undefined;
    res.json(await svc.list(companyId, status));
  });

  router.get("/accepted-work/events/:id", async (req, res) => {
    const event = await svc.getById(req.params.id as string);
    if (!event) throw notFound("Accepted work event not found");
    assertCompanyAccess(req, event.companyId);
    res.json(event);
  });

  router.post(
    "/companies/:companyId/accepted-work/simulate-merge",
    validate(acceptedWorkSimulateMergeSchema),
    async (req, res) => {
      if (!simulationEnabled()) throw forbidden("Accepted work simulation is disabled");
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const parsed = acceptedWorkSimulateMergeSchema.parse(req.body);
      const result = await svc.upsertMergedPull({
        companyId,
        ...parsed,
        detectionSource: "simulation",
      });
      if (result.shouldWakeManager) await wakeManagerForEvent(result.event);
      await logActivity(db, {
        companyId,
        actorType: getActorInfo(req).actorType,
        actorId: getActorInfo(req).actorId,
        agentId: getActorInfo(req).agentId,
        action: "accepted_work.simulated",
        entityType: "accepted_work_event",
        entityId: result.event.id,
        details: { repo: result.event.repo, pullNumber: result.event.pullNumber },
      });
      res.status(result.created ? 201 : 200).json(result.event);
    },
  );

  router.post("/companies/:companyId/accepted-work/reconcile/github", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.reconcileGitHubCompany(companyId, "github_reconcile");
    for (const event of result.events) {
      if (event.managerAgentId && !event.wakeupRequestedAt && event.memoryStatus === "pending") {
        await wakeManagerForEvent(event);
      }
    }
    await logActivity(db, {
      companyId,
      actorType: getActorInfo(req).actorType,
      actorId: getActorInfo(req).actorId,
      agentId: getActorInfo(req).agentId,
      action: "accepted_work.github_reconciled",
      entityType: "company",
      entityId: companyId,
      details: { scanned: result.scanned, upserted: result.upserted },
    });
    res.json(result);
  });

  router.post(
    "/accepted-work/events/:id/memory",
    validate(acceptedWorkCreateMemorySchema),
    async (req, res) => {
      const event = await svc.getById(req.params.id as string);
      if (!event) throw notFound("Accepted work event not found");
      assertCompanyAccess(req, event.companyId);
      const actor = getActorInfo(req);
      const result = await svc.createMemoryFromEvent({
        eventId: event.id,
        ...acceptedWorkCreateMemorySchema.parse(req.body),
        createdBy: actor.actorId,
      });
      if (!result) throw notFound("Accepted work event not found");
      await logActivity(db, {
        companyId: event.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "accepted_work.memory_written",
        entityType: "accepted_work_event",
        entityId: event.id,
        details: { memoryEntryId: result.memory.id },
      });
      res.status(201).json(result);
    },
  );

  router.post(
    "/accepted-work/events/:id/resolve",
    validate(acceptedWorkResolveSchema),
    async (req, res) => {
      const existing = await svc.getById(req.params.id as string);
      if (!existing) throw notFound("Accepted work event not found");
      assertCompanyAccess(req, existing.companyId);
      const parsed = acceptedWorkResolveSchema.parse(req.body);
      const event = await svc.resolveEvent(existing.id, parsed.status, parsed.memoryEntryId ?? null);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: getActorInfo(req).actorType,
        actorId: getActorInfo(req).actorId,
        agentId: getActorInfo(req).agentId,
        action: "accepted_work.resolved",
        entityType: "accepted_work_event",
        entityId: existing.id,
        details: { status: parsed.status, memoryEntryId: parsed.memoryEntryId ?? null },
      });
      res.json(event);
    },
  );

  return router;
}
