import { Router } from "express";
import type { Db } from "@combyne/db";
import { and, eq, sql } from "drizzle-orm";
import { joinRequests } from "@combyne/db";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { issueService } from "../services/issues.js";
import { accessService } from "../services/access.js";
import { dashboardService } from "../services/dashboard.js";
import { memoryService } from "../services/memory.js";
import { assertCompanyAccess } from "./authz.js";

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const svc = sidebarBadgeService(db);
  const issueSvc = issueService(db);
  const access = accessService(db);
  const dashboard = dashboardService(db);
  const memory = memoryService(db);

  router.get("/companies/:companyId/sidebar-badges", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    let canApproveJoins = false;
    if (req.actor.type === "board") {
      canApproveJoins =
        req.actor.source === "local_implicit" ||
        Boolean(req.actor.isInstanceAdmin) ||
        (await access.canUser(companyId, req.actor.userId, "joins:approve"));
    } else if (req.actor.type === "agent" && req.actor.agentId) {
      canApproveJoins = await access.hasPermission(companyId, "agent", req.actor.agentId, "joins:approve");
    }

    const joinRequestCount = canApproveJoins
      ? await db
        .select({ count: sql<number>`count(*)` })
        .from(joinRequests)
        .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
        .then((rows) => Number(rows[0]?.count ?? 0))
      : 0;

    // Memory pending depth = capture inbox + verify queue + detected conflicts
    // (PR-14). Best-effort: a memory-store hiccup must never break the sidebar.
    let memoryPending = 0;
    try {
      const [captures, verify, conflicts] = await Promise.all([
        memory.captureInbox(companyId),
        memory.verifyQueue(companyId),
        memory.listConflicts(companyId),
      ]);
      memoryPending = captures.length + verify.length + conflicts.length;
    } catch {
      memoryPending = 0;
    }

    const badges = await svc.get(companyId, {
      joinRequests: joinRequestCount,
      memory: memoryPending,
    });
    const summary = await dashboard.summary(companyId);
    const staleIssueCount = await issueSvc.staleCount(companyId, 24 * 60);
    const hasFailedRuns = badges.failedRuns > 0;
    const alertsCount =
      (summary.agents.error > 0 && !hasFailedRuns ? 1 : 0) +
      (summary.costs.monthBudgetCents > 0 && summary.costs.monthUtilizationPercent >= 80 ? 1 : 0);
    badges.inbox =
      badges.failedRuns +
      alertsCount +
      staleIssueCount +
      joinRequestCount +
      badges.approvals +
      // F10: issues parked on a human answer belong in the inbox count — the
      // route recomputes the sum, so it must include the service's awaitingUser.
      (badges.awaitingUser ?? 0);

    res.json(badges);
  });

  return router;
}
