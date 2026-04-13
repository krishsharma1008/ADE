import { Router } from "express";
import type { Db } from "@combyne/db";
import { issuePlanService, issueService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function issuePlanRoutes(db: Db) {
  const router = Router();
  const planSvc = issuePlanService(db);
  const issueSvc = issueService(db);

  // GET /issues/:issueId/plan — Get the latest plan for an issue
  router.get("/issues/:issueId/plan", async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const plan = await planSvc.getPlan(issueId);
    if (!plan) {
      res.status(404).json({ error: "No plan found for this issue" });
      return;
    }
    res.json(plan);
  });

  // POST /issues/:issueId/plan — Create or update a plan
  router.post("/issues/:issueId/plan", async (req, res) => {
    const issueId = req.params.issueId as string;
    const { content } = req.body;

    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const actor = getActorInfo(req);
    const existing = await planSvc.getPlan(issueId);

    let plan;
    if (existing) {
      plan = await planSvc.updatePlan(existing.id, content);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "issue_plan.updated",
        entityType: "issue_plan",
        entityId: plan.id,
        details: { issueId, version: plan.version },
      });
    } else {
      plan = await planSvc.createPlan({
        issueId,
        companyId: issue.companyId,
        content,
        authorAgentId: actor.actorType === "agent" ? actor.actorId : null,
        authorUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "issue_plan.created",
        entityType: "issue_plan",
        entityId: plan.id,
        details: { issueId },
      });
    }

    res.status(existing ? 200 : 201).json(plan);
  });

  // POST /issues/:issueId/plan/submit — Submit plan for approval
  router.post("/issues/:issueId/plan/submit", async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const existing = await planSvc.getPlan(issueId);
    if (!existing) {
      res.status(404).json({ error: "No plan found for this issue" });
      return;
    }

    const plan = await planSvc.submitForApproval(existing.id);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "issue_plan.submitted",
      entityType: "issue_plan",
      entityId: plan.id,
      details: { issueId, approvalId: plan.approvalId },
    });

    res.json(plan);
  });

  // POST /issues/:issueId/plan/approve — Board approves the plan
  router.post("/issues/:issueId/plan/approve", async (req, res) => {
    assertBoard(req);
    const issueId = req.params.issueId as string;
    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const existing = await planSvc.getPlan(issueId);
    if (!existing) {
      res.status(404).json({ error: "No plan found for this issue" });
      return;
    }

    const decidedByUserId = req.actor.userId ?? "board";
    const plan = await planSvc.approvePlan(existing.id, decidedByUserId);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: decidedByUserId,
      action: "issue_plan.approved",
      entityType: "issue_plan",
      entityId: plan.id,
      details: { issueId },
    });

    res.json(plan);
  });

  // POST /issues/:issueId/plan/reject — Board rejects the plan
  router.post("/issues/:issueId/plan/reject", async (req, res) => {
    assertBoard(req);
    const issueId = req.params.issueId as string;
    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const existing = await planSvc.getPlan(issueId);
    if (!existing) {
      res.status(404).json({ error: "No plan found for this issue" });
      return;
    }

    const decidedByUserId = req.actor.userId ?? "board";
    const note = req.body.note ?? req.body.decisionNote ?? null;
    const plan = await planSvc.rejectPlan(existing.id, decidedByUserId, note);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: decidedByUserId,
      action: "issue_plan.rejected",
      entityType: "issue_plan",
      entityId: plan.id,
      details: { issueId, note },
    });

    res.json(plan);
  });

  // GET /companies/:companyId/plans — List all plans for a company
  router.get("/companies/:companyId/plans", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const plans = await planSvc.listPlans(companyId, status ? { status } : undefined);
    res.json(plans);
  });

  return router;
}
