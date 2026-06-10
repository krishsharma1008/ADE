import { createHash } from "node:crypto";
import { and, asc, eq, ne, notInArray } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { approvals, issueApprovals, issueComments, issuePullRequests, issues, projectWorkspaces } from "@combyne/db";
import type {
  GitHubCheckRun,
  GitHubConfig,
  GitHubPRReview,
  IssuePullRequestStatus,
  SonarQubeConfig,
  SonarQubeQualityGate,
} from "@combyne/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { createGitHubClient } from "./github.js";
import { integrationService } from "./integrations.js";
import { createSonarQubeClient } from "./sonarqube.js";
import { issueService } from "./issues.js";
import { approvalService } from "./approvals.js";
import { heartbeatService } from "./heartbeat.js";
import { acceptedWorkService } from "./accepted-work.js";
import type { CreateEntryInput } from "./memory.js";
import { captureHumanMemoryDurable, prApprovalSource } from "./memory-capture.js";
import { parseRemoteSlug } from "./push-remote-allowlist.js";
import { contextTrace } from "./context-trace.js"; // CONTEXT-TRACE
import { logger } from "../middleware/logger.js";

const PASSING_CHECK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const DEFAULT_MERGE_BASE_BRANCHES = ["main", "master", "development", "develop"];
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
const PR_FEEDBACK_RECONCILE_INTERVAL_MS =
  Number(process.env.COMBYNE_PR_FEEDBACK_RECONCILE_INTERVAL_MS) || 2 * 60 * 1000;
const prFeedbackReconcileThrottle = new Map<string, number>();

// Default behavior holds review feedback for a human: agents are NOT auto-woken to
// rewrite the source when a reviewer requests changes. A board member releases it one
// round at a time via the PR panel ("Let agents fix" -> setFeedbackOptIn). Set
// COMBYNE_PR_FEEDBACK_AUTOPILOT=true to restore the legacy fully-autonomous loop.
function prFeedbackAutopilotEnabled(): boolean {
  return String(process.env.COMBYNE_PR_FEEDBACK_AUTOPILOT ?? "").trim().toLowerCase() === "true";
}

// In autopilot mode, cap how many consecutive fix cycles agents may auto-run before
// re-holding for a human. Prevents an unbounded review <-> fix ping-pong. (In the
// default human-gated mode each round requires an explicit human click, so the cap is
// not consulted.)
const PR_FEEDBACK_MAX_AUTO_ROUNDS = Math.max(
  0,
  Number(process.env.COMBYNE_PR_FEEDBACK_MAX_ROUNDS) || 3,
);

type FeedbackHoldReason = "awaiting_human_optin" | "max_rounds_reached";

type FeedbackGate =
  | { allowed: true; rounds: number }
  | { allowed: false; reason: FeedbackHoldReason; rounds: number };

// Gate for the AUTOMATIC (poll-driven) dispatch path only. Human-forced releases
// (forceWake) bypass this entirely — see dispatchFeedbackToAssignee. By default this
// always holds; only autopilot mode auto-allows (bounded by the round cap).
function resolveFeedbackGate(metadata: Record<string, unknown> | null | undefined): FeedbackGate {
  const rounds = Number(metadata?.feedbackRounds ?? 0) || 0;
  if (!prFeedbackAutopilotEnabled()) {
    return { allowed: false, reason: "awaiting_human_optin", rounds };
  }
  if (PR_FEEDBACK_MAX_AUTO_ROUNDS > 0 && rounds >= PR_FEEDBACK_MAX_AUTO_ROUNDS) {
    return { allowed: false, reason: "max_rounds_reached", rounds };
  }
  return { allowed: true, rounds };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function now() {
  return new Date();
}

function mergeBaseAllowlist() {
  const raw = process.env.COMBYNE_GITHUB_MERGE_BASE_BRANCHES;
  if (!raw) return DEFAULT_MERGE_BASE_BRANCHES;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function statusFromChecks(checks: GitHubCheckRun[]): "unknown" | "pending" | "passed" | "failed" {
  if (checks.length === 0) return "unknown";
  if (checks.some((check) => check.status !== "completed")) return "pending";
  if (checks.some((check) => !PASSING_CHECK_CONCLUSIONS.has(String(check.conclusion ?? "").toLowerCase()))) {
    return "failed";
  }
  return "passed";
}

function statusFromReviews(reviews: GitHubPRReview[]): "unknown" | "clean" | "changes_requested" {
  if (reviews.length === 0) return "clean";
  const latestByUser = new Map<string, string>();
  for (const review of reviews) {
    latestByUser.set(review.user, review.state.toUpperCase());
  }
  for (const state of latestByUser.values()) {
    if (state === "CHANGES_REQUESTED") return "changes_requested";
  }
  return "clean";
}

function statusFromQualityGate(gate: SonarQubeQualityGate | null): "not_configured" | "unknown" | "pending" | "passed" | "failed" {
  if (!gate) return "not_configured";
  const status = gate.status.toUpperCase();
  if (status === "OK") return "passed";
  if (status === "ERROR") return "failed";
  if (status === "IN_PROGRESS" || status === "PENDING") return "pending";
  return "unknown";
}

function feedbackHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeMergeMethod(value: string | null | undefined): "merge" | "squash" | "rebase" {
  return MERGE_METHODS.has(value ?? "") ? (value as "merge" | "squash" | "rebase") : "squash";
}

function buildFeedback(input: {
  repo: string;
  pullNumber: number;
  checks: GitHubCheckRun[];
  reviews: GitHubPRReview[];
  qualityGate: SonarQubeQualityGate | null;
  blockers: string[];
}) {
  const lines: string[] = [];
  lines.push(`PR feedback for \`${input.repo}#${input.pullNumber}\`:`);
  if (input.blockers.length > 0) {
    lines.push("", "Blocking items:");
    for (const blocker of input.blockers) lines.push(`- ${blocker}`);
  }
  const failingChecks = input.checks.filter((check) => {
    if (check.status !== "completed") return true;
    return !PASSING_CHECK_CONCLUSIONS.has(String(check.conclusion ?? "").toLowerCase());
  });
  if (failingChecks.length > 0) {
    lines.push("", "Checks to address:");
    for (const check of failingChecks.slice(0, 10)) {
      lines.push(`- ${check.name}: ${check.status}${check.conclusion ? `/${check.conclusion}` : ""}`);
    }
  }
  const changeReviews = input.reviews.filter((review) => review.state.toUpperCase() === "CHANGES_REQUESTED");
  if (changeReviews.length > 0) {
    lines.push("", "Review feedback:");
    for (const review of changeReviews.slice(-5)) {
      lines.push(`- ${review.user}: ${review.body?.trim() || "Changes requested"}`);
    }
  }
  if (input.qualityGate && input.qualityGate.status.toUpperCase() !== "OK") {
    lines.push("", `Quality gate: ${input.qualityGate.status}`);
    for (const condition of input.qualityGate.conditions.slice(0, 8)) {
      if (condition.status.toUpperCase() !== "OK") {
        lines.push(`- ${condition.metric}: ${condition.value} (threshold ${condition.errorThreshold})`);
      }
    }
  }
  return lines.join("\n");
}

function blockersFor(input: {
  state: string;
  draft: boolean;
  baseBranch: string;
  /** Resolved per-repo allowlist; falls back to the static/env list when absent. */
  allowedMergeBases?: ReadonlySet<string>;
  headSha: string | null;
  expectedHeadSha: string | null;
  ciStatus: string;
  reviewStatus: string;
  qualityStatus: string;
}) {
  const blockers: string[] = [];
  if (input.state !== "open") blockers.push(`PR is not open (${input.state})`);
  if (input.draft) blockers.push("PR is still a draft");
  const allowedBases = input.allowedMergeBases ?? new Set(mergeBaseAllowlist());
  if (!allowedBases.has(input.baseBranch)) blockers.push(`Base branch \`${input.baseBranch}\` is not merge-allowed`);
  if (!input.headSha) blockers.push("PR head SHA is unknown");
  if (input.expectedHeadSha && input.headSha && input.expectedHeadSha !== input.headSha) {
    blockers.push("PR head changed since merge approval was prepared");
  }
  // "unknown" means the repo reported ZERO check runs (statusFromChecks) — i.e. no CI
  // is configured at all, common on mirrors/small repos. By default that still blocks;
  // operators can opt out so CI-less repos remain dashboard-mergeable.
  const allowUnknownCi =
    String(process.env.COMBYNE_GITHUB_MERGE_ALLOW_UNKNOWN_CI ?? "").trim().toLowerCase() === "true";
  if (input.ciStatus !== "passed" && !(allowUnknownCi && input.ciStatus === "unknown")) {
    blockers.push(`CI checks are ${input.ciStatus}`);
  }
  if (input.reviewStatus === "changes_requested") blockers.push("Review changes are still requested");
  if (input.qualityStatus !== "not_configured" && input.qualityStatus !== "passed") {
    blockers.push(`Quality gate is ${input.qualityStatus}`);
  }
  return blockers;
}

export function issuePullRequestService(db: Db) {
  const integrations = integrationService(db);
  const issuesSvc = issueService(db);
  const approvalsSvc = approvalService(db);
  const acceptedWorkSvc = acceptedWorkService(db);

  // Shared accepted-work upsert + manager wake for an externally-observed merge.
  // Mirrors the in-app merge route's wakeAcceptedWorkManager (routes/issue-pull-requests.ts)
  // but is callable from reconcile() so the EM is woken on a GitHub-direct merge even when
  // heartbeats are OFF (manual wake) — the heartbeat-coupled poller never runs in that mode.
  // resolveManager prefers the PARENT issue's assignee (the EM), so the wake carries a
  // merged-PR brief to the coordinator. Best-effort: a wake failure must never fail reconcile.
  async function recordExternalMergeAcceptedWork(
    row: typeof issuePullRequests.$inferSelect,
    pr: { title: string; body?: string | null; headBranch?: string | null; mergeCommitSha?: string | null; mergedAt?: string | null; htmlUrl?: string | null; user?: string | null; baseBranch?: string | null },
  ): Promise<void> {
    try {
      const accepted = await acceptedWorkSvc.upsertMergedPull({
        companyId: row.companyId,
        issueId: row.issueId,
        repo: row.repo,
        pullNumber: row.pullNumber,
        pullUrl: pr.htmlUrl ?? row.pullUrl,
        title: pr.title ?? row.title,
        body: pr.body ?? null,
        headBranch: pr.headBranch ?? row.headBranch ?? null,
        mergedSha: pr.mergeCommitSha ?? row.mergeCommitSha ?? null,
        mergedAt: pr.mergedAt ?? new Date().toISOString(),
        // Distinguish the reconcile-observed external merge from the in-app dashboard merge.
        detectionSource: "github_reconcile",
        metadata: { githubUser: pr.user ?? null, baseBranch: pr.baseBranch ?? row.baseBranch ?? null, issuePullRequestId: row.id },
      });
      // shouldWakeManager is guarded by upsertMergedPull on (memoryStatus pending,
      // managerAgentId present, no prior wakeupRequestedAt) — idempotent against the
      // dashboard-merge path and the heartbeat poller, so a double-fire is safe.
      if (accepted.shouldWakeManager && accepted.event.managerAgentId) {
        await heartbeatService(db).wakeup(accepted.event.managerAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "accepted_work_merged_pr",
          payload: { acceptedWorkEventId: accepted.event.id },
          requestedByActorType: "system",
          requestedByActorId: "accepted-work",
          contextSnapshot: { acceptedWorkEventId: accepted.event.id, source: "accepted_work.merged_pr" },
        });
        await acceptedWorkSvc.markWakeRequested(accepted.event.id);
      }
    } catch (err) {
      // A wake/accepted-work failure must never fail the reconcile/poll.
      logger.debug({ err, issuePullRequestId: row.id }, "issue_pr.external_merge_wake_failed");
    }
  }

  // Close-out parity with the in-app merge() path for an externally-observed merge:
  // transition the tracked issue to "done" (which fires notifyParentOnChildStatus ->
  // wakes the parent coordinator/EM) and wake the EM via the accepted-work manager-wake.
  // DESIGN BOUNDARY: this CLOSES the child and INFORMS the EM — it deliberately does NOT
  // auto-start the next phase. Next-phase initiation vs. asking the human is a judgment
  // call the codebase intentionally leaves to the woken coordinator (e.g. PINB405 phases
  // 2-3 are gated on an open FE-readiness question), so auto-advancing here would be wrong.
  // Best-effort throughout: a delegation-policy rejection or wake failure must never fail
  // the caller (reconcile/poll/sweep).
  async function closeMergedTrackedIssue(
    row: typeof issuePullRequests.$inferSelect,
    pr: { title: string; body?: string | null; headBranch?: string | null; mergeCommitSha?: string | null; mergedAt?: string | null; htmlUrl?: string | null; user?: string | null; baseBranch?: string | null },
  ): Promise<void> {
    // Audit B3 (e2e-run-2026-06-10): when MULTIPLE PRs are tracked for one issue,
    // the first merge must not close the issue while a sibling PR is still open —
    // the dashboard would show "done" with review work outstanding. Resolve THIS
    // PR's approvals, comment, and let the LAST merge close the issue.
    const [openSibling] = await db
      .select({ id: issuePullRequests.id, pullNumber: issuePullRequests.pullNumber })
      .from(issuePullRequests)
      .where(
        and(
          eq(issuePullRequests.issueId, row.issueId),
          ne(issuePullRequests.id, row.id),
          notInArray(issuePullRequests.mergeStatus, ["merged", "closed"]),
        ),
      )
      .limit(1);
    if (openSibling) {
      if (row.approvalId) {
        await approvalsSvc
          .approve(row.approvalId, "issue-pr-reconcile", "PR merged on GitHub")
          .catch((err) =>
            logger.debug({ err, approvalId: row.approvalId }, "issue_pr.sibling_merge_approval_resolve_skipped"),
          );
      }
      await db
        .insert(issueComments)
        .values({
          companyId: row.companyId,
          issueId: row.issueId,
          authorAgentId: null,
          authorUserId: null,
          body:
            `PR ${row.repo}#${row.pullNumber} merged — issue stays open because tracked PR ` +
            `#${openSibling.pullNumber} is still pending. The last merge closes this issue.`,
          kind: "system",
        })
        .catch(() => {});
      return;
    }
    await issuesSvc
      .update(
        row.issueId,
        { status: "done" },
        { parentNotificationActor: { actorType: "system", actorId: "issue-pr-reconcile" } },
      )
      .catch((err) => {
        logger.debug({ err, issueId: row.issueId }, "issue_pr.external_merge_close_failed");
        return null;
      });
    await recordExternalMergeAcceptedWork(row, pr);
    // Resolve the merge approval so the inbox stops showing it under "needing action".
    // The in-app merge() path already does this (approvalsSvc.approve at the PR panel),
    // but an EXTERNAL GitHub merge detected by reconcile previously left the approval in
    // pending/revision_requested — so the card lingered after the PR was already merged
    // (the inbox counts revision_requested as actionable, ui Approvals.tsx). The merge is
    // the final decision, so mark it approved. Best-effort + idempotent: approve() no-ops
    // (throws, swallowed here) on an already-terminal approval, so a re-reconcile is safe.
    if (row.approvalId) {
      await approvalsSvc
        .approve(row.approvalId, "issue-pr-reconcile", "PR merged on GitHub")
        .catch((err) =>
          logger.debug({ err, approvalId: row.approvalId }, "issue_pr.external_merge_approval_resolve_skipped"),
        );
    }
    // F14 (e2e-run-2026-06-10 #14): older tracking rows (or re-tracked PRs) can have
    // dangling merge_pr approvals that are NOT row.approvalId — batch-resolve every
    // still-actionable merge_pr approval linked to this issue so the "PR ready —
    // open & merge" cards can't outlive the merge. Idempotent: approve() rejects
    // already-terminal approvals and we swallow per-row.
    await resolveDanglingMergeApprovalsForIssue(row.companyId, row.issueId);
  }

  async function resolveDanglingMergeApprovalsForIssue(companyId: string, issueId: string) {
    try {
      const linked = await db
        .select({ id: approvals.id, status: approvals.status, type: approvals.type })
        .from(issueApprovals)
        .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
        .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.companyId, companyId)));
      for (const approval of linked) {
        if (approval.type !== "merge_pr") continue;
        if (approval.status !== "pending" && approval.status !== "revision_requested") continue;
        await approvalsSvc
          .approve(approval.id, "issue-pr-reconcile", "Auto-resolved: PR merged")
          .catch((err) =>
            logger.debug({ err, approvalId: approval.id }, "issue_pr.dangling_merge_approval_resolve_skipped"),
          );
      }
    } catch (err) {
      logger.debug({ err, issueId }, "issue_pr.dangling_merge_approval_scan_failed");
    }
  }

  async function requireGitHubConfig(companyId: string): Promise<GitHubConfig> {
    const row = await integrations.getByProvider(companyId, "github");
    if (!row || row.enabled !== "true") throw notFound("GitHub integration is not configured or is disabled");
    return row.config as unknown as GitHubConfig;
  }

  async function loadSonarQubeConfig(companyId: string): Promise<SonarQubeConfig | null> {
    const row = await integrations.getByProvider(companyId, "sonarqube");
    if (!row || row.enabled !== "true") return null;
    return row.config as unknown as SonarQubeConfig;
  }

  async function getById(id: string) {
    return db.select().from(issuePullRequests).where(eq(issuePullRequests.id, id)).then((rows) => rows[0] ?? null);
  }

  async function createOrUpdateMergeApproval(row: typeof issuePullRequests.$inferSelect, requestedNote?: string | null) {
    const payload = {
      provider: row.provider,
      repo: row.repo,
      pullNumber: row.pullNumber,
      pullUrl: row.pullUrl,
      title: row.title,
      baseBranch: row.baseBranch,
      headBranch: row.headBranch,
      headSha: row.headSha,
      expectedHeadSha: row.headSha,
      issueId: row.issueId,
      issuePullRequestId: row.id,
      requesterAgentId: row.requestedByAgentId,
      ciStatus: row.ciStatus,
      reviewStatus: row.reviewStatus,
      qualityStatus: row.qualityStatus,
      mergeMethod: row.mergeMethod,
      requestedNote: requestedNote ?? null,
    };

    if (row.approvalId) {
      const existing = await approvalsSvc.getById(row.approvalId);
      if (existing && existing.status === "pending") {
        await db
          .update(approvals)
          .set({ payload, updatedAt: now() })
          .where(eq(approvals.id, existing.id));
        return existing.id;
      }
      return row.approvalId;
    }

    const approval = await approvalsSvc.create(row.companyId, {
      type: "merge_pr",
      requestedByAgentId: row.requestedByAgentId,
      requestedByUserId: null,
      status: "pending",
      payload,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: now(),
    });
    await db.insert(issueApprovals).values({
      companyId: row.companyId,
      issueId: row.issueId,
      approvalId: approval.id,
      linkedByAgentId: row.requestedByAgentId,
      linkedByUserId: null,
    }).onConflictDoNothing();
    await db.update(issuePullRequests).set({ approvalId: approval.id, updatedAt: now() }).where(eq(issuePullRequests.id, row.id));
    return approval.id;
  }

  async function listForIssue(issueId: string) {
    return db
      .select()
      .from(issuePullRequests)
      .where(eq(issuePullRequests.issueId, issueId))
      .orderBy(asc(issuePullRequests.createdAt));
  }

  // F8 (e2e-run-2026-06-10 #8): the merge-base allowlist was a single global env
  // list (main/master/development/develop), so staging-default repos could never be
  // merged from the dashboard — forcing out-of-band GitHub merges. Resolution is
  // read-time: static/env list ∪ the PR base repo's own default branch ∪ any
  // project_workspaces.metadata.allowedMergeBases whose repoUrl matches the PR repo.
  async function resolveMergeBaseAllowlist(
    companyId: string,
    repo: string,
    baseRepoDefaultBranch: string | null,
  ): Promise<Set<string>> {
    const allowed = new Set(mergeBaseAllowlist());
    if (baseRepoDefaultBranch && baseRepoDefaultBranch.trim()) {
      allowed.add(baseRepoDefaultBranch.trim());
    }
    try {
      const prSlug = parseRemoteSlug(repo)?.slug;
      if (prSlug) {
        const workspaces = await db
          .select({ repoUrl: projectWorkspaces.repoUrl, metadata: projectWorkspaces.metadata })
          .from(projectWorkspaces)
          .where(eq(projectWorkspaces.companyId, companyId));
        for (const workspace of workspaces) {
          if (parseRemoteSlug(workspace.repoUrl)?.slug !== prSlug) continue;
          const extra = (workspace.metadata as Record<string, unknown> | null)?.allowedMergeBases;
          if (!Array.isArray(extra)) continue;
          for (const branch of extra) {
            if (typeof branch === "string" && branch.trim()) allowed.add(branch.trim());
          }
        }
      }
    } catch (err) {
      logger.warn({ err, companyId, repo }, "merge-base allowlist workspace resolution failed");
    }
    return allowed;
  }

  async function reconcile(id: string): Promise<IssuePullRequestStatus> {
    const row = await getById(id);
    if (!row) throw notFound("Pull request tracking record not found");
    const github = createGitHubClient(await requireGitHubConfig(row.companyId));
    const pr = await github.getPullRequest(row.repo, row.pullNumber);
    const checks = await github.listCheckRuns(row.repo, pr.headSha ?? row.headSha ?? pr.headBranch);
    const reviews = await github.listPRReviews(row.repo, row.pullNumber);
    const sonarConfig = await loadSonarQubeConfig(row.companyId);
    let qualityGate: SonarQubeQualityGate | null = null;
    if (sonarConfig) {
      try {
        qualityGate = await createSonarQubeClient(sonarConfig).getQualityGateStatus();
      } catch {
        qualityGate = { status: "UNKNOWN", conditions: [] };
      }
    }

    const ciStatus = statusFromChecks(checks);
    const reviewStatus = statusFromReviews(reviews);
    const qualityStatus = statusFromQualityGate(qualityGate);
    const allowedMergeBases = await resolveMergeBaseAllowlist(
      row.companyId,
      row.repo,
      pr.baseRepoDefaultBranch,
    );
    const blockers = blockersFor({
      state: pr.state,
      draft: pr.draft,
      baseBranch: pr.baseBranch,
      allowedMergeBases,
      headSha: pr.headSha,
      expectedHeadSha: row.expectedHeadSha,
      ciStatus,
      reviewStatus,
      qualityStatus,
    });
    const mergeStatus = pr.merged ? "merged" : blockers.length === 0 ? "ready" : blockers.some((b) => b.includes("failed") || b.includes("requested")) ? "blocked" : "pending";
    const feedback = buildFeedback({ repo: row.repo, pullNumber: row.pullNumber, checks, reviews, qualityGate, blockers });
    const hash = feedbackHash(feedback);
    const feedbackStatus =
      blockers.length === 0 && row.feedbackStatus === "awaiting_human"
        ? // The reviewer's concerns cleared (e.g. they dismissed/approved) while the PR was
          // held — release the hold so the issue is no longer frozen.
          "idle"
        : blockers.length > 0 && row.lastFeedbackHash !== hash
          ? "needs_agent"
          : row.feedbackStatus;

    const updated = await db
      .update(issuePullRequests)
      .set({
        title: pr.title,
        pullUrl: pr.htmlUrl,
        state: pr.state,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        headSha: pr.headSha,
        mergeCommitSha: pr.mergeCommitSha,
        ciStatus,
        reviewStatus,
        qualityStatus,
        mergeStatus,
        feedbackStatus,
        lastReconciledAt: now(),
        mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : row.mergedAt,
        metadata: { ...(row.metadata ?? {}), checks, reviews, qualityGate, blockers },
        updatedAt: now(),
      })
      .where(eq(issuePullRequests.id, row.id))
      .returning()
      .then((rows) => rows[0] ?? row);
    await createOrUpdateMergeApproval(updated);

    // Audit B2 (e2e-run-2026-06-10): after a force-push, the "PR head changed since
    // merge approval was prepared" blocker never cleared — createOrUpdateMergeApproval
    // refreshes the approval payload's expectedHeadSha while the approval is still
    // pending, but the tracking ROW kept the stale value forever. Mirror the refresh
    // here so the blocker clears on the next reconcile once the panel re-renders the
    // new head. (A decided approval keeps its frozen SHA — that mismatch is the
    // merge()-time recheck working as intended.)
    if (
      updated.approvalId &&
      pr.headSha &&
      updated.expectedHeadSha &&
      updated.expectedHeadSha !== pr.headSha
    ) {
      const approval = await approvalsSvc.getById(updated.approvalId);
      if (approval && approval.status === "pending") {
        await db
          .update(issuePullRequests)
          .set({ expectedHeadSha: pr.headSha, updatedAt: now() })
          .where(eq(issuePullRequests.id, updated.id));
      }
    }

    // HOOK 2 on an EXTERNALLY-detected merge. The in-app merge() captures the
    // pr-approval, but a human can merge the PR directly on GitHub (bypassing the
    // PR panel). When reconcile observes the PR has JUST transitioned to merged,
    // capture the verified pr-approval so the approved decision still lands in the
    // shared context DB regardless of WHERE the merge happened. Guarded on the
    // transition (old row not yet merged) so we capture once, not on every poll;
    // and even a double-fire is idempotent via the (company_id, source) dedup, so
    // an in-app merge() that already captured is never duplicated here.
    if (pr.merged && row.mergeStatus !== "merged") {
      // The MEMORY capture stays gated on an existing approvalId (a verified pr-approval
      // requires the merge_pr approval row), but the STATUS close-out and EM wake must
      // fire on the merged transition regardless — even on the rare approval-less merge.
      if (updated.approvalId) {
        const approvalMemoryEntryId = await captureApprovalMemory({
          row: updated,
          status: { feedback, reviews } as IssuePullRequestStatus,
          approvalId: updated.approvalId,
          decisionNote: null, // external merge: no in-app decision note
          decidedByUserId: null, // merged outside ADE
        });
        if (approvalMemoryEntryId) {
          contextTrace("context_write", {
            provenance: "pr-approval",
            companyId: updated.companyId,
            source: `pr-approval:${updated.provider}:${updated.repo}#${updated.pullNumber}`,
            issueId: updated.issueId,
            entryId: approvalMemoryEntryId,
            via: "reconcile_external_merge",
          });
        }
      }

      // CLOSE-OUT PARITY with the in-app merge() path. merge() sets the tracked issue to
      // "done" (firing notifyParentOnChildStatus -> waking the parent coordinator) and runs
      // the accepted-work manager-wake. An external GitHub-direct merge previously captured
      // memory but LEFT THE ISSUE in "in_review" and never woke the EM — so a merged sub-task
      // froze and the parent's next phase was never raised. closeMergedTrackedIssue mirrors
      // that close-out (transition + EM wake) and works even when heartbeats are OFF.
      await closeMergedTrackedIssue(updated, {
        title: pr.title,
        body: pr.body,
        headBranch: pr.headBranch,
        mergeCommitSha: pr.mergeCommitSha,
        mergedAt: pr.mergedAt,
        htmlUrl: pr.htmlUrl,
        user: pr.user,
        baseBranch: pr.baseBranch,
      });
    }

    // Audit B1 (e2e-run-2026-06-10): a PR CLOSED WITHOUT MERGE previously had no
    // handler — the issue sat in_review forever, the merge_pr approval stayed
    // pending, and nobody was told. On the closed-unmerged TRANSITION: mark the
    // tracking row terminal ("closed" leaves the sweep via the notInArray filter),
    // reject the approval(s), surface a system comment, and wake the assignee so
    // the work is re-planned instead of silently abandoned.
    if (!pr.merged && pr.state === "closed" && row.state === "open") {
      await db
        .update(issuePullRequests)
        .set({ mergeStatus: "closed", updatedAt: now() })
        .where(eq(issuePullRequests.id, updated.id));
      if (updated.approvalId) {
        await approvalsSvc
          .reject(updated.approvalId, "issue-pr-reconcile", "PR was closed on GitHub without merging")
          .catch((err) =>
            logger.debug({ err, approvalId: updated.approvalId }, "issue_pr.closed_unmerged_approval_reject_skipped"),
          );
      }
      await db
        .insert(issueComments)
        .values({
          companyId: updated.companyId,
          issueId: updated.issueId,
          authorAgentId: null,
          authorUserId: null,
          body:
            `PR ${updated.repo}#${updated.pullNumber} was closed on GitHub WITHOUT being merged. ` +
            `The merge approval was rejected. Decide whether to reopen the PR, open a new one, or re-plan this issue.`,
          kind: "system",
        })
        .catch(() => {});
      const [issueRow] = await db
        .select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, updated.issueId));
      if (issueRow?.assigneeAgentId) {
        await heartbeatService(db)
          .wakeup(issueRow.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "pr_closed_unmerged",
            payload: { issueId: updated.issueId, issuePullRequestId: updated.id },
            requestedByActorType: "system",
            requestedByActorId: "issue-pr-reconcile",
          })
          .catch((err) =>
            logger.debug({ err, issueId: updated.issueId }, "issue_pr.closed_unmerged_wake_skipped"),
          );
      }
    }

    const refreshed = await getById(row.id);
    return { pullRequest: (refreshed ?? updated) as never, checks, reviews, qualityGate, blockers, feedback };
  }

  async function sendFeedback(id: string, opts: { requestedByActorType: "user" | "agent" | "system"; requestedByActorId: string | null }) {
    const status = await reconcile(id);
    const row = status.pullRequest as unknown as typeof issuePullRequests.$inferSelect;
    if (status.blockers.length === 0) return { status, sent: false, commentId: null as string | null };
    const hash = feedbackHash(status.feedback);
    if (
      row.lastFeedbackHash === hash &&
      (row.feedbackStatus === "sent" || row.feedbackStatus === "awaiting_human")
    ) {
      // Identical feedback already surfaced (either dispatched to the agent or held for a
      // human). Don't repost the comment on every reconcile poll.
      return { status, sent: false, commentId: null as string | null };
    }
    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId: row.companyId,
        issueId: row.issueId,
        authorAgentId: null,
        authorUserId: opts.requestedByActorType === "user" ? opts.requestedByActorId : null,
        body: status.feedback,
        kind: "system",
      })
      .returning({ id: issueComments.id });
    await db
      .update(issuePullRequests)
      .set({
        feedbackStatus: "sent",
        lastFeedbackHash: hash,
        lastFeedbackAt: now(),
        // Remember the comment id so a later one-shot release (which dedups and posts no
        // new comment) can still reference it as the wake's comment anchor.
        metadata: { ...(row.metadata ?? {}), lastFeedbackCommentId: comment?.id ?? null },
        updatedAt: now(),
      })
      .where(eq(issuePullRequests.id, row.id));
    return { status, sent: true, commentId: comment?.id ?? null };
  }

  async function markFeedbackHeld(rowId: string, reason: FeedbackHoldReason) {
    // Re-read the current metadata so we never clobber keys (e.g. lastFeedbackCommentId)
    // written by sendFeedback earlier in this same dispatch.
    const current = await getById(rowId);
    await db
      .update(issuePullRequests)
      .set({
        feedbackStatus: "awaiting_human",
        metadata: {
          ...(current?.metadata ?? {}),
          feedbackHoldReason: reason,
          feedbackHeldAt: now().toISOString(),
        },
        updatedAt: now(),
      })
      .where(eq(issuePullRequests.id, rowId));
  }

  async function recordFeedbackRound(rowId: string) {
    // Lock the row so concurrent dispatches (manual routes bypass the poll throttle, and
    // multi-instance deploys share no in-memory throttle) can't lose-update the counter
    // and slip past the autopilot round cap.
    await db.transaction(async (tx) => {
      const locked = await tx
        .select({ metadata: issuePullRequests.metadata })
        .from(issuePullRequests)
        .where(eq(issuePullRequests.id, rowId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const meta = (locked?.metadata ?? {}) as Record<string, unknown>;
      const rounds = Number(meta.feedbackRounds ?? 0) || 0;
      await tx
        .update(issuePullRequests)
        .set({
          // Agents are now acting on this feedback, so clear the human-hold marker.
          feedbackStatus: "sent",
          metadata: {
            ...meta,
            feedbackRounds: rounds + 1,
            feedbackHoldReason: null,
            lastFeedbackDispatchedAt: now().toISOString(),
          },
          updatedAt: now(),
        })
        .where(eq(issuePullRequests.id, rowId));
    });
  }

  async function dispatchFeedbackToAssignee(
    id: string,
    opts: {
      requestedByActorType: "user" | "agent" | "system";
      requestedByActorId: string | null;
      // Set by the board-only opt-in control to dispatch the currently-pending feedback
      // even when it was already surfaced (and to bypass the default human hold).
      forceWake?: boolean;
    },
  ) {
    const result = await sendFeedback(id, opts);
    const row = result.status.pullRequest as unknown as typeof issuePullRequests.$inferSelect;
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, row.issueId))
      .then((rows) => rows[0] ?? null);

    const assigneeAgentId = issue?.assigneeAgentId ?? null;
    const hasBlockers = result.status.blockers.length > 0;
    const forceWake = opts.forceWake === true;
    // Consider waking only when there is fresh feedback (result.sent) or a human is
    // explicitly forcing dispatch (forceWake) — and there is someone to wake.
    const shouldConsiderWake =
      hasBlockers && assigneeAgentId !== null && (result.sent || forceWake);

    if (!shouldConsiderWake || assigneeAgentId === null) {
      return {
        ...result,
        wakeRunId: null as string | null,
        held: false as const,
        holdReason: null as FeedbackHoldReason | null,
      };
    }

    // Human-forced release is one-shot and always allowed; the automatic poll path is
    // gated (held by default, auto-allowed only under autopilot within the round cap).
    if (!forceWake) {
      const gate = resolveFeedbackGate(row.metadata);
      if (!gate.allowed) {
        await markFeedbackHeld(row.id, gate.reason);
        return {
          ...result,
          wakeRunId: null as string | null,
          held: true as const,
          holdReason: gate.reason,
        };
      }
    }

    // When the human releases a held PR, sendFeedback dedups and returns no fresh comment;
    // fall back to the comment id stored when the feedback was first surfaced so the wake
    // carries a real comment anchor (otherwise it can be coalesced into a running run
    // instead of producing an actionable follow-up).
    const feedbackCommentId =
      result.commentId ?? (readNonEmptyString(row.metadata?.lastFeedbackCommentId) ?? null);

    const wake = await heartbeatService(db).wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "pr_feedback",
      payload: {
        issueId: row.issueId,
        issuePullRequestId: row.id,
        commentId: feedbackCommentId,
        feedback: result.status.feedback,
      },
      // Forced releases are an explicit human action — mark them user-originated so the
      // per-issue review-hold gate in enqueueWakeup lets them through.
      requestedByActorType: forceWake ? "user" : opts.requestedByActorType,
      requestedByActorId: opts.requestedByActorId,
      contextSnapshot: {
        issueId: row.issueId,
        taskId: row.issueId,
        commentId: feedbackCommentId,
        wakeCommentId: feedbackCommentId,
        wakeReason: "pr_feedback",
        issuePullRequestId: row.id,
        prFeedback: result.status.feedback,
      },
    });
    const wakeRunId = wake?.id ?? null;
    if (wakeRunId) {
      await recordFeedbackRound(row.id);
    }
    return { ...result, wakeRunId, held: false as const, holdReason: null as FeedbackHoldReason | null };
  }

  // Board-only one-shot control. enabled:true releases the currently-pending review
  // feedback to the assignee exactly once (the next reviewer round re-holds for the
  // human). enabled:false re-holds immediately without dispatching.
  async function setFeedbackOptIn(
    id: string,
    enabled: boolean,
    actor: { requestedByActorType: "user" | "agent" | "system"; requestedByActorId: string | null },
  ) {
    const row = await getById(id);
    if (!row) throw notFound("Pull request tracking record not found");
    if (!enabled) {
      await db
        .update(issuePullRequests)
        .set({ feedbackStatus: "awaiting_human", updatedAt: now() })
        .where(eq(issuePullRequests.id, row.id));
      return { pullRequest: await getById(row.id), dispatched: null };
    }
    const dispatched = await dispatchFeedbackToAssignee(id, { ...actor, forceWake: true });
    return { pullRequest: await getById(row.id), dispatched };
  }

  // BACKSTOP sweep (belt-and-suspenders on top of the in-line reconcile close-out).
  // dispatchFeedbackForCompany filters OUT merged PRs (mergeStatus != 'merged'), so once a
  // PR is merged the company poller never looks at it again. If the in-line reconcile
  // close-out was ever missed — e.g. a PR that was already merged on GitHub BEFORE this fix
  // shipped (PINB405-5) — the tracked issue would stay stuck (in_review) forever. This sweep
  // finds merged PRs whose linked issue is still open (NOT done/cancelled) and runs the same
  // idempotent done-transition + EM wake. Scoped per-company, batch-limited, soft-fail per
  // row. The done-transition no-ops if already terminal; the manager-wake is dedup-guarded —
  // so a row that was already closed in-line is harmless here.
  async function sweepMergedOpenIssues(companyId: string): Promise<{ scanned: number; closed: number }> {
    const rows = await db
      .select({
        prId: issuePullRequests.id,
        issueId: issuePullRequests.issueId,
        repo: issuePullRequests.repo,
        pullNumber: issuePullRequests.pullNumber,
        pullUrl: issuePullRequests.pullUrl,
        title: issuePullRequests.title,
        headBranch: issuePullRequests.headBranch,
        baseBranch: issuePullRequests.baseBranch,
        mergeCommitSha: issuePullRequests.mergeCommitSha,
        mergedAt: issuePullRequests.mergedAt,
        issueStatus: issues.status,
      })
      .from(issuePullRequests)
      .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
      .where(
        and(
          eq(issuePullRequests.companyId, companyId),
          eq(issuePullRequests.mergeStatus, "merged"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(asc(issuePullRequests.mergedAt))
      .limit(50);

    let closed = 0;
    for (const row of rows) {
      try {
        const prRow = await getById(row.prId);
        if (!prRow) continue;
        await closeMergedTrackedIssue(prRow, {
          title: row.title,
          headBranch: row.headBranch,
          baseBranch: row.baseBranch,
          mergeCommitSha: row.mergeCommitSha,
          mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
          htmlUrl: row.pullUrl,
        });
        // One-time visibility for the retroactive bulk transition of historically-merged
        // issues, so the sweep's writes are observable in logs the first time it runs.
        logger.info(
          { companyId, issueId: row.issueId, repo: row.repo, pullNumber: row.pullNumber, fromStatus: row.issueStatus },
          "issue_pr.swept_merged_open_issue_to_done",
        );
        closed++;
      } catch (err) {
        // Soft-fail per row so one bad issue doesn't kill the sweep.
        logger.debug({ err, issuePullRequestId: row.prId }, "issue_pr.sweep_merged_open_failed");
      }
    }
    return { scanned: rows.length, closed };
  }

  async function dispatchFeedbackForCompany(companyId: string) {
    // Run the merged-but-open backstop first so a stuck merged sub-task is reconciled even
    // though the feedback query below intentionally excludes merged PRs.
    const swept = await sweepMergedOpenIssues(companyId).catch(() => ({ scanned: 0, closed: 0 }));

    const rows = await db
      .select({ id: issuePullRequests.id })
      .from(issuePullRequests)
      .where(and(eq(issuePullRequests.companyId, companyId), ne(issuePullRequests.mergeStatus, "merged")))
      .orderBy(asc(issuePullRequests.lastReconciledAt))
      .limit(50);

    let scanned = 0;
    let sent = 0;
    let woken = 0;
    for (const row of rows) {
      scanned++;
      try {
        const result = await dispatchFeedbackToAssignee(row.id, {
          requestedByActorType: "system",
          requestedByActorId: "issue-pr-reconcile",
        });
        if (result.sent) sent++;
        if (result.wakeRunId) woken++;
      } catch (_err) {
        // Per-PR soft failure keeps one bad integration response from
        // blocking feedback dispatch for the rest of the company.
      }
    }
    return { scanned, sent, woken, sweptMerged: swept.scanned, closedMerged: swept.closed };
  }

  // F13/F1 (e2e-run-2026-06-10 #13, #1): PR reconciliation previously ran only inside
  // wake dispatch, so with no agent wakes an external (GitHub-direct) merge was never
  // detected — tracking stayed open/pending, the issue sat in_review forever, and no
  // pr-approval memory was captured. This sweep reconciles open tracked PRs from the
  // scheduler tick. reconcile() already performs the full merge close-out chain.
  // Cost cap: reconcile() is ~3 GitHub calls per PR — bounded by `limit`, oldest
  // lastReconciledAt first; per-row soft-fail so one bad PR can't stall the rest.
  async function reconcileOpenTrackedPrs(
    companyId: string,
    opts: { limit?: number } = {},
  ): Promise<{ scanned: number; merged: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const rows = await db
      .select({ id: issuePullRequests.id, issueId: issuePullRequests.issueId })
      .from(issuePullRequests)
      .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
      .where(
        and(
          eq(issuePullRequests.companyId, companyId),
          // "closed" (unmerged, audit B1) is terminal too — keeps abandoned PRs
          // from burning GitHub calls on every sweep forever (audit B4).
          notInArray(issuePullRequests.mergeStatus, ["merged", "closed"]),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(asc(issuePullRequests.lastReconciledAt))
      .limit(limit);

    let merged = 0;
    for (const row of rows) {
      try {
        const status = await reconcile(row.id);
        const reconciled = status.pullRequest as unknown as typeof issuePullRequests.$inferSelect;
        if (reconciled.mergeStatus === "merged") merged += 1;
      } catch (err) {
        logger.debug({ err, issuePullRequestId: row.id }, "issue_pr.sweep_reconcile_failed");
      }
    }

    // Backfill (one-time per row, cheap): merged tracking rows from BEFORE the
    // batch-resolve existed can still have actionable merge_pr approval cards.
    try {
      const mergedRows = await db
        .select({ issueId: issuePullRequests.issueId })
        .from(issuePullRequests)
        .innerJoin(issueApprovals, eq(issueApprovals.issueId, issuePullRequests.issueId))
        .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
        .where(
          and(
            eq(issuePullRequests.companyId, companyId),
            eq(issuePullRequests.mergeStatus, "merged"),
            eq(approvals.type, "merge_pr"),
            notInArray(approvals.status, ["approved", "rejected"]),
          ),
        )
        .limit(20);
      for (const row of new Set(mergedRows.map((r) => r.issueId))) {
        await resolveDanglingMergeApprovalsForIssue(companyId, row);
      }
    } catch (err) {
      logger.debug({ err, companyId }, "issue_pr.stale_merge_approval_backfill_failed");
    }

    return { scanned: rows.length, merged };
  }

  async function maybeDispatchFeedbackForCompany(companyId: string) {
    const last = prFeedbackReconcileThrottle.get(companyId) ?? 0;
    if (Date.now() - last < PR_FEEDBACK_RECONCILE_INTERVAL_MS) {
      return { skipped: true as const, scanned: 0, sent: 0, woken: 0, sweptMerged: 0, closedMerged: 0 };
    }
    prFeedbackReconcileThrottle.set(companyId, Date.now());
    return { skipped: false as const, ...(await dispatchFeedbackForCompany(companyId)) };
  }

  async function merge(id: string, input: { approvalId?: string | null; expectedHeadSha?: string | null; mergeMethod?: "merge" | "squash" | "rebase"; decidedByUserId: string; decisionNote?: string | null }) {
    const status = await reconcile(id);
    const row = status.pullRequest as unknown as typeof issuePullRequests.$inferSelect;
    if (!row.approvalId) throw unprocessable("Merge approval is missing");
    if (input.approvalId && input.approvalId !== row.approvalId) throw conflict("Merge approval does not match tracked PR");
    const approval = await approvalsSvc.getById(row.approvalId);
    if (!approval) throw notFound("Merge approval not found");
    if (approval.companyId !== row.companyId) throw forbidden("Approval belongs to another company");
    if (approval.type !== "merge_pr") throw unprocessable("Approval is not a merge_pr approval");
    if (approval.status !== "pending" && approval.status !== "revision_requested") {
      throw unprocessable("Only pending merge approvals can be merged");
    }
    const blockers = [...status.blockers];
    const expectedHeadSha = input.expectedHeadSha ?? row.expectedHeadSha;
    if (expectedHeadSha && row.headSha && expectedHeadSha !== row.headSha) {
      blockers.push("PR head changed since merge approval was prepared");
    }
    if (blockers.length > 0) throw unprocessable("PR is not mergeable", { blockers });

    const github = createGitHubClient(await requireGitHubConfig(row.companyId));
    const result = await github.mergePullRequest(
      row.repo,
      row.pullNumber,
      input.mergeMethod ?? normalizeMergeMethod(row.mergeMethod),
      input.decisionNote ?? undefined,
    );
    if (!result.merged) throw unprocessable(result.message || "GitHub did not merge the PR");
    const pr = await github.getPullRequest(row.repo, row.pullNumber);
    const mergedAt = pr.mergedAt ? new Date(pr.mergedAt) : now();
    const updated = await db
      .update(issuePullRequests)
      .set({
        state: pr.state,
        headSha: pr.headSha,
        mergeCommitSha: pr.mergeCommitSha ?? result.sha ?? null,
        mergeStatus: "merged",
        mergedAt,
        updatedAt: now(),
      })
      .where(eq(issuePullRequests.id, row.id))
      .returning()
      .then((rows) => rows[0] ?? row);
    await approvalsSvc.approve(row.approvalId, input.decidedByUserId, input.decisionNote ?? "Merged from PR panel");
    // ---- HOOK 2: EM PR-approval capture (CENTRAL_CONTEXT_DB_PLAN §4.2, §5.2) ----
    // Deterministic, never agent-summarized: an EM board merge carrying a human
    // decisionNote + decidedByUserId is the one path that writes a VERIFIED
    // pr-approval row. The body is the literal human note + the reconcile feedback
    // + an accepted-pattern summary — no LLM. The out-of-band GitHub-direct/poller
    // merge path (no decisionNote) keeps the agent-driven createMemoryFromEvent at
    // agent-claim/unverified (source key accepted_work:<eventId>, distinct from
    // pr-approval:<approvalId> — no collision, no double-capture). Idempotent via
    // (companyId, source). Best-effort: a capture failure MUST NOT fail the merge.
    const approvalMemoryEntryId = await captureApprovalMemory({
      row,
      status,
      approvalId: row.approvalId,
      decisionNote: input.decisionNote ?? null,
      decidedByUserId: input.decidedByUserId,
    });
    await issuesSvc.update(row.issueId, { status: "done" });
    return { pullRequest: updated, mergeResult: result, githubPullRequest: pr, approvalMemoryEntryId };
  }

  // Deterministic EM PR-approval memory capture (§4.2 HOOK 2). Only the human
  // decisionNote drives kind/body — no LLM. Best-effort try/catch.
  async function captureApprovalMemory(input: {
    row: typeof issuePullRequests.$inferSelect;
    status: IssuePullRequestStatus;
    approvalId: string;
    decisionNote: string | null;
    decidedByUserId: string | null;
  }): Promise<string | null> {
    const { row, status } = input;
    const note = readNonEmptyString(input.decisionNote);
    // DURABLE content only (e2e-run-2026-06-10 audit C2): status.feedback is a
    // point-in-time snapshot — blocker lines like "PR is not open (closed)" or
    // "Base branch X is not merge-allowed" go stale the moment config/state moves,
    // yet used to be frozen into a VERIFIED memory body and re-served to agents
    // forever. Keep only reviewer guidance (changes-requested bodies), which is a
    // durable record of what the humans asked for.
    const reviewFeedback = readNonEmptyString(
      status.reviews
        .filter((review) => review.state.toUpperCase() === "CHANGES_REQUESTED")
        .map((review) => `${review.user}: ${review.body?.trim() || "Changes requested"}`)
        .join("\n"),
    );
    // Accepted-pattern summary: which reviewers approved the merged work (the
    // pattern the EM is endorsing by merging). Deterministic, derived from the
    // reconciled reviews — never agent-authored prose.
    const approvedReviewers = Array.from(
      new Set(
        status.reviews
          .filter((review) => review.state.toUpperCase() === "APPROVED")
          .map((review) => review.user),
      ),
    );
    const acceptedPattern = approvedReviewers.length > 0
      ? `Accepted pattern: approved by ${approvedReviewers.join(", ")}.`
      : "Accepted pattern: merged from the PR panel.";

    const bodyParts: string[] = [];
    if (note) bodyParts.push(note);
    if (reviewFeedback) bodyParts.push(reviewFeedback);
    bodyParts.push(acceptedPattern);
    const body = bodyParts.join("\n\n");

    // Stable, cross-machine source key: every machine tracking the same PR collapses
    // to ONE verified row (SCOPE-1). mergeCommitSha is preferred when present.
    const mergeCommitSha = (row as { mergeCommitSha?: string | null }).mergeCommitSha ?? null;
    const provider = (row as { provider?: string | null }).provider ?? "github";
    const entry: CreateEntryInput = {
      companyId: row.companyId,
      layer: "workspace",
      subject: `EM approved PR ${row.repo}#${row.pullNumber}: ${row.title}`.slice(0, 480),
      body,
      // The human decisionNote is what makes this a durable CONVENTION; a
      // note-less merge is captured as a lighter 'note'.
      kind: note ? "convention" : "note",
      serviceScope: row.repo,
      source: prApprovalSource({
        approvalId: input.approvalId,
        provider,
        repo: row.repo,
        pullNumber: row.pullNumber,
        mergeCommitSha,
      }),
      provenance: "pr-approval",
      authorType: "user",
      verificationState: "verified",
      confidence: 0.8,
      createdBy: input.decidedByUserId,
      sourceRefType: "approval",
      sourceRefId: input.approvalId,
    };

    // Durable: a context-DB outage enqueues this verified approval for replay
    // rather than silently dropping it (I4).
    const result = await captureHumanMemoryDurable(db, entry);
    if (!result.ok) {
      logger.error(
        { issuePullRequestId: row.id, approvalId: input.approvalId },
        "HOOK 2 EM PR-approval capture failed; enqueued for replay",
      );
    }
    return result.entryId ?? null;
  }

  return {
    getById,

    listForIssue,

    async upsertForIssue(input: {
      companyId: string;
      issueId: string;
      requestedByAgentId?: string | null;
      repo: string;
      pullNumber: number;
      pullUrl: string;
      title: string;
      baseBranch: string;
      headBranch?: string | null;
      headSha?: string | null;
      mergeMethod?: "merge" | "squash" | "rebase";
      requestedNote?: string | null;
      metadata?: Record<string, unknown> | null;
    }) {
      const issue = await db
        .select()
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      const existing = await db
        .select()
        .from(issuePullRequests)
        .where(
          and(
            eq(issuePullRequests.companyId, input.companyId),
            eq(issuePullRequests.provider, "github"),
            eq(issuePullRequests.repo, input.repo),
            eq(issuePullRequests.pullNumber, input.pullNumber),
          ),
        )
        .then((rows) => rows[0] ?? null);

      const values = {
        companyId: input.companyId,
        issueId: input.issueId,
        requestedByAgentId: input.requestedByAgentId ?? null,
        provider: "github",
        repo: input.repo,
        pullNumber: input.pullNumber,
        pullUrl: input.pullUrl,
        title: input.title,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch ?? null,
        headSha: input.headSha ?? null,
        expectedHeadSha: input.headSha ?? null,
        mergeMethod: input.mergeMethod ?? "squash",
        metadata: input.metadata ?? null,
        updatedAt: now(),
      } satisfies Partial<typeof issuePullRequests.$inferInsert>;

      const row = existing
        ? await db
          .update(issuePullRequests)
          .set(values)
          .where(eq(issuePullRequests.id, existing.id))
          .returning()
          .then((rows) => rows[0])
        : await db
          .insert(issuePullRequests)
          .values(values as typeof issuePullRequests.$inferInsert)
          .returning()
          .then((rows) => rows[0]);

      const approvalId = await createOrUpdateMergeApproval(row, input.requestedNote);
      const updated = await getById(row.id);
      if (issue.status !== "in_review" && issue.status !== "done" && issue.status !== "cancelled") {
        await issuesSvc.update(issue.id, { status: "in_review" });
      }
      return { ...(updated ?? row), approvalId };
    },

    reconcile,
    sendFeedback,
    dispatchFeedbackToAssignee,
    setFeedbackOptIn,
    dispatchFeedbackForCompany,
    maybeDispatchFeedbackForCompany,
    reconcileOpenTrackedPrs,
    sweepMergedOpenIssues,
    merge,
  };
}
