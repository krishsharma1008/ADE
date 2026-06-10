import { Router } from "express";
import type { Db } from "@combyne/db";
import { agentWakeupRequests, issues } from "@combyne/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  updateCompanySchema,
} from "@combyne/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, companyPortabilityService, companyService, heartbeatService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function companyRoutes(db: Db) {
  const router = Router();
  const svc = companyService(db);
  const portability = companyPortabilityService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/:companyId/exports/preview", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const preview = await portability.previewExport(companyId, req.body);
    res.json(preview);
  });

  router.post("/:companyId/exports", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      assertCompanyAccess(req, req.body.target.companyId);
    } else {
      assertBoard(req);
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      assertCompanyAccess(req, req.body.target.companyId);
    } else {
      assertBoard(req);
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null);
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const company = await svc.create(req.body);
    await access.ensureMembership(company.id, "user", req.actor.userId ?? "local-board", "owner", "active");
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    res.status(201).json(company);
  });

  router.patch("/:companyId", validate(updateCompanySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const archiveRequested = req.body.status === "archived";
    const pauseRequested = req.body.status === "paused";
    const resumeRequested = req.body.status === "active";
    let company;
    if (archiveRequested) {
      company = await svc.archive(companyId);
    } else if (pauseRequested) {
      company = await svc.pause(companyId);
    } else if (resumeRequested) {
      company = await svc.resume(companyId);
    } else {
      company = await svc.update(companyId, req.body);
    }
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const shutdown = archiveRequested
      ? await heartbeat.cancelActiveForCompany(companyId, "Cancelled because company was archived")
      : pauseRequested
        ? await heartbeat.cancelActiveForCompany(companyId, "Cancelled because company was paused")
        : null;
    const action = archiveRequested
      ? "company.archived"
      : pauseRequested
        ? "company.paused"
        : resumeRequested
          ? "company.resumed"
          : "company.updated";
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action,
      entityType: "company",
      entityId: companyId,
      details: shutdown ? { ...req.body, ...shutdown } : req.body,
    });
    res.json(company);
  });

  router.post("/:companyId/pause", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.pause(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const shutdown = await heartbeat.cancelActiveForCompany(
      companyId,
      "Cancelled because company was paused",
    );
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.paused",
      entityType: "company",
      entityId: companyId,
      details: shutdown,
    });
    res.json(company);
  });

  router.post("/:companyId/resume", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.resume(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.resumed",
      entityType: "company",
      entityId: companyId,
    });

    // Audit A1 (e2e-run-2026-06-10): wakes attempted while the COMPANY was paused
    // were persisted as skipped (company.*) and then lost — resume re-delivers one
    // queue-rescan wake per agent that either missed a wake or has open assigned
    // work, mirroring the agent-resume re-scan.
    try {
      const consumed = await db
        .update(agentWakeupRequests)
        .set({ reason: sql`'redelivered.' || ${agentWakeupRequests.reason}` })
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, "skipped"),
            like(agentWakeupRequests.reason, "company.%"),
          ),
        )
        .returning({ agentId: agentWakeupRequests.agentId });
      const missedAgentIds = new Set(consumed.map((row) => row.agentId));
      const assigned = await db
        .selectDistinct({ agentId: issues.assigneeAgentId })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["todo", "in_progress"]),
          ),
        );
      for (const row of assigned) {
        if (row.agentId) missedAgentIds.add(row.agentId);
      }
      for (const agentId of missedAgentIds) {
        await heartbeat
          .wakeup(agentId, {
            source: "on_demand",
            reason: "company_resumed_rescan",
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
          })
          .catch((err) => logger.debug({ err, agentId }, "company resume rescan wake failed"));
      }
    } catch (err) {
      logger.warn({ err, companyId }, "company resume rescan failed");
    }

    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const shutdown = await heartbeat.cancelActiveForCompany(
      companyId,
      "Cancelled because company was archived",
    );
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
      details: shutdown,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
