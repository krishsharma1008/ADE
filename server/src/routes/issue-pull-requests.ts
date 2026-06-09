import { Router } from "express";
import type { Db } from "@combyne/db";
import { acceptedWorkEvents, issues } from "@combyne/db";
import {
  issuePullRequestFeedbackOptInSchema,
  issuePullRequestMergeSchema,
  issuePullRequestUpsertSchema,
} from "@combyne/shared";
import { and, eq, isNull } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { acceptedWorkService, heartbeatService, issuePullRequestService, logActivity } from "../services/index.js";

export function issuePullRequestRoutes(db: Db) {
  const router = Router();
  const svc = issuePullRequestService(db);
  const heartbeat = heartbeatService(db);
  const acceptedWork = acceptedWorkService(db);

  async function getIssueByIdOrIdentifier(rawIssueId: string) {
    if (/^[A-Z0-9]+-\d+$/i.test(rawIssueId)) {
      const byIdentifier = await db
        .select()
        .from(issues)
        .where(eq(issues.identifier, rawIssueId.toUpperCase()))
        .then((rows) => rows[0] ?? null);
      if (byIdentifier) return byIdentifier;
    }
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, rawIssueId))
      .then((rows) => rows[0] ?? null);
  }

  async function wakeAcceptedWorkManager(event: { id: string; managerAgentId: string | null }) {
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
    await acceptedWork.markWakeRequested(event.id);
  }

  router.get("/issues/:issueId/pull-requests", async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await getIssueByIdOrIdentifier(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    res.json(await svc.listForIssue(issue.id));
  });

  router.post("/issues/:issueId/pull-requests", validate(issuePullRequestUpsertSchema), async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await getIssueByIdOrIdentifier(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const row = await svc.upsertForIssue({
      companyId: issue.companyId,
      issueId: issue.id,
      requestedByAgentId: actor.agentId,
      ...req.body,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue_pr.tracked",
      entityType: "issue",
      entityId: issue.id,
      details: { repo: req.body.repo, pullNumber: req.body.pullNumber, approvalId: row.approvalId },
    });
    res.status(201).json(row);
  });

  router.post("/issue-pull-requests/:id/reconcile", async (req, res) => {
    const id = req.params.id as string;
    const row = await svc.getById(id);
    if (!row) {
      res.status(404).json({ error: "Pull request tracking record not found" });
      return;
    }
    assertCompanyAccess(req, row.companyId);
    res.json(await svc.dispatchFeedbackToAssignee(id, {
      requestedByActorType: "system",
      requestedByActorId: "issue-pr-reconcile",
    }));
  });

  router.post("/issue-pull-requests/:id/wake-feedback", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const row = await svc.getById(id);
    if (!row) {
      res.status(404).json({ error: "Pull request tracking record not found" });
      return;
    }
    assertCompanyAccess(req, row.companyId);
    const actor = getActorInfo(req);
    // Board-initiated manual wake = one-shot release of the held feedback (same as the
    // PR panel's "Let agents fix"), so it isn't a no-op while the PR is human-held.
    const result = await svc.dispatchFeedbackToAssignee(id, {
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
      forceWake: true,
    });
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "issue_pr.feedback_wakeup",
      entityType: "issue_pull_request",
      entityId: row.id,
      details: { issueId: row.issueId, sent: result.sent, wakeRunId: result.wakeRunId },
    });
    res.json(result);
  });

  router.post(
    "/issue-pull-requests/:id/feedback-opt-in",
    validate(issuePullRequestFeedbackOptInSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const row = await svc.getById(id);
      if (!row) {
        res.status(404).json({ error: "Pull request tracking record not found" });
        return;
      }
      assertCompanyAccess(req, row.companyId);
      const actor = getActorInfo(req);
      const result = await svc.setFeedbackOptIn(id, req.body.enabled, {
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
      await logActivity(db, {
        companyId: row.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: req.body.enabled ? "issue_pr.feedback_opt_in" : "issue_pr.feedback_hold",
        entityType: "issue_pull_request",
        entityId: row.id,
        details: {
          issueId: row.issueId,
          enabled: req.body.enabled,
          wakeRunId: result.dispatched?.wakeRunId ?? null,
          held: result.dispatched?.held ?? null,
        },
      });
      res.json(result);
    },
  );

  router.post("/issue-pull-requests/:id/merge", validate(issuePullRequestMergeSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const row = await svc.getById(id);
    if (!row) {
      res.status(404).json({ error: "Pull request tracking record not found" });
      return;
    }
    assertCompanyAccess(req, row.companyId);
    const actor = getActorInfo(req);
    const result = await svc.merge(id, {
      approvalId: req.body.approvalId,
      expectedHeadSha: req.body.expectedHeadSha,
      mergeMethod: req.body.mergeMethod,
      decisionNote: req.body.decisionNote,
      decidedByUserId: actor.actorId,
    });
    const pr = result.githubPullRequest;
    const accepted = await acceptedWork.upsertMergedPull({
      companyId: row.companyId,
      issueId: row.issueId,
      repo: row.repo,
      pullNumber: row.pullNumber,
      pullUrl: pr.htmlUrl,
      title: pr.title,
      body: pr.body,
      headBranch: pr.headBranch,
      mergedSha: pr.mergeCommitSha ?? result.mergeResult.sha ?? null,
      mergedAt: pr.mergedAt ?? new Date().toISOString(),
      detectionSource: "dashboard_merge",
      metadata: { githubUser: pr.user, baseBranch: pr.baseBranch, issuePullRequestId: row.id },
    });
    if (accepted.shouldWakeManager) await wakeAcceptedWorkManager(accepted.event);
    // HOOK 2 link-back (§4.2): if the EM merge captured a verified pr-approval memory
    // entry, link it onto the accepted-work event when nothing else has claimed it
    // yet. Leaves memoryStatus 'pending' so the agent-driven createMemoryFromEvent
    // path still runs (and may later overwrite with its own agent-claim entry); the
    // isNull guard keeps this idempotent on re-fire.
    if (result.approvalMemoryEntryId) {
      await db
        .update(acceptedWorkEvents)
        .set({ memoryEntryId: result.approvalMemoryEntryId, updatedAt: new Date() })
        .where(
          and(
            eq(acceptedWorkEvents.id, accepted.event.id),
            isNull(acceptedWorkEvents.memoryEntryId),
          ),
        );
    }
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "github.pr.merged",
      entityType: "issue_pull_request",
      entityId: row.id,
      details: {
        repo: row.repo,
        pullNumber: row.pullNumber,
        issueId: row.issueId,
        approvalId: row.approvalId,
        source: "dashboard_merge",
      },
    });
    res.json(result);
  });

  return router;
}
