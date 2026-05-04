export type QaPlatform = "web" | "android" | "api" | "ios" | "manual";
export type QaRunnerType =
  | "android_emulator"
  | "lender_automated"
  | "github_ci_api"
  | "rest_assured"
  | "playwright"
  | "selenium"
  | "custom_command";
export type QaParserType = "none" | "junit_xml" | "surefire" | "gradle" | "github_checks" | "maestro";
export type QaRunStatus = "queued" | "running" | "passed" | "failed" | "blocked" | "cancelled";
export type QaResultStatus = "passed" | "failed" | "blocked" | "skipped";
export type QaSignoffStatus = "not_requested" | "pending" | "approved" | "rejected";
export type QaFeedbackStatus =
  | "queued"
  | "pending_qa_approval"
  | "approved_for_dev"
  | "sent_to_dev"
  | "known_issue"
  | "deferred"
  | "needs_product_decision"
  | "acknowledged"
  | "resolved";
export type QaExportFormat = "pdf" | "csv" | "jira";

export interface QaCommandProfile {
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  artifactsPath?: string;
  appPath?: string;
  testPath?: string;
  emulatorName?: string;
  githubCheckNamePattern?: string;
  metadata?: Record<string, unknown>;
}

export interface QaTestCase {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string | null;
  ownerAgentId: string | null;
  title: string;
  description: string | null;
  steps: string[];
  expectedResult: string;
  platform: QaPlatform | string;
  priority: string;
  service: string | null;
  tags: string[];
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QaTestSuite {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  platform: QaPlatform | string;
  runnerType: QaRunnerType | string;
  service: string | null;
  caseIds: string[];
  commandProfile: QaCommandProfile;
  parserType: QaParserType | string;
  tags: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface QaEnvironment {
  id: string;
  companyId: string;
  name: string;
  kind: QaPlatform | string;
  baseUrl: string | null;
  variables: Record<string, unknown>;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface QaDevice {
  id: string;
  companyId: string;
  workerId: string;
  name: string;
  kind: string;
  platform: string;
  osVersion: string | null;
  apiLevel: string | null;
  capabilities: Record<string, unknown>;
  healthStatus: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QaDeviceDiscoveryDiagnostics {
  emulatorAvailable: boolean;
  adbAvailable: boolean;
  avdNames: string[];
  runningDevices: string[];
  warnings: string[];
}

export interface QaDeviceDiscoveryResult {
  registered: QaDevice[];
  diagnostics: QaDeviceDiscoveryDiagnostics;
}

export interface QaTestRun {
  id: string;
  companyId: string;
  issueId: string | null;
  projectId: string | null;
  suiteId: string | null;
  environmentId: string | null;
  deviceId: string | null;
  qaAgentId: string | null;
  requestedByAgentId: string | null;
  createdByRunId: string | null;
  title: string;
  platform: QaPlatform | string;
  runnerType: QaRunnerType | string;
  repo: string | null;
  service: string | null;
  pullNumber: number | null;
  pullUrl: string | null;
  headSha: string | null;
  buildSha: string | null;
  status: QaRunStatus | string;
  conclusion: string;
  commandProfile: QaCommandProfile;
  parserType: QaParserType | string;
  summary: string | null;
  signoffStatus: QaSignoffStatus | string;
  signoffByUserId: string | null;
  signoffAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QaTestResult {
  id: string;
  companyId: string;
  runId: string;
  caseId: string | null;
  title: string;
  status: QaResultStatus | string;
  expectedResult: string | null;
  actualResult: string | null;
  failureReason: string | null;
  durationMs: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QaArtifact {
  id: string;
  companyId: string;
  runId: string;
  resultId: string | null;
  type: string;
  title: string;
  url: string | null;
  storageKey: string | null;
  contentType: string | null;
  byteSize: number | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QaFeedbackEvent {
  id: string;
  companyId: string;
  runId: string | null;
  issueId: string | null;
  fromQaAgentId: string | null;
  toAgentId: string | null;
  status: QaFeedbackStatus | string;
  severity: string;
  title: string;
  body: string;
  dedupeHash: string;
  artifactRefs: Record<string, unknown>[];
  sentAt: Date | null;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  createsBugIssue: boolean;
  bugIssueId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QaRunDetail {
  run: QaTestRun;
  suite: QaTestSuite | null;
  environment: QaEnvironment | null;
  device: QaDevice | null;
  results: QaTestResult[];
  artifacts: QaArtifact[];
  feedbackEvents: QaFeedbackEvent[];
}

export interface QaSummary {
  runCounts: Record<string, number>;
  feedbackCounts: Record<string, number>;
  recentRuns: QaTestRun[];
  devices: QaDevice[];
}

export interface QaExportResult {
  format: QaExportFormat;
  filename?: string;
  content?: string;
  contentType?: string;
  jiraIssue?: { id: string; key: string; self: string };
}
