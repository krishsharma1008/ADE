import type { GitHubCheckRun, GitHubPRReview, SonarQubeQualityGate } from "./integration.js";

export type IssuePullRequestProvider = "github";
export type IssuePullRequestCiStatus = "unknown" | "pending" | "passed" | "failed";
export type IssuePullRequestReviewStatus = "unknown" | "clean" | "changes_requested";
export type IssuePullRequestQualityStatus = "not_configured" | "unknown" | "pending" | "passed" | "failed";
export type IssuePullRequestMergeStatus = "pending" | "ready" | "merged" | "blocked";
export type IssuePullRequestFeedbackStatus = "idle" | "needs_agent" | "sent";

export interface IssuePullRequest {
  id: string;
  companyId: string;
  issueId: string;
  approvalId: string | null;
  requestedByAgentId: string | null;
  provider: IssuePullRequestProvider;
  repo: string;
  pullNumber: number;
  pullUrl: string;
  title: string;
  state: string;
  baseBranch: string;
  headBranch: string | null;
  headSha: string | null;
  expectedHeadSha: string | null;
  mergeCommitSha: string | null;
  mergeMethod: "merge" | "squash" | "rebase";
  ciStatus: IssuePullRequestCiStatus;
  reviewStatus: IssuePullRequestReviewStatus;
  qualityStatus: IssuePullRequestQualityStatus;
  mergeStatus: IssuePullRequestMergeStatus;
  feedbackStatus: IssuePullRequestFeedbackStatus;
  lastFeedbackHash: string | null;
  lastFeedbackAt: Date | null;
  lastReconciledAt: Date | null;
  mergedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssuePullRequestStatus {
  pullRequest: IssuePullRequest;
  checks: GitHubCheckRun[];
  reviews: GitHubPRReview[];
  qualityGate: SonarQubeQualityGate | null;
  blockers: string[];
  feedback: string;
}
