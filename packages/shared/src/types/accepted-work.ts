export const ACCEPTED_WORK_MEMORY_STATUSES = [
  "pending",
  "memory_written",
  "ignored",
  "needs_human_review",
] as const;
export type AcceptedWorkMemoryStatus = (typeof ACCEPTED_WORK_MEMORY_STATUSES)[number];

export const ACCEPTED_WORK_DETECTION_SOURCES = [
  "github_merge_api",
  "dashboard_merge",
  "github_reconcile",
  "heartbeat_reconcile",
  "simulation",
] as const;
export type AcceptedWorkDetectionSource = (typeof ACCEPTED_WORK_DETECTION_SOURCES)[number];

export interface AcceptedWorkEvent {
  id: string;
  companyId: string;
  provider: "github";
  repo: string;
  pullNumber: number;
  pullUrl: string | null;
  title: string;
  body: string | null;
  headBranch: string | null;
  mergedSha: string | null;
  mergedAt: string | null;
  detectedAt: string;
  detectionSource: AcceptedWorkDetectionSource;
  issueId: string | null;
  contributorAgentId: string | null;
  managerAgentId: string | null;
  wakeupRequestedAt: string | null;
  memoryStatus: AcceptedWorkMemoryStatus;
  memoryEntryId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
