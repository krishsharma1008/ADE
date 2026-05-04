import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@combyne/db";
import {
  qaArtifactCreateSchema,
  qaDeviceRegisterSchema,
  qaEnvironmentUpsertSchema,
  qaExportSchema,
  qaFeedbackApproveSchema,
  qaFeedbackSendSchema,
  qaLocalAndroidDiscoverySchema,
  qaSignoffSchema,
  qaTestCaseCreateSchema,
  qaTestResultCreateSchema,
  qaTestRunCreateSchema,
  qaTestRunUpdateSchema,
  qaTestSuiteCreateSchema,
} from "@combyne/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { qaService } from "../services/qa.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function assertAgentCanWriteRun(req: Request, run: { qaAgentId: string | null }) {
  if (req.actor.type !== "agent") return;
  if (run.qaAgentId && run.qaAgentId !== req.actor.agentId) {
    throw forbidden("QA run is assigned to another agent");
  }
}

export function qaRoutes(db: Db) {
  const router = Router();
  const svc = qaService(db);

  router.get("/companies/:companyId/qa/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.summary(companyId));
  });

  router.get("/companies/:companyId/qa/test-cases", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listCases(companyId));
  });

  router.post("/companies/:companyId/qa/test-cases", validate(qaTestCaseCreateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await svc.createCase(companyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: getActorInfo(req).actorType,
      actorId: getActorInfo(req).actorId,
      action: "qa.test_case.created",
      entityType: "qa_test_case",
      entityId: row.id,
      details: { title: row.title },
    });
    res.status(201).json(row);
  });

  router.get("/companies/:companyId/qa/suites", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listSuites(companyId));
  });

  router.post("/companies/:companyId/qa/suites", validate(qaTestSuiteCreateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await svc.createSuite(companyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: getActorInfo(req).actorType,
      actorId: getActorInfo(req).actorId,
      action: "qa.suite.created",
      entityType: "qa_test_suite",
      entityId: row.id,
      details: { name: row.name, runnerType: row.runnerType },
    });
    res.status(201).json(row);
  });

  router.get("/companies/:companyId/qa/environments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listEnvironments(companyId));
  });

  router.post("/companies/:companyId/qa/environments", validate(qaEnvironmentUpsertSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.status(201).json(await svc.createEnvironment(companyId, req.body));
  });

  router.get("/companies/:companyId/qa/devices", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listDevices(companyId));
  });

  router.post("/companies/:companyId/qa/devices/register", validate(qaDeviceRegisterSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await svc.registerDevice(companyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: getActorInfo(req).actorType,
      actorId: getActorInfo(req).actorId,
      action: "qa.device.registered",
      entityType: "qa_device",
      entityId: row.id,
      details: { workerId: row.workerId, name: row.name, healthStatus: row.healthStatus },
    });
    res.status(201).json(row);
  });

  router.post("/companies/:companyId/qa/devices/register-local-emulators", validate(qaLocalAndroidDiscoverySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.registerLocalAndroidEmulators(companyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: getActorInfo(req).actorType,
      actorId: getActorInfo(req).actorId,
      action: "qa.devices.local_emulators_discovered",
      entityType: "qa_device",
      entityId: result.registered[0]?.id ?? companyId,
      details: {
        registeredCount: result.registered.length,
        emulatorAvailable: result.diagnostics.emulatorAvailable,
        adbAvailable: result.diagnostics.adbAvailable,
        warnings: result.diagnostics.warnings,
      },
    });
    res.status(201).json(result);
  });

  router.get("/companies/:companyId/qa/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listRuns(companyId, { issueId: typeof req.query.issueId === "string" ? req.query.issueId : null }));
  });

  router.post("/companies/:companyId/qa/runs", validate(qaTestRunCreateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const row = await svc.createRun(companyId, req.body, { agentId: actor.agentId, runId: actor.runId });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "qa.run.created",
      entityType: "qa_test_run",
      entityId: row.id,
      details: { title: row.title, runnerType: row.runnerType, issueId: row.issueId },
    });
    res.status(201).json(row);
  });

  router.get("/qa/runs/:runId", async (req, res) => {
    const detail = await svc.getRunDetail(req.params.runId as string);
    assertCompanyAccess(req, detail.run.companyId);
    res.json(detail);
  });

  router.patch("/qa/runs/:runId", validate(qaTestRunUpdateSchema), async (req, res) => {
    const run = await svc.getRunDetail(req.params.runId as string).then((d) => d.run);
    assertCompanyAccess(req, run.companyId);
    assertAgentCanWriteRun(req, run);
    const updated = await svc.updateRun(run.id, req.body);
    res.json(updated);
  });

  router.post("/qa/runs/:runId/results", validate(qaTestResultCreateSchema), async (req, res) => {
    const run = await svc.getRunDetail(req.params.runId as string).then((d) => d.run);
    assertCompanyAccess(req, run.companyId);
    assertAgentCanWriteRun(req, run);
    res.status(201).json(await svc.addResult(run.id, req.body));
  });

  router.post("/qa/runs/:runId/results/junit", async (req, res) => {
    const run = await svc.getRunDetail(req.params.runId as string).then((d) => d.run);
    assertCompanyAccess(req, run.companyId);
    assertAgentCanWriteRun(req, run);
    if (typeof req.body?.xml !== "string" || req.body.xml.trim().length === 0) {
      throw badRequest("xml is required");
    }
    res.status(201).json(await svc.addResultsFromJUnit(run.id, req.body.xml));
  });

  router.post("/qa/runs/:runId/artifacts", validate(qaArtifactCreateSchema), async (req, res) => {
    const run = await svc.getRunDetail(req.params.runId as string).then((d) => d.run);
    assertCompanyAccess(req, run.companyId);
    assertAgentCanWriteRun(req, run);
    res.status(201).json(await svc.addArtifact(run.id, req.body));
  });

  router.post("/qa/runs/:runId/sync-github-ci", async (req, res) => {
    const run = await svc.getRunDetail(req.params.runId as string).then((d) => d.run);
    assertCompanyAccess(req, run.companyId);
    res.json(await svc.syncGitHubCi(run.id));
  });

  router.post("/qa/runs/:runId/feedback/send", validate(qaFeedbackSendSchema), async (req, res) => {
    const detail = await svc.getRunDetail(req.params.runId as string);
    assertCompanyAccess(req, detail.run.companyId);
    const actor = getActorInfo(req);
    const feedback = await svc.createFeedbackForRun(detail.run.id, req.body, {
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      agentId: actor.agentId,
    });
    await logActivity(db, {
      companyId: detail.run.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "qa.feedback.submitted_for_approval",
      entityType: "qa_feedback_event",
      entityId: feedback.id,
      details: {
        qaRunId: detail.run.id,
        issueId: detail.run.issueId,
        toAgentId: feedback.toAgentId,
        status: feedback.status,
        developerVisible: false,
      },
    });
    res.json(feedback);
  });

  router.post("/qa/feedback/:feedbackId/approve", validate(qaFeedbackApproveSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getFeedback(req.params.feedbackId as string);
    if (!existing) {
      res.status(404).json({ error: "QA feedback not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const feedback = await svc.approveFeedbackForDevelopers(existing.id, {
      userId: req.actor.userId ?? "board",
      note: req.body.note,
    });
    await logActivity(db, {
      companyId: feedback.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "qa.feedback.approved_for_dev",
      entityType: "qa_feedback_event",
      entityId: feedback.id,
      details: {
        qaRunId: feedback.runId,
        issueId: feedback.issueId,
        toAgentId: feedback.toAgentId,
        bugIssueId: feedback.bugIssueId,
      },
    });
    res.json(feedback);
  });

  router.post("/qa/runs/:runId/signoff", validate(qaSignoffSchema), async (req, res) => {
    assertBoard(req);
    const detail = await svc.getRunDetail(req.params.runId as string);
    assertCompanyAccess(req, detail.run.companyId);
    res.json(await svc.signoff(detail.run.id, {
      status: req.body.status,
      note: req.body.note,
      userId: req.actor.userId ?? "board",
    }));
  });

  router.post("/qa/runs/:runId/export", validate(qaExportSchema), async (req, res) => {
    assertBoard(req);
    const detail = await svc.getRunDetail(req.params.runId as string);
    assertCompanyAccess(req, detail.run.companyId);
    const result = await svc.exportRun(detail.run.id, req.body);
    await logActivity(db, {
      companyId: detail.run.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "qa.report.exported",
      entityType: "qa_test_run",
      entityId: detail.run.id,
      details: { format: req.body.format, jiraIssue: result.jiraIssue ?? null },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/qa/feedback", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listFeedback(companyId));
  });

  return router;
}
