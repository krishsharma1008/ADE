import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { approvals, issueApprovals, issueComments, issuePullRequests, issues } from "@combyne/db";
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

const PASSING_CHECK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const DEFAULT_MERGE_BASE_BRANCHES = ["main", "master", "development", "develop"];
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);

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
  headSha: string | null;
  expectedHeadSha: string | null;
  ciStatus: string;
  reviewStatus: string;
  qualityStatus: string;
}) {
  const blockers: string[] = [];
  if (input.state !== "open") blockers.push(`PR is not open (${input.state})`);
  if (input.draft) blockers.push("PR is still a draft");
  if (!mergeBaseAllowlist().includes(input.baseBranch)) blockers.push(`Base branch \`${input.baseBranch}\` is not merge-allowed`);
  if (!input.headSha) blockers.push("PR head SHA is unknown");
  if (input.expectedHeadSha && input.headSha && input.expectedHeadSha !== input.headSha) {
    blockers.push("PR head changed since merge approval was prepared");
  }
  if (input.ciStatus !== "passed") blockers.push(`CI checks are ${input.ciStatus}`);
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
    const blockers = blockersFor({
      state: pr.state,
      draft: pr.draft,
      baseBranch: pr.baseBranch,
      headSha: pr.headSha,
      expectedHeadSha: row.expectedHeadSha,
      ciStatus,
      reviewStatus,
      qualityStatus,
    });
    const mergeStatus = pr.merged ? "merged" : blockers.length === 0 ? "ready" : blockers.some((b) => b.includes("failed") || b.includes("requested")) ? "blocked" : "pending";
    const feedback = buildFeedback({ repo: row.repo, pullNumber: row.pullNumber, checks, reviews, qualityGate, blockers });
    const hash = feedbackHash(feedback);
    const feedbackStatus = blockers.length > 0 && row.lastFeedbackHash !== hash ? "needs_agent" : row.feedbackStatus;

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
    const refreshed = await getById(row.id);
    return { pullRequest: (refreshed ?? updated) as never, checks, reviews, qualityGate, blockers, feedback };
  }

  async function sendFeedback(id: string, opts: { requestedByActorType: "user" | "agent" | "system"; requestedByActorId: string | null }) {
    const status = await reconcile(id);
    const row = status.pullRequest as unknown as typeof issuePullRequests.$inferSelect;
    if (status.blockers.length === 0) return { status, sent: false };
    const hash = feedbackHash(status.feedback);
    if (row.lastFeedbackHash === hash && row.feedbackStatus === "sent") return { status, sent: false };
    await db.insert(issueComments).values({
      companyId: row.companyId,
      issueId: row.issueId,
      authorAgentId: null,
      authorUserId: opts.requestedByActorType === "user" ? opts.requestedByActorId : null,
      body: status.feedback,
    });
    await db
      .update(issuePullRequests)
      .set({ feedbackStatus: "sent", lastFeedbackHash: hash, lastFeedbackAt: now(), updatedAt: now() })
      .where(eq(issuePullRequests.id, row.id));
    return { status, sent: true };
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
    await issuesSvc.update(row.issueId, { status: "done" });
    return { pullRequest: updated, mergeResult: result, githubPullRequest: pr };
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
    merge,
  };
}
