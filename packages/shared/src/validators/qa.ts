import { z } from "zod";

export const qaPlatforms = ["web", "android", "api", "ios", "manual"] as const;
export const qaRunnerTypes = [
  "android_emulator",
  "lender_automated",
  "github_ci_api",
  "rest_assured",
  "playwright",
  "selenium",
  "custom_command",
] as const;
export const qaParserTypes = ["none", "junit_xml", "surefire", "gradle", "github_checks", "maestro"] as const;
export const qaResultStatuses = ["passed", "failed", "blocked", "skipped"] as const;
export const qaRunStatuses = ["queued", "running", "passed", "failed", "blocked", "cancelled"] as const;

const commandProfileSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeoutSec: z.number().int().positive().max(86_400).optional(),
  artifactsPath: z.string().optional(),
  appPath: z.string().optional(),
  testPath: z.string().optional(),
  emulatorName: z.string().optional(),
  githubCheckNamePattern: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

export const qaTestCaseCreateSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  steps: z.array(z.string()).optional(),
  expectedResult: z.string().min(1),
  platform: z.enum(qaPlatforms).or(z.string().min(1)).optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).or(z.string().min(1)).optional(),
  service: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type QaTestCaseCreate = z.infer<typeof qaTestCaseCreateSchema>;

export const qaTestSuiteCreateSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  platform: z.enum(qaPlatforms).or(z.string().min(1)).optional(),
  runnerType: z.enum(qaRunnerTypes).or(z.string().min(1)).optional(),
  service: z.string().optional().nullable(),
  caseIds: z.array(z.string().uuid()).optional(),
  commandProfile: commandProfileSchema.optional(),
  parserType: z.enum(qaParserTypes).or(z.string().min(1)).optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
});
export type QaTestSuiteCreate = z.infer<typeof qaTestSuiteCreateSchema>;

export const qaEnvironmentUpsertSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(qaPlatforms).or(z.string().min(1)).optional(),
  baseUrl: z.string().url().optional().nullable(),
  variables: z.record(z.unknown()).optional(),
  status: z.string().optional(),
});
export type QaEnvironmentUpsert = z.infer<typeof qaEnvironmentUpsertSchema>;

export const qaDeviceRegisterSchema = z.object({
  workerId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().optional(),
  platform: z.string().optional(),
  osVersion: z.string().optional().nullable(),
  apiLevel: z.string().optional().nullable(),
  capabilities: z.record(z.unknown()).optional(),
  healthStatus: z.string().optional(),
});
export type QaDeviceRegister = z.infer<typeof qaDeviceRegisterSchema>;

export const qaLocalAndroidDiscoverySchema = z.object({
  workerId: z.string().min(1).optional(),
});
export type QaLocalAndroidDiscovery = z.infer<typeof qaLocalAndroidDiscoverySchema>;

export const qaTestRunCreateSchema = z.object({
  issueId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  suiteId: z.string().uuid().optional().nullable(),
  environmentId: z.string().uuid().optional().nullable(),
  deviceId: z.string().uuid().optional().nullable(),
  qaAgentId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  platform: z.enum(qaPlatforms).or(z.string().min(1)).optional(),
  runnerType: z.enum(qaRunnerTypes).or(z.string().min(1)).optional(),
  repo: z.string().optional().nullable(),
  service: z.string().optional().nullable(),
  pullNumber: z.number().int().positive().optional().nullable(),
  pullUrl: z.string().url().optional().nullable(),
  headSha: z.string().optional().nullable(),
  buildSha: z.string().optional().nullable(),
  commandProfile: commandProfileSchema.optional(),
  parserType: z.enum(qaParserTypes).or(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type QaTestRunCreate = z.infer<typeof qaTestRunCreateSchema>;

export const qaTestRunUpdateSchema = z.object({
  status: z.enum(qaRunStatuses).or(z.string().min(1)).optional(),
  conclusion: z.string().optional(),
  summary: z.string().optional().nullable(),
  startedAt: z.string().datetime().optional().nullable(),
  finishedAt: z.string().datetime().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type QaTestRunUpdate = z.infer<typeof qaTestRunUpdateSchema>;

export const qaTestResultCreateSchema = z.object({
  caseId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  status: z.enum(qaResultStatuses).or(z.string().min(1)),
  expectedResult: z.string().optional().nullable(),
  actualResult: z.string().optional().nullable(),
  failureReason: z.string().optional().nullable(),
  durationMs: z.number().int().nonnegative().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type QaTestResultCreate = z.infer<typeof qaTestResultCreateSchema>;

export const qaArtifactCreateSchema = z.object({
  resultId: z.string().uuid().optional().nullable(),
  type: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  storageKey: z.string().optional().nullable(),
  contentType: z.string().optional().nullable(),
  byteSize: z.number().int().nonnegative().optional().nullable(),
  summary: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type QaArtifactCreate = z.infer<typeof qaArtifactCreateSchema>;

export const qaFeedbackSendSchema = z.object({
  toAgentId: z.string().uuid().optional().nullable(),
  title: z.string().optional(),
  body: z.string().optional(),
  severity: z.string().optional(),
  createBugIssue: z.boolean().optional(),
  wakeDeveloper: z.boolean().optional(),
});
export type QaFeedbackSend = z.infer<typeof qaFeedbackSendSchema>;

export const qaFeedbackApproveSchema = z.object({
  note: z.string().optional().nullable(),
});
export type QaFeedbackApprove = z.infer<typeof qaFeedbackApproveSchema>;

export const qaSignoffSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]),
  note: z.string().optional().nullable(),
});
export type QaSignoff = z.infer<typeof qaSignoffSchema>;

export const qaExportSchema = z.object({
  format: z.enum(["pdf", "csv", "jira"]),
  jiraIssueType: z.string().optional(),
  note: z.string().optional().nullable(),
});
export type QaExport = z.infer<typeof qaExportSchema>;
