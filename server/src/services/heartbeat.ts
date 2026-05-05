import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  costEvents,
  issues,
  projectWorkspaces,
} from "@combyne/db";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { appendTranscriptEntry, type TranscriptRole } from "./agent-transcripts.js";
import { loadRecentMemory, summarizeRunAndPersist } from "./agent-memory.js";
import { getPendingHandoffBrief, markHandoffConsumed } from "./agent-handoff.js";
import { acceptedWorkService } from "./accepted-work.js";
import { memoryService } from "./memory.js";
import { buildBootstrapPreamble, detectBootstrapAnalysis } from "./agent-bootstrap.js";
import { loadAssignedIssueQueue, loadNextFocusedIssue } from "./agent-queue.js";
import {
  resolveAgentContextProfile,
  type AgentContextProfile,
} from "./agent-context-profile.js";
import {
  composeAndApplyBudget,
  contextBudgetComposerEnabled,
  estimatePromptBudget,
  runShadowComposer,
  resolveContextBudgetTokens,
  persistRunBudget,
  recordCalibrationSample,
  shouldAlertDivergence,
  resolvePruningMode,
  snapshotCalibrationRatio,
  summarizeComposed,
  trackCachePrefixHit,
  type BudgetSnapshot,
  type BudgetSnapshotComposer,
} from "./context-budget-telemetry.js";
import { resolveModel } from "@combyne/context-budget";
import { inspectGitStateForIssue } from "./git-state.js";
import { probeAdapterAvailability } from "./adapter-availability.js";
import { extractAndPostQuestions, extractQuestionsFromText, type ExtractedQuestionsResult } from "./agent-question-extract.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { loadCompanyProjectOverview } from "./agent-company-context.js";
import {
  loadLatestSummary,
  DEFAULT_MIN_TRIGGER_TOKENS_STANDING,
  DEFAULT_MIN_TRIGGER_TOKENS_WORKING,
  type SummaryScope,
} from "./transcript-summarizer.js";
import { getSummarizerQueue } from "./summarizer-queue.js";
import { isQuarantined } from "./summarizer-failures.js";
import {
  renderRecentTurns,
  unsummarizedTokensFor,
  RECENT_TURNS_MAX_TOKENS,
} from "./summarizer-triggers.js";
import {
  agentCanHire,
  buildHirePlaybook,
  detectHireIntent,
} from "./agent-hire-playbook.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec } from "../adapters/index.js";
import { createLocalAgentJwt, ensureLocalAgentJwtSecretAtRuntime } from "../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber, asString, appendWithCap, MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { secretService } from "./secrets.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { loadIssueContextRefs, renderIssueContextRefs } from "./issue-context-refs.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_COORDINATOR_MAX_CONCURRENT_RUNS_DEFAULT = 3;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
const COORDINATOR_HEARTBEAT_ROLES = new Set(["ceo", "cto", "cmo", "cfo", "pm", "em", "manager"]);
const DEFERRED_WAKE_CONTEXT_KEY = "_combyneWakeContext";
const SMALL_TASK_MAX_TURNS_DEFAULT = 30;
const SMALL_TASK_TIMEOUT_SEC_DEFAULT = 20 * 60;
const SMALL_TASK_TOKEN_PAUSE_THRESHOLD_DEFAULT = 80_000;
const startLocksByAgent = new Map<string, Promise<void>>();
const REPO_ONLY_CWD_SENTINEL = "/__combyne_repo_only__";
const SERVER_HOST_ID = process.env.COMBYNE_HOST_ID ?? `${os.hostname()}:${process.pid}`;
const SERVER_RESTART_GENERATION = Number(process.env.COMBYNE_RESTART_GENERATION ?? 0);

const AUTO_CLOSE_SUCCESS_STATUSES = new Set(["todo", "in_progress"]);

export async function autoCloseIssueAfterSuccessfulRun(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId: string;
    questionResult?: ExtractedQuestionsResult | null;
  },
): Promise<{ closed: boolean; reason: string }> {
  const issue = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      originKind: issues.originKind,
    })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);

  if (!issue) return { closed: false, reason: "issue_not_found" };
  if (issue.originKind === "terminal_session") {
    return { closed: false, reason: "terminal_session_issue" };
  }
  if (!AUTO_CLOSE_SUCCESS_STATUSES.has(issue.status)) {
    return { closed: false, reason: `status_${issue.status}` };
  }
  if (
    input.questionResult &&
    (input.questionResult.posted > 0 || input.questionResult.skippedExisting > 0)
  ) {
    return { closed: false, reason: "questions_extracted" };
  }

  const openQuestion = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.issueId, issue.id),
        eq(issueComments.kind, "question"),
        isNull(issueComments.answeredAt),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (openQuestion) return { closed: false, reason: "open_questions" };

  const updated = await issueService(db).update(issue.id, { status: "done" });
  if (!updated) return { closed: false, reason: "update_failed" };

  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "heartbeat",
    agentId: input.agentId,
    runId: input.runId,
    action: "issue.auto_closed",
    entityType: "issue",
    entityId: issue.id,
    details: {
      reason: "successful_run_without_questions",
      previousStatus: issue.status,
    },
  });

  return { closed: true, reason: "successful_run_without_questions" };
}

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function hasExplicitMaxConcurrentRuns(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return true;
  if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value.trim()))) return true;
  return false;
}

export function defaultMaxConcurrentRunsForAgent(agent: {
  role?: string | null;
  permissions?: Record<string, unknown> | null;
}) {
  const role = typeof agent.role === "string" ? agent.role.trim().toLowerCase() : "";
  const canCreateAgents =
    !!agent.permissions &&
    typeof agent.permissions === "object" &&
    (agent.permissions as Record<string, unknown>).canCreateAgents === true;
  if (COORDINATOR_HEARTBEAT_ROLES.has(role) || canCreateAgents) {
    return HEARTBEAT_COORDINATOR_MAX_CONCURRENT_RUNS_DEFAULT;
  }
  return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
}

function normalizeMaxConcurrentRuns(value: unknown, fallback: number) {
  const raw = typeof value === "string" ? Number(value.trim()) : value;
  const parsed = Math.floor(asNumber(raw, fallback));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

export function resolveHeartbeatMaxConcurrentRuns(
  heartbeat: Record<string, unknown>,
  agent: {
    role?: string | null;
    permissions?: Record<string, unknown> | null;
  },
) {
  const fallback = defaultMaxConcurrentRunsForAgent(agent);
  return normalizeMaxConcurrentRuns(
    heartbeat.maxConcurrentRuns,
    hasExplicitMaxConcurrentRuns(heartbeat.maxConcurrentRuns)
      ? HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT
      : fallback,
  );
}

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function withSmallCodingTaskControls(
  agent: typeof agents.$inferSelect,
  config: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  if (agent.adapterType !== "claude_local") return config;
  if ((agent.adapterConfig as Record<string, unknown> | null)?.smallCodingTaskProfile === false) return config;
  if (config.smallCodingTaskProfile === false) return config;
  if (!readNonEmptyString(context.issueId) && !readNonEmptyString(context.taskId)) return config;
  if (readNonEmptyString(context.acceptedWorkEventId)) return config;

  const maxTurnsLimit = envPositiveInt("COMBYNE_SMALL_TASK_MAX_TURNS", SMALL_TASK_MAX_TURNS_DEFAULT);
  const timeoutLimit = envPositiveInt("COMBYNE_SMALL_TASK_TIMEOUT_SEC", SMALL_TASK_TIMEOUT_SEC_DEFAULT);
  const currentMaxTurns = asNumber(config.maxTurnsPerRun, 0);
  const currentTimeout = asNumber(config.timeoutSec, 0);
  return {
    ...config,
    maxTurnsPerRun:
      currentMaxTurns > 0 ? Math.min(currentMaxTurns, maxTurnsLimit) : maxTurnsLimit,
    timeoutSec:
      currentTimeout > 0 ? Math.min(currentTimeout, timeoutLimit) : timeoutLimit,
  };
}

function smallTaskTokenPauseThreshold(): number {
  return envPositiveInt("COMBYNE_SMALL_TASK_TOKEN_PAUSE_THRESHOLD", SMALL_TASK_TOKEN_PAUSE_THRESHOLD_DEFAULT);
}

async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function deriveLatestUserFacingAgentMessage(sourceText: string, resultJson: unknown): string | null {
  const extracted = extractQuestionsFromText(sourceText, 1)[0];
  if (extracted) return extracted;

  const result = parseObject(resultJson);
  const structured =
    readNonEmptyString(result?.summary) ??
    readNonEmptyString(result?.message) ??
    readNonEmptyString(result?.result) ??
    readNonEmptyString(result?.final);
  if (structured) return structured.slice(0, 4000);

  const trimmed = sourceText.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-24).join("\n").slice(0, 4000);
}

function contextSectionNames(context: Record<string, unknown>): string[] {
  const sections: string[] = [];
  const hasBody = (key: string, field = "body") =>
    Boolean(readNonEmptyString(parseObject(context[key])?.[field]));
  if (hasBody("combyneBootstrapAnalysis", "preamble")) sections.push("bootstrap");
  if (hasBody("combyneHandoffBrief", "brief")) sections.push("handoff");
  if (hasBody("combyneIssueContextRefs")) sections.push("issueContextRefs");
  if (hasBody("combyneMemoryPreamble")) sections.push("memory");
  if (hasBody("combyneLongTermMemoryPreamble")) sections.push("longTermMemory");
  if (hasBody("combyneAcceptedWorkBrief")) sections.push("acceptedWork");
  if (hasBody("combyneHirePlaybook")) sections.push("hire");
  const hasFocus = hasBody("combyneFocusDirective");
  if (hasFocus) sections.push("focus");
  const queue = parseObject(context.combyneAssignedIssues);
  const queueBody = hasFocus
    ? readNonEmptyString(queue?.digestBody)
    : readNonEmptyString(queue?.digestBody) ?? readNonEmptyString(queue?.body);
  if (queueBody) {
    sections.push("queue");
  }
  if (parseObject(context.combyneCompanyProjects)) sections.push("projects");
  if (hasBody("combyneStandingSummary")) sections.push("standing");
  if (hasBody("combyneWorkingSummary")) sections.push("working");
  if (hasBody("combyneRecentTurns")) sections.push("recentTurns");
  if (hasBody("combyneToolResults")) sections.push("toolResults");
  return sections;
}

function setContextPolicy(
  context: Record<string, unknown>,
  input: {
    profile: AgentContextProfile;
    focusIssueId: string | null;
    focusIssueSource: string | null;
    queueDigest: "included" | "omitted" | "none";
  },
) {
  context.combyneContextPolicy = {
    contextProfile: input.profile,
    contextFocusIssueId: input.focusIssueId,
    focusIssueSource: input.focusIssueSource,
    queueDigest: input.queueDigest,
    includedSections: contextSectionNames(context),
  };
}

function buildContextAuditSnapshot(
  base: Record<string, unknown> | null | undefined,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const policy = parseObject(context.combyneContextPolicy);
  return {
    ...(base ?? {}),
    issueId: readNonEmptyString(context.issueId) ?? readNonEmptyString(base?.issueId),
    taskId: readNonEmptyString(context.taskId) ?? readNonEmptyString(base?.taskId),
    taskKey: readNonEmptyString(context.taskKey) ?? readNonEmptyString(base?.taskKey),
    contextProfile: readNonEmptyString(policy?.contextProfile),
    contextFocusIssueId: readNonEmptyString(policy?.contextFocusIssueId),
    contextFocusIssueSource: readNonEmptyString(policy?.focusIssueSource),
    contextQueueDigest: readNonEmptyString(policy?.queueDigest),
    contextIncludedSections: contextSectionNames(context),
  };
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

/**
 * Rollback lever: set COMBYNE_RESET_SESSION_ON_ASSIGN=true to restore the
 * pre-Phase-C4 behaviour of wiping the saved adapter session whenever an
 * issue is re-assigned. Default (unset or "false") keeps the session warm
 * and lets the memory/handoff pipeline inject new context instead.
 */
function resetSessionOnAssignEnabled(): boolean {
  const raw = process.env.COMBYNE_RESET_SESSION_ON_ASSIGN?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned" && resetSessionOnAssignEnabled()) return true;

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return true;

  const wakeTriggerDetail = readNonEmptyString(contextSnapshot?.wakeTriggerDetail);
  return wakeSource === "on_demand" && wakeTriggerDetail === "manual";
}

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned" && resetSessionOnAssignEnabled()) {
    return "wake reason is issue_assigned (rollback lever active)";
  }

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return "wake source is timer";

  const wakeTriggerDetail = readNonEmptyString(contextSnapshot?.wakeTriggerDetail);
  if (wakeSource === "on_demand" && wakeTriggerDetail === "manual") {
    return "this is a manual invoke";
  }
  return null;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export function heartbeatService(db: Db) {
  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAdapterSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const issueProjectId = issueId
      ? await db
          .select({ projectId: issues.projectId })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0]?.projectId ?? null)
      : null;
    const resolvedProjectId = issueProjectId ?? contextProjectId;
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const projectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      for (const workspace of projectWorkspaceRows) {
        const projectCwd = readNonEmptyString(workspace.cwd);
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          continue;
        }
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [],
          };
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      await fs.mkdir(fallbackCwd, { recursive: true });
      const warnings: string[] = [];
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
            : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });
    }

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: event.message,
      payload: event.payload,
    });
    const heartbeatAt = new Date();
    await db
      .update(heartbeatRuns)
      .set({
        processLastHeartbeatAt: heartbeatAt,
        updatedAt: heartbeatAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")));

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: event.message ?? null,
        payload: event.payload ?? null,
      },
    });

    try {
      const role = mapEventToTranscriptRole(event.eventType, event.stream);
      const issueId = resolveRunIssueId(run);
      await appendTranscriptEntry(db, {
        companyId: run.companyId,
        agentId: run.agentId,
        runId: run.id,
        issueId,
        seq,
        role,
        contentKind: event.eventType,
        content: {
          message: event.message ?? null,
          stream: event.stream ?? null,
          level: event.level ?? null,
          payload: event.payload ?? null,
        },
      });
    } catch (err) {
      logger.debug({ err, runId: run.id }, "transcript append failed");
    }
  }

  function mapEventToTranscriptRole(
    eventType: string,
    stream: "system" | "stdout" | "stderr" | undefined,
  ): TranscriptRole {
    if (eventType === "lifecycle") return "lifecycle";
    if (eventType === "error") return "stderr";
    if (eventType === "adapter.invoke") return "system";
    if (stream === "stderr") return "stderr";
    if (stream === "stdout") return "assistant";
    return "system";
  }

  function resolveRunIssueId(run: typeof heartbeatRuns.$inferSelect): string | null {
    const snapshot = run.contextSnapshot as Record<string, unknown> | null | undefined;
    if (!snapshot) return null;
    const direct = snapshot.issueId;
    if (typeof direct === "string" && direct.length > 0) return direct;
    const wake = snapshot[DEFERRED_WAKE_CONTEXT_KEY] as Record<string, unknown> | undefined;
    const nested = wake?.issueId;
    if (typeof nested === "string" && nested.length > 0) return nested;
    return null;
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: resolveHeartbeatMaxConcurrentRuns(heartbeat, agent),
    };
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const claimedAt = new Date();
    const claimed = await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        processPid: process.pid,
        processHostId: SERVER_HOST_ID,
        processStartedAt: run.processStartedAt ?? claimedAt,
        processLastHeartbeatAt: claimedAt,
        processRestartGeneration: SERVER_RESTART_GENERATION,
        recoveryStatus: null,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    return claimed;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted_recoverable",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled" || outcome === "interrupted_recoverable"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number; hardCapMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    // Round 3 Phase 8 — wall-clock hard cap. A run that started >hardCapMs ago
    // is reaped regardless of updatedAt freshness. Catches the failure mode
    // where a stuck child process keeps writing events but the top-level work
    // never completes. Default 60 min, matches the Round 3 plan.
    const hardCapMs = opts?.hardCapMs ?? 60 * 60 * 1000;
    const now = new Date();

    // Find all runs in "queued" or "running" state
    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));

    const reaped: string[] = [];

    for (const run of activeRuns) {
      if (runningProcesses.has(run.id)) continue;

      // Hard-cap short-circuit: if the run started long enough ago, reap it
      // regardless of updatedAt. Uses startedAt when present, falls back to
      // createdAt so queued-but-never-started runs can also be swept.
      let hardCapHit = false;
      const startRef = run.startedAt ?? run.createdAt ?? null;
      if (startRef && hardCapMs > 0) {
        const ageMs = now.getTime() - new Date(startRef).getTime();
        if (ageMs >= hardCapMs) {
          hardCapHit = true;
          logger.warn(
            { runId: run.id, agentId: run.agentId, ageMs, hardCapMs },
            "run.hard_cap_exceeded",
          );
        }
      }

      // Apply staleness threshold to avoid false positives, UNLESS the hard
      // cap already fired — a hard-cap hit overrides the staleness check.
      if (!hardCapHit && staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const nextRunStatus = hardCapHit ? "failed" : "interrupted_recoverable";
      await setRunStatus(run.id, nextRunStatus, {
        error: hardCapHit
          ? "Run exceeded wall-clock hard cap"
          : "Process lost -- server may have restarted",
        errorCode: hardCapHit ? "run_hard_cap_exceeded" : "process_lost",
        recoveryStatus: hardCapHit ? "not_recoverable" : "recoverable",
        processLastHeartbeatAt: run.processLastHeartbeatAt ?? now,
        finishedAt: now,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: hardCapHit
          ? "Run exceeded wall-clock hard cap"
          : "Process lost -- server may have restarted",
      });
      const updatedRun = await getRun(run.id);
      if (updatedRun) {
        await appendRunEvent(updatedRun, 1, {
          eventType: "lifecycle",
          stream: "system",
          level: "error",
          message: hardCapHit
            ? "Run exceeded wall-clock hard cap"
            : "Process lost -- server may have restarted",
        });
        await releaseIssueExecutionAndPromote(updatedRun);
      }
      await finalizeAgentStatus(run.agentId, hardCapHit ? "failed" : "interrupted_recoverable");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  // Round 3 Phase 8 — issue-side reaper.
  //
  // Sweeps issues that still point at a heartbeat run via
  // `execution_run_id` even though the referenced run is terminal
  // (succeeded / failed / cancelled) or absent. The run-side reaper
  // catches live orphans; this companion catches the lock-leak mode
  // where the run transitioned cleanly but `releaseIssueExecutionAndPromote`
  // failed to clear the issue row (transient DB error, deleted agent,
  // etc.). Codex P0 respected: we only ever clear when the referenced
  // run is terminal or missing — never on lock age alone.
  async function reapOrphanedIssueLocks(opts?: { issueId?: string }) {
    const reaped: Array<{ issueId: string; runId: string | null; runStatus: string | null }> = [];

    const conditions = [sql`${issues.executionRunId} IS NOT NULL`];
    if (opts?.issueId) {
      conditions.push(eq(issues.id, opts.issueId));
    }

    const rows = await db
      .select({
        issueId: issues.id,
        companyId: issues.companyId,
        executionRunId: issues.executionRunId,
        runStatus: heartbeatRuns.status,
      })
      .from(issues)
      .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, issues.executionRunId))
      .where(and(...conditions));

    for (const row of rows) {
      // Only clear when the run is terminal or absent. Live runs
      // ('queued' or 'running') are left alone — the run-side reaper
      // owns them.
      const runStatus = row.runStatus;
      const isLive = runStatus === "queued" || runStatus === "running";
      if (isLive) continue;

      await db
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, row.issueId));

      reaped.push({
        issueId: row.issueId,
        runId: row.executionRunId,
        runStatus: runStatus ?? null,
      });

      logger.warn(
        {
          issueId: row.issueId,
          runId: row.executionRunId,
          runStatus: runStatus ?? null,
        },
        "issue.lock_reaped",
      );
    }

    return { reaped: reaped.length, reapedIssues: reaped };
  }

  // Round 3 Phase 8 — operator-initiated force-unlock for a single issue.
  // Used when an admin decides an issue is stuck and wants to recover it
  // without waiting for the reaper. Returns the same shape as the bulk
  // reaper so the caller can tell whether any work was actually done.
  async function forceUnlockIssue(issueId: string, actor: { actorType: string; actorId: string | null }) {
    const [issue] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    if (!issue) throw notFound("Issue not found");
    if (!issue.executionRunId) {
      return { cleared: false, previousRunId: null, previousRunStatus: null };
    }

    // Look up the referenced run for audit purposes. We DO clear even if
    // the run is still 'running' — this is an explicit operator override.
    // The route layer is responsible for gating who can call this.
    const [run] = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, issue.executionRunId));

    await db
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));

    logger.warn(
      {
        issueId: issue.id,
        actorType: actor.actorType,
        actorId: actor.actorId,
        previousRunId: issue.executionRunId,
        previousRunStatus: run?.status ?? null,
      },
      "issue.force_unlocked",
    );

    return {
      cleared: true,
      previousRunId: issue.executionRunId,
      previousRunStatus: run?.status ?? null,
    };
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
  ) {
    await ensureRuntimeState(agent);
    const usage = result.usage;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const additionalCostCents = Math.max(0, Math.round((result.costUsd ?? 0) * 100));
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      await db.insert(costEvents).values({
        companyId: agent.companyId,
        agentId: agent.id,
        provider: result.provider ?? "unknown",
        model: result.model ?? "unknown",
        inputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }

    if (additionalCostCents > 0) {
      await db
        .update(agents)
        .set({
          spentMonthlyCents: sql`${agents.spentMonthlyCents} + ${additionalCostCents}`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.id));
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(availableSlots);
      if (queuedRuns.length === 0) return [];

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        void executeRun(claimedRun.id).catch((err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
        });
      }
      return claimedRuns;
    });
  }

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    const agent = await getAgent(run.agentId);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const contextProfile = await resolveAgentContextProfile(db, {
      id: agent.id,
      companyId: agent.companyId,
      role: agent.role,
      permissions: parseObject(agent.permissions),
      adapterConfig: parseObject(agent.adapterConfig),
    });
    let memoryIssueId = readNonEmptyString(context.issueId);
    let focusIssueSource: string | null = memoryIssueId ? "context" : null;
    let queueDigestPolicy: "included" | "omitted" | "none" =
      contextProfile === "focused" ? "none" : "included";
    if (contextProfile === "focused" && !memoryIssueId && run.invocationSource === "timer") {
      const nextIssue = await loadNextFocusedIssue(db, {
        companyId: agent.companyId,
        agentId: agent.id,
      });
      if (nextIssue) {
        memoryIssueId = nextIssue.id;
        focusIssueSource = "timer_next_actionable";
        context.issueId = nextIssue.id;
        context.taskId = nextIssue.id;
        context.taskKey = nextIssue.identifier ?? nextIssue.id;
      }
    }
    setContextPolicy(context, {
      profile: contextProfile,
      focusIssueId: memoryIssueId ?? null,
      focusIssueSource,
      queueDigest: queueDigestPolicy,
    });
    const acceptedWorkSvc = acceptedWorkService(db);
    void acceptedWorkSvc
      .maybeReconcileGitHubCompany(agent.companyId)
      .then(async (result) => {
        if (result.skipped) return;
        for (const event of result.events) {
          if (
            event.memoryStatus !== "pending" ||
            event.wakeupRequestedAt ||
            !event.managerAgentId
          ) {
            continue;
          }
          await enqueueWakeup(event.managerAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "accepted_work_merged_pr",
            requestedByActorType: "system",
            requestedByActorId: "accepted-work-reconcile",
            contextSnapshot: {
              acceptedWorkEventId: event.id,
              source: "accepted_work.github_reconcile",
            },
          });
          await acceptedWorkSvc.markWakeRequested(event.id);
        }
      })
      .catch((err) => {
        logger.debug({ err, companyId: agent.companyId }, "accepted-work heartbeat reconciliation failed");
      });
    let pendingHandoffId: string | null = null;
    try {
      const handoff = await getPendingHandoffBrief(db, agent.id, memoryIssueId ?? null);
      if (handoff) {
        pendingHandoffId = handoff.id;
        context.combyneHandoffBrief = {
          id: handoff.id,
          fromAgentId: handoff.fromAgentId,
          brief: handoff.brief,
          openQuestions: handoff.openQuestions ?? [],
        };
        try {
          await appendTranscriptEntry(db, {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            issueId: memoryIssueId ?? null,
            seq: 0,
            role: "user",
            contentKind: "handoff_brief",
            content: {
              handoffId: handoff.id,
              fromAgentId: handoff.fromAgentId,
              brief: handoff.brief,
              openQuestions: handoff.openQuestions ?? [],
            },
          });
        } catch (err) {
          logger.debug({ err, agentId: agent.id, runId }, "failed to transcript handoff brief");
        }
        try {
          await markHandoffConsumed(db, handoff.id);
        } catch (err) {
          logger.debug({ err, handoffId: handoff.id }, "failed to mark handoff consumed");
        }
      }
    } catch (err) {
      logger.debug({ err, agentId: agent.id }, "failed to load pending handoff");
    }
    void pendingHandoffId;
    if (contextProfile !== "focused" || memoryIssueId) {
      try {
        const memoryRows = await loadRecentMemory(db, {
          companyId: agent.companyId,
          agentId: agent.id,
          issueId: memoryIssueId ?? null,
          limit: 8,
        });
        if (memoryRows.length > 0) {
          const preamble = memoryRows
            .map((row) => {
              const header = row.title ? `## ${row.title}` : `## ${row.scope}/${row.kind}`;
              return `${header}\n${row.body}`;
            })
            .join("\n\n");
          const capped = preamble.length > 16000 ? `${preamble.slice(0, 16000)}\n…(truncated)` : preamble;
          context.combyneMemoryPreamble = {
            body: capped,
            entryCount: memoryRows.length,
            scope: memoryIssueId ? "issue" : "agent",
          };
        }
      } catch (err) {
        logger.debug({ err, agentId: agent.id, runId }, "failed to load agent memory preamble");
      }
    }
    if (contextProfile !== "focused") {
      try {
        const acceptedWorkEventId = readNonEmptyString(context.acceptedWorkEventId);
        const events = await acceptedWorkSvc.pendingForManager(
          agent.companyId,
          agent.id,
          acceptedWorkEventId ?? null,
        );
        if (events.length > 0) {
          const body = await acceptedWorkSvc.buildBrief(agent.companyId, events);
          if (body) {
            context.combyneAcceptedWorkBrief = {
              body,
              eventIds: events.map((event) => event.id),
            };
            try {
              await appendTranscriptEntry(db, {
                companyId: agent.companyId,
                agentId: agent.id,
                runId: run.id,
                issueId: memoryIssueId ?? null,
                seq: 0,
                role: "system",
                contentKind: "accepted_work_brief",
                content: {
                  eventIds: events.map((event) => event.id),
                  body,
                },
              });
            } catch (err) {
              logger.debug({ err, agentId: agent.id, runId }, "failed to transcript accepted work brief");
            }
          }
        }
      } catch (err) {
        logger.debug({ err, agentId: agent.id, runId }, "failed to load accepted work brief");
      }
    }
    if (memoryIssueId) {
      try {
        const issueRow = await db
          .select({
            title: issues.title,
            description: issues.description,
            identifier: issues.identifier,
          })
          .from(issues)
          .where(and(eq(issues.id, memoryIssueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);
        if (issueRow) {
          const longTerm = memoryService(db);
          const query = [
            issueRow.identifier,
            issueRow.title,
            issueRow.description,
          ].filter(Boolean).join("\n");
          const ranked = await longTerm.queryRanked(agent.companyId, query, {
            layers: ["workspace", "shared", "personal"],
            ownerType: "agent",
            ownerId: agent.id,
            limit: 8,
            includeSnippets: false,
          });
          const entries = [];
          for (const item of ranked.items) {
            const entry = await longTerm.getEntry(item.id);
            if (!entry) continue;
            entries.push(entry);
            await longTerm.recordUsage({
              entryId: entry.id,
              companyId: agent.companyId,
              issueId: memoryIssueId,
              actorType: "agent",
              actorId: agent.id,
              score: item.score,
            });
          }
          if (entries.length > 0) {
            const body = entries
              .map((entry) => {
                const scope = entry.serviceScope ? ` · ${entry.serviceScope}` : "";
                const tags = entry.tags.length ? `\nTags: ${entry.tags.join(", ")}` : "";
                return `## ${entry.subject}\nLayer: ${entry.layer}${scope}${tags}\n${entry.body}`;
              })
              .join("\n\n");
            context.combyneLongTermMemoryPreamble = {
              body: body.length > 16_000 ? `${body.slice(0, 16_000)}\n…(truncated)` : body,
              entryCount: entries.length,
              source: "memory_entries",
            };
          }
        }
      } catch (err) {
        logger.debug({ err, agentId: agent.id, runId, issueId: memoryIssueId }, "failed to load long-term memory");
      }
    }
    if (memoryIssueId) {
      try {
        const bootstrap = await detectBootstrapAnalysis(db, {
          companyId: agent.companyId,
          agentId: agent.id,
          issueId: memoryIssueId,
        });
        if (bootstrap) {
          const preamble = await buildBootstrapPreamble({
            companyId: agent.companyId,
            agentId: agent.id,
            issueId: memoryIssueId,
          });
          context.combyneBootstrapAnalysis = { ...bootstrap, preamble };
          try {
            await appendTranscriptEntry(db, {
              companyId: agent.companyId,
              agentId: agent.id,
              runId: run.id,
              issueId: memoryIssueId,
              seq: 0,
              role: "system",
              contentKind: "bootstrap_preamble",
              content: { body: preamble, reason: bootstrap.reason },
            });
          } catch (err) {
            logger.debug({ err, agentId: agent.id, runId }, "failed to transcript bootstrap preamble");
          }
          logger.info(
            { agentId: agent.id, issueId: memoryIssueId, runId },
            "bootstrap analysis context attached (first top-level CEO issue)",
          );
        }
      } catch (err) {
        logger.debug({ err, agentId: agent.id, runId }, "failed to detect bootstrap analysis context");
      }
    }
    const taskKey = deriveTaskKey(context, null);
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueAssigneeConfig = issueId
      ? await db
          .select({
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueAssigneeConfig && issueAssigneeConfig.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueAssigneeConfig.assigneeAdapterOverrides,
          )
        : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const previousSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null),
    );
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null },
    );
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace,
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    context.combyneWorkspace = {
      cwd: resolvedWorkspace.cwd,
      source: resolvedWorkspace.source,
      projectId: resolvedWorkspace.projectId,
      workspaceId: resolvedWorkspace.workspaceId,
      repoUrl: resolvedWorkspace.repoUrl,
      repoRef: resolvedWorkspace.repoRef,
    };
    context.combyneWorkspaces = resolvedWorkspace.workspaceHints;
    if (resolvedWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = resolvedWorkspace.projectId;
    }

    // Tell the agent what else is on its plate. Without this, a wake triggered
    // by one assignment leaves the adapter with `context.issueId` only and no
    // visibility into the rest of the queue — which is exactly what Chris saw
    // as "no tasks to run" in the test pilot. Capped inside the service.
    try {
      // Focus mode — defaults ON. When enabled the queue service emits a loud
      // "## 🎯 Current focus" block + directive so the model stops bleeding
      // attention across sibling issues (Round 3 item #2).
      const adapterCfgRaw = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const focusMode = adapterCfgRaw.focusMode !== false;

      // Pull a short description body for the focus-block preview. Bounded
      // inside renderFocusSection; we only fetch when a focus issue exists.
      let focusIssueBody: string | null = null;
      if (memoryIssueId && focusMode) {
        const focusRow = await db
          .select({ description: issues.description })
          .from(issues)
          .where(and(eq(issues.id, memoryIssueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);
        focusIssueBody = focusRow?.description ?? null;
      }

      const queue =
        contextProfile === "focused" && !memoryIssueId
          ? {
              items: [],
              totalOpen: 0,
              awaitingCount: 0,
              body: "",
              focusBody: "",
              digestBody: "",
              directive: null,
              focusItem: null,
              currentIssueMissing: false,
            }
          : await loadAssignedIssueQueue(db, {
              companyId: agent.companyId,
              agentId: agent.id,
              currentIssueId: memoryIssueId ?? null,
              currentIssueBody: focusIssueBody,
              focusMode,
              includeReviewIssues:
                contextProfile === "focused" ||
                run.invocationSource !== "timer" ||
                Boolean(memoryIssueId),
              limit: contextProfile === "focused" ? 100 : undefined,
            });

      if (contextProfile === "focused") {
        const focusOnlyItems = queue.focusItem ? [queue.focusItem] : [];
        context.combyneAssignedIssues = {
          ...queue,
          items: focusOnlyItems,
          totalOpen: focusOnlyItems.length,
          awaitingCount: focusOnlyItems.filter((item) => item.awaiting).length,
          body: queue.focusBody,
          digestBody: "",
        };
        queueDigestPolicy = queue.focusItem ? "omitted" : "none";
      } else {
        context.combyneAssignedIssues = queue;
        queueDigestPolicy = queue.digestBody ? "included" : "none";
      }

      if (queue.focusBody && queue.directive && memoryIssueId) {
        context.combyneFocusDirective = {
          body: queue.focusBody,
          directive: queue.directive,
          issueId: memoryIssueId,
        };
      }

      if (queue.currentIssueMissing) {
        logger.warn(
          { agentId: agent.id, runId, currentIssueId: memoryIssueId },
          "agent_queue.current_issue_missing",
        );
      }
      if (queue.focusItem) {
        logger.debug(
          {
            agentId: agent.id,
            runId,
            issueId: queue.focusItem.id,
            bodyChars: queue.focusBody.length,
            contextProfile,
          },
          "agent_queue.focus_section_rendered",
        );
      }
      if (memoryIssueId) {
        try {
          const refs = await loadIssueContextRefs(db, memoryIssueId);
          const body = renderIssueContextRefs(refs);
          if (body) {
            context.combyneIssueContextRefs = {
              body,
              refs: refs.slice(0, 12).map((ref) => ({
                kind: ref.kind,
                label: ref.label,
                rawRef: ref.rawRef,
                resolvedRef: ref.resolvedRef,
                accessibilityStatus: ref.accessibilityStatus,
              })),
            };
          }
        } catch (err) {
          logger.debug({ err, agentId: agent.id, runId, issueId: memoryIssueId }, "failed to load issue context refs");
        }
      }
      setContextPolicy(context, {
        profile: contextProfile,
        focusIssueId: memoryIssueId ?? null,
        focusIssueSource,
        queueDigest: queueDigestPolicy,
      });
    } catch (err) {
      logger.debug({ err, agentId: agent.id, runId }, "failed to load assigned issue queue");
    }

    // Surface Combyne-managed project workspaces to the adapter so it can
    // ls/read/write across them — same fix as the terminal preamble,
    // mirrored here so heartbeat runs don't ask "project not found" either.
    if (contextProfile !== "focused") {
      try {
        const overview = await loadCompanyProjectOverview(db, agent.companyId);
        if (overview.items.length > 0) {
          context.combyneCompanyProjects = overview;
          const dirs: string[] = [];
          for (const project of overview.items) {
            for (const ws of project.workspaces) {
              if (ws.cwd && !dirs.includes(ws.cwd)) dirs.push(ws.cwd);
            }
          }
          if (dirs.length > 0) context.combyneProjectWorkspaceDirs = dirs.slice(0, 10);
          setContextPolicy(context, {
            profile: contextProfile,
            focusIssueId: memoryIssueId ?? null,
            focusIssueSource,
            queueDigest: queueDigestPolicy,
          });
        }
      } catch (err) {
        logger.debug({ err, companyId: agent.companyId, runId }, "failed to load project overview");
      }
    }

    // Hire-agent playbook — fires when the current issue reads as a hire
    // request and this agent has permission to create agents. Fixes the
    // regression where a "Create a new agent" issue got "standing by —
    // nothing actionable" because the ceo-bootstrap SKILL (the only place
    // the hire flow was explained) only fires on the very first top-level
    // CEO issue.
    if (memoryIssueId) {
      try {
        const issueRow = await db
          .select({
            title: issues.title,
            description: issues.description,
          })
          .from(issues)
          .where(and(eq(issues.id, memoryIssueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);
        if (
          issueRow &&
          detectHireIntent({ title: issueRow.title, description: issueRow.description }) &&
          agentCanHire({
            id: agent.id,
            role: agent.role,
            permissions: agent.permissions as Record<string, unknown> | null,
          })
        ) {
          context.combyneHirePlaybook = {
            body: buildHirePlaybook({
              companyId: agent.companyId,
              issue: { title: issueRow.title, description: issueRow.description },
              agentName: agent.name,
            }),
            issueId: memoryIssueId,
          };
        }
      } catch (err) {
        logger.debug({ err, agentId: agent.id, runId }, "failed to build hire playbook");
      }
    }

    // Close the loop between git state and issue status: before the agent
    // says "nothing to do", let it see commits/branches that already mention
    // this issue. Best-effort; non-git workspaces degrade gracefully.
    if (memoryIssueId) {
      try {
        const issueRow = await db
          .select({ identifier: issues.identifier, title: issues.title })
          .from(issues)
          .where(and(eq(issues.id, memoryIssueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);
        if (issueRow) {
          const gitState = await inspectGitStateForIssue({
            cwd: resolvedWorkspace.cwd,
            issueIdentifier: issueRow.identifier ?? null,
            issueTitle: issueRow.title ?? "",
          });
          if (gitState) context.combyneGitState = gitState;
        }
      } catch (err) {
        logger.debug({ err, agentId: agent.id, runId }, "failed to inspect git state for issue");
      }
    }
    setContextPolicy(context, {
      profile: contextProfile,
      focusIssueId: memoryIssueId ?? null,
      focusIssueSource,
      queueDigest: queueDigestPolicy,
    });
    const runtimeSessionFallback = taskKey || resetTaskSession ? null : runtime.sessionId;
    const previousSessionDisplayId = truncateDisplayId(
      taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    const runtimeForAdapter = {
      sessionId: readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback,
      sessionParams: runtimeSessionParams,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let seq = 1;
    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";

    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          contextSnapshot: buildContextAuditSnapshot(
            run.contextSnapshot as Record<string, unknown> | null | undefined,
            context,
          ),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        companyId: run.companyId,
        agentId: run.agentId,
        runId,
      });

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, chunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, chunk);

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk,
            ts: new Date().toISOString(),
          });
        }

        const payloadChunk =
          chunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? chunk.slice(chunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : chunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== chunk.length,
          },
        });
      };
      for (const warning of runtimeWorkspaceWarnings) {
        await onLog("stderr", `[combyne] ${warning}\n`);
      }

      const config = parseObject(agent.adapterConfig);
      const mergedConfig = issueAssigneeOverrides?.adapterConfig
        ? { ...config, ...issueAssigneeOverrides.adapterConfig }
        : config;
      const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
        agent.companyId,
        mergedConfig,
      );

      // Round 3 Phase 6 PR 6.3 — pre-run summary load.
      //
      // Reads the latest standing (cross-ticket) and working (per-issue)
      // summary rows and attaches them as combyneStandingSummary /
      // combyneWorkingSummary. Also populates combyneRecentTurns with the
      // tail of un-summarized transcript so the agent sees its most recent
      // thread without re-discovering state. All three become typed sections
      // consumed by buildPreambleSectionsFromContext, so the composer owns
      // truncation — we just pre-clip the recent-turns block to a rough cap.
      const summarizerModelName = asString(
        (resolvedConfig as Record<string, unknown>).model,
        agent.adapterType,
      );

      // Round 3 Phase 6 PR 6.4 — snapshot the rolling-median calibration
      // ratio ONCE at run start so every caller (composer, shadow composer,
      // summarizer triggers, summarizer driver) applies the same correction.
      // If we re-query per call, two tokenizer calls seconds apart might
      // pick different ratios and bust the cache-prefix stability invariant.
      const modelFamily = resolveModel(summarizerModelName).family;
      const calibrationRatio = await snapshotCalibrationRatio(db, modelFamily);
      const pruningMode = resolvePruningMode();

      try {
        const cfg = agent.adapterConfig as Record<string, unknown> | null;
        const summarizerCfg = cfg && typeof cfg === "object"
          ? ((cfg as Record<string, unknown>).summarizer as Record<string, unknown> | undefined)
          : undefined;
        const summarizerEnabled = summarizerCfg?.enabled !== false;
        if (summarizerEnabled) {
          if (contextProfile !== "focused") {
            const standingLatest = await loadLatestSummary(db, {
              agentId: agent.id,
              scopeKind: "standing",
              scopeId: null,
            });
            if (standingLatest?.content) {
              context.combyneStandingSummary = {
                body: standingLatest.content,
                summaryId: standingLatest.id,
                cutoffOrdinal: Number(standingLatest.cutoffSeq),
                createdAt: standingLatest.createdAt.toISOString(),
              };
            }
          }

          if (memoryIssueId) {
            const workingLatest = await loadLatestSummary(db, {
              agentId: agent.id,
              scopeKind: "working",
              scopeId: memoryIssueId,
            });
            if (workingLatest?.content) {
              context.combyneWorkingSummary = {
                body: workingLatest.content,
                summaryId: workingLatest.id,
                issueId: memoryIssueId,
                cutoffOrdinal: Number(workingLatest.cutoffSeq),
                createdAt: workingLatest.createdAt.toISOString(),
              };
            }
          }

          // Recent raw turns since the most relevant cutoff. Prefer the
          // working cutoff when an issue is in focus (keeps the block
          // ticket-scoped); fall back to the standing cutoff.
          if (contextProfile !== "focused" || memoryIssueId) {
            const scopeForRecent: SummaryScope = memoryIssueId ? "working" : "standing";
            const recent = await unsummarizedTokensFor(db, {
              companyId: agent.companyId,
              agentId: agent.id,
              scope: scopeForRecent,
              issueId: memoryIssueId ?? null,
              model: summarizerModelName,
              calibrationRatio,
              pruningMode,
            });
            if (recent.entries.length > 0) {
              const rendered = renderRecentTurns(recent.entries, summarizerModelName, {
                maxTokens: RECENT_TURNS_MAX_TOKENS,
                calibrationRatio,
              });
              if (rendered.body) {
                context.combyneRecentTurns = {
                  body: rendered.body,
                  tokens: rendered.tokens,
                  turnCount: rendered.turnCount,
                  sinceOrdinal: recent.cutoffOrdinal,
                  scope: scopeForRecent,
                };
              }
            }
          }
        }
      } catch (err) {
        logger.debug(
          { err, agentId: agent.id, runId },
          "summarizer.preamble_load_failed",
        );
      }
      setContextPolicy(context, {
        profile: contextProfile,
        focusIssueId: memoryIssueId ?? null,
        focusIssueSource,
        queueDigest: queueDigestPolicy,
      });
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: buildContextAuditSnapshot(
            run.contextSnapshot as Record<string, unknown> | null | undefined,
            context,
          ),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, currentRun.id));

      // Round 3 Phase 5 — composer-enabled mode. Opt-in via
      // COMBYNE_CONTEXT_BUDGET_ENABLED=1. When on, the composer runs
      // BEFORE the adapter builds its prompt and writes per-section
      // token-budgeted content back into the context.combyne* fields.
      // The existing byte caps in agent-queue / memory / adapter-utils
      // stay in place as a defence-in-depth lower bound.
      const composerRef: {
        summary: BudgetSnapshotComposer | null;
        cacheHit: boolean | null;
        previousCachePrefixHash: string | null;
      } = { summary: null, cacheHit: null, previousCachePrefixHash: null };
      if (contextBudgetComposerEnabled()) {
        try {
          const modelName = asString(
            (resolvedConfig as Record<string, unknown>).model,
            agent.adapterType,
          );
          const result = composeAndApplyBudget(context, {
            adapterType: agent.adapterType,
            adapterConfig: (agent.adapterConfig ?? {}) as Record<string, unknown>,
            model: modelName,
            calibrationRatio,
          });
          if (result) {
            const cacheTrack = trackCachePrefixHit(agent.id, result.composed.cachePrefixHash);
            composerRef.summary = summarizeComposed(result.composed, result.applied);
            composerRef.cacheHit = cacheTrack.hit;
            composerRef.previousCachePrefixHash = cacheTrack.previousHash;
            logger.info(
              {
                runId: run.id,
                agentId: agent.id,
                applied: result.applied,
                skippedReason: result.skippedReason,
                totalTokens: result.composed.totalTokens,
                stableTokens: result.composed.stableTokens,
                varyTokens: result.composed.varyTokens,
                dropped: result.composed.dropped,
                truncated: result.composed.truncated,
                warnings: result.composed.warnings,
                cachePrefixHash: result.composed.cachePrefixHash.slice(0, 12),
                calibrationRatio,
                cacheHit: cacheTrack.hit,
                previousCachePrefixHash: cacheTrack.previousHash?.slice(0, 12) ?? null,
                pruningMode,
              },
              cacheTrack.hit ? "context_budget.cache_hit" : "context_budget.cache_miss",
            );
          }
        } catch (err) {
          logger.warn({ err, agentId: agent.id, runId }, "context_budget.fallback");
        }
      }

      // Round 3 Phase 3 — prompt-budget snapshot captured on the FIRST
      // adapter.invoke of the run. Telemetry-only for now: the composer
      // phase will consume this to decide truncation.
      const promptBudgetRef: { snapshot: BudgetSnapshot | null } = { snapshot: null };

      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }

        if (!promptBudgetRef.snapshot && typeof meta.prompt === "string" && meta.prompt.length > 0) {
          const modelName = asString(
            (resolvedConfig as Record<string, unknown>).model,
            agent.adapterType,
          );
          const snapshot = estimatePromptBudget(meta.prompt, modelName, {
            calibrationRatio,
          });
          if (composerRef.summary) {
            snapshot.composer = composerRef.summary;
          }
          if (composerRef.cacheHit != null) {
            snapshot.cacheHit = composerRef.cacheHit;
            snapshot.previousCachePrefixHash = composerRef.previousCachePrefixHash;
          }
          snapshot.pruningMode = pruningMode;
          snapshot.contextPolicy = {
            profile: contextProfile,
            focusIssueId: memoryIssueId ?? null,
            focusIssueSource,
            queueDigest: queueDigestPolicy,
            includedSections: contextSectionNames(context),
          };
          promptBudgetRef.snapshot = snapshot;
          await persistRunBudget(db, currentRun.id, snapshot);
          logger.debug(
            {
              runId: currentRun.id,
              agentId: agent.id,
              estimatedInputTokens: snapshot.estimatedInputTokens,
              family: snapshot.tokenizerFamily,
              promptChars: snapshot.promptChars,
            },
            "context_budget.estimated",
          );

          // Phase 4 shadow composer — compose from the section context
          // fields and compare against the adapter's actual prompt. No
          // behavior change; logged for measurement only.
          const shadow = runShadowComposer({
            context,
            adapterType: agent.adapterType,
            adapterConfig: (agent.adapterConfig ?? {}) as Record<string, unknown>,
            actualPrompt: meta.prompt,
            model: modelName,
            calibrationRatio,
          });
          if (shadow) {
            logger.info(
              {
                runId: currentRun.id,
                agentId: agent.id,
                budget: resolveContextBudgetTokens(
                  agent.adapterType,
                  (agent.adapterConfig ?? {}) as Record<string, unknown>,
                ),
                composedTokens: shadow.composed.totalTokens,
                stableTokens: shadow.composed.stableTokens,
                varyTokens: shadow.composed.varyTokens,
                actualPromptTokens: shadow.actualPromptTokens,
                deltaPct: Number((shadow.deltaPct * 100).toFixed(1)),
                bytesSaved: shadow.bytesSaved,
                dropped: shadow.composed.dropped,
                truncated: shadow.composed.truncated,
                warnings: shadow.composed.warnings,
                cachePrefixHash: shadow.composed.cachePrefixHash.slice(0, 12),
                sectionUsage: shadow.composed.usage,
              },
              "context_budget.shadow_composition",
            );
          }
        }

        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
        });
      };

      const adapter = getServerAdapter(agent.adapterType);

      // Pre-flight: if the agent's adapter depends on a CLI that isn't on the
      // PATH, fail fast with the adapter-specific install hint instead of
      // letting the adapter spawn and surface a generic "command not found"
      // error. Fixes the "adapter_failed" mystery Chris saw on pilots.
      try {
        const probes = await probeAdapterAvailability();
        const probe = probes[agent.adapterType];
        if (probe && probe.requiresCli && !probe.available) {
          const hint = probe.installHint || "Install the adapter's CLI and retry.";
          const bin = probe.binary || agent.adapterType;
          const message = `Adapter "${agent.adapterType}" requires the \`${bin}\` CLI, which was not found on PATH. ${hint}`;
          await onLog("stderr", `[combyne] ${message}\n`);
          const err = new Error(message) as Error & { code?: string };
          err.code = "adapter_cli_missing";
          throw err;
        }
      } catch (err) {
        if (err instanceof Error && (err as { code?: string }).code === "adapter_cli_missing") {
          throw err;
        }
        logger.debug({ err, adapterType: agent.adapterType }, "adapter availability probe failed");
      }

      // Self-heal the JWT secret before minting. If the server booted
      // without the local-trusted bootstrap (non-local mode, env-scrubbed
      // child, etc.), ensureLocalAgentJwtSecretAtRuntime() falls back to
      // reading the on-disk key or generates + persists one. Prevents the
      // silent-auth-failure loop Chris saw: every endpoint returning
      // "Agent authentication required" because the token was null.
      if (adapter.supportsLocalAgentJwt) {
        try {
          const minted = ensureLocalAgentJwtSecretAtRuntime();
          if (!minted) {
            logger.error(
              { companyId: agent.companyId, agentId: agent.id, runId: run.id },
              "failed to resolve or generate local agent JWT secret",
            );
          }
        } catch (err) {
          logger.error({ err, runId: run.id }, "ensureLocalAgentJwtSecretAtRuntime threw");
        }
      }
      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
        : null;
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: agent.adapterType,
          },
          "local agent jwt secret missing or invalid; running without injected COMBYNE_API_KEY",
        );
      }
      const effectiveResolvedConfig = withSmallCodingTaskControls(agent, resolvedConfig, context);
      const adapterResult = await adapter.execute({
        runId: run.id,
        agent,
        runtime: runtimeForAdapter,
        config: effectiveResolvedConfig,
        context,
        onLog,
        onMeta: onAdapterMeta,
        authToken: authToken ?? undefined,
      });
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        logSummary = await runLogStore.finalize(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";
      const cancelledError = latestRun?.error ?? "Run cancelled";

      const usageJson =
        adapterResult.usage || adapterResult.costUsd != null
          ? ({
              ...(adapterResult.usage ?? {}),
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              ...(adapterResult.billingType ? { billingType: adapterResult.billingType } : {}),
            } as Record<string, unknown>)
          : null;
      const usageForBudget = (adapterResult.usage ?? {}) as Record<string, unknown>;
      const runTokenTotal =
        asNumber(usageForBudget.inputTokens, asNumber(usageForBudget.input_tokens, 0)) +
        asNumber(usageForBudget.cachedInputTokens, asNumber(usageForBudget.cached_input_tokens, asNumber(usageForBudget.cache_read_input_tokens, 0))) +
        asNumber(usageForBudget.outputTokens, asNumber(usageForBudget.output_tokens, 0));
      const pauseForSmallTaskBudget =
        agent.adapterType === "claude_local" &&
        Boolean(readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId)) &&
        runTokenTotal >= smallTaskTokenPauseThreshold();

      // Round 3 Phase 3 — close the calibration loop. Compares our
      // pre-run estimate with the adapter-reported actual usage.inputTokens
      // so the composer phase can trust family-specific ratios.
      try {
        const actualInput = adapterResult.usage?.inputTokens ?? 0;
        const snapshot = promptBudgetRef.snapshot;
        if (snapshot && actualInput > 0) {
          await recordCalibrationSample(db, {
            runId: run.id,
            family: snapshot.tokenizerFamily,
            estimatedTokens: snapshot.estimatedInputTokens,
            actualTokens: actualInput,
          });
          if (shouldAlertDivergence(snapshot.estimatedInputTokens, actualInput)) {
            logger.warn(
              {
                runId: run.id,
                agentId: agent.id,
                estimated: snapshot.estimatedInputTokens,
                actual: actualInput,
                family: snapshot.tokenizerFamily,
              },
              "tokenizer.calibration_diverged",
            );
          }
        }
      } catch (err) {
        logger.debug({ err, runId: run.id }, "context_budget.calibration_hook_failed");
      }

      await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : outcome === "cancelled"
              ? cancelledError
            : adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
        errorCode:
          outcome === "timed_out"
            ? "timeout"
            : outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? (adapterResult.errorCode ?? "adapter_failed")
                : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: adapterResult.resultJson ?? null,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: outcome === "cancelled" ? cancelledError : adapterResult.errorMessage ?? null,
      });

      const finalizedRun = await getRun(run.id);
      if (finalizedRun) {
        if (adapterResult.resultJson || stdoutExcerpt) {
          try {
            await appendTranscriptEntry(db, {
              companyId: finalizedRun.companyId,
              agentId: finalizedRun.agentId,
              runId: finalizedRun.id,
              issueId: resolveRunIssueId(finalizedRun),
              seq: seq++,
              role: "assistant",
              contentKind: "adapter.result",
              content: {
                resultJson: (adapterResult.resultJson ?? null) as Record<string, unknown> | null,
                stdoutExcerpt: stdoutExcerpt || null,
                usage: (adapterResult.usage ?? null) as Record<string, unknown> | null,
              },
            });
          } catch (err) {
            logger.debug({ err, runId: finalizedRun.id }, "transcript final append failed");
          }
        }
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
          },
        });
        await releaseIssueExecutionAndPromote(finalizedRun);
        void summarizeRunAndPersist(db, {
          runId: finalizedRun.id,
          companyId: finalizedRun.companyId,
          agentId: finalizedRun.agentId,
          issueId: resolveRunIssueId(finalizedRun),
        });

        // Round 3 Phase 6 PR 6.3 — post-run summarizer enqueue.
        //
        // Fire-and-forget: the queue does its own coalescing, cooldown, and
        // quarantine handling, so repeated enqueues within ~10 min are cheap
        // no-ops. We skip only the clearly-useless cases here (disabled,
        // missing driver, below trigger, already quarantined).
        void (async () => {
          const queue = getSummarizerQueue();
          if (!queue) return;

          const cfgRaw = agent.adapterConfig as Record<string, unknown> | null;
          const summarizerCfg = cfgRaw && typeof cfgRaw === "object"
            ? ((cfgRaw as Record<string, unknown>).summarizer as Record<string, unknown> | undefined)
            : undefined;
          if (summarizerCfg?.enabled === false) return;

          const configuredModel =
            typeof summarizerCfg?.model === "string" && summarizerCfg.model.length > 0
              ? (summarizerCfg.model as string)
              : null;
          const summarizerModel = configuredModel ?? summarizerModelName;
          const minStanding =
            typeof summarizerCfg?.minTriggerTokensStanding === "number" &&
            summarizerCfg.minTriggerTokensStanding > 0
              ? Math.floor(summarizerCfg.minTriggerTokensStanding as number)
              : DEFAULT_MIN_TRIGGER_TOKENS_STANDING;
          const minWorking =
            typeof summarizerCfg?.minTriggerTokensWorking === "number" &&
            summarizerCfg.minTriggerTokensWorking > 0
              ? Math.floor(summarizerCfg.minTriggerTokensWorking as number)
              : DEFAULT_MIN_TRIGGER_TOKENS_WORKING;
          const maxCostUsd =
            typeof summarizerCfg?.maxCostUsd === "number" && summarizerCfg.maxCostUsd > 0
              ? (summarizerCfg.maxCostUsd as number)
              : undefined;

          const finalizedIssueId = resolveRunIssueId(finalizedRun);

          // Standing scope — every successful run is an opportunity to
          // refresh cross-ticket knowledge.
          try {
            if (
              !(await isQuarantined(db, {
                agentId: agent.id,
                scopeKind: "standing",
                scopeId: null,
              }))
            ) {
              const { tokens } = await unsummarizedTokensFor(db, {
                companyId: agent.companyId,
                agentId: agent.id,
                scope: "standing",
                model: summarizerModel,
                calibrationRatio,
              });
              if (tokens >= minStanding) {
                const result = await queue.maybeEnqueue(db, {
                  companyId: agent.companyId,
                  agentId: agent.id,
                  scope: "standing",
                  adapterModel: summarizerModel,
                  summarizerModel: configuredModel,
                  minTriggerTokens: minStanding,
                  maxCostUsd,
                  calibrationRatio,
                });
                logger.debug(
                  {
                    agentId: agent.id,
                    runId: finalizedRun.id,
                    scope: "standing",
                    tokens,
                    status: result.status,
                  },
                  "summarizer.enqueue_attempted",
                );
              }
            }
          } catch (err) {
            logger.debug({ err, agentId: agent.id, runId: finalizedRun.id }, "summarizer.standing_enqueue_failed");
          }

          // Working scope — only when this run had an issue in focus.
          if (finalizedIssueId) {
            try {
              if (
                !(await isQuarantined(db, {
                  agentId: agent.id,
                  scopeKind: "working",
                  scopeId: finalizedIssueId,
                }))
              ) {
                const { tokens } = await unsummarizedTokensFor(db, {
                  companyId: agent.companyId,
                  agentId: agent.id,
                  scope: "working",
                  issueId: finalizedIssueId,
                  model: summarizerModel,
                  calibrationRatio,
                });
                if (tokens >= minWorking) {
                  const result = await queue.maybeEnqueue(db, {
                    companyId: agent.companyId,
                    agentId: agent.id,
                    scope: "working",
                    issueId: finalizedIssueId,
                    adapterModel: summarizerModel,
                    summarizerModel: configuredModel,
                    minTriggerTokens: minWorking,
                    maxCostUsd,
                    calibrationRatio,
                  });
                  logger.debug(
                    {
                      agentId: agent.id,
                      runId: finalizedRun.id,
                      issueId: finalizedIssueId,
                      scope: "working",
                      tokens,
                      status: result.status,
                    },
                    "summarizer.enqueue_attempted",
                  );
                }
              }
            } catch (err) {
              logger.debug(
                { err, agentId: agent.id, runId: finalizedRun.id, issueId: finalizedIssueId },
                "summarizer.working_enqueue_failed",
              );
            }
          }
        })();

        const runIssueId = resolveRunIssueId(finalizedRun);
        // Auto-surface any numbered / bulleted questions the agent buried
        // in its output as structured `kind="question"` comments, so the
        // Reply-and-Wake card renders each with its own answer input
        // instead of leaving them as prose in the plan document. This must
        // run before small-task pause handling so the pause note cannot hide
        // the actual blocker from the issue page.
        let questionResult: ExtractedQuestionsResult | null = null;
        const resultText =
          adapterResult.resultJson && typeof adapterResult.resultJson === "object"
            ? JSON.stringify(adapterResult.resultJson)
            : "";
        const sourceText = [stdoutExcerpt, resultText].filter(Boolean).join("\n\n");
        const latestUserFacingAgentMessage = deriveLatestUserFacingAgentMessage(sourceText, adapterResult.resultJson);
        if (runIssueId && outcome === "succeeded") {
          if (sourceText.length > 0) {
            try {
              questionResult = await extractAndPostQuestions(db, {
                companyId: finalizedRun.companyId,
                agentId: finalizedRun.agentId,
                issueId: runIssueId,
                sourceText,
              });
              if ((questionResult.posted > 0 || questionResult.skippedExisting > 0) && latestUserFacingAgentMessage) {
                await issueService(db).update(runIssueId, {
                  latestUserFacingAgentMessage,
                });
              }
            } catch (err) {
              logger.debug(
                { err, runId: finalizedRun.id, issueId: runIssueId },
                "question-extractor failed",
              );
            }
          }
        }
        if (pauseForSmallTaskBudget && runIssueId) {
          try {
            const issueRow = await db
              .select({ status: issues.status })
              .from(issues)
              .where(and(eq(issues.id, runIssueId), eq(issues.companyId, finalizedRun.companyId)))
              .then((rows) => rows[0] ?? null);
            if (issueRow && issueRow.status !== "done" && issueRow.status !== "cancelled") {
              await db.insert(issueComments).values({
                companyId: finalizedRun.companyId,
                issueId: runIssueId,
                authorAgentId: null,
                authorUserId: null,
                body:
                  `Run paused after crossing the small-task token threshold. ` +
                  `Reported tokens: ${runTokenTotal}; threshold: ${smallTaskTokenPauseThreshold()}. ` +
                  `Review the run before waking the agent again or raise the per-agent limit for this issue.`,
              });
              await issueService(db).update(runIssueId, {
                status: "awaiting_user",
                latestUserFacingAgentMessage:
                  latestUserFacingAgentMessage ??
                  `Run paused after crossing the small-task token threshold. Reported tokens: ${runTokenTotal}; threshold: ${smallTaskTokenPauseThreshold()}.`,
              });
            }
          } catch (err) {
            logger.debug({ err, runId: finalizedRun.id, issueId: runIssueId }, "small-task budget pause failed");
          }
        }

        if (runIssueId && outcome === "succeeded" && !pauseForSmallTaskBudget) {
          await autoCloseIssueAfterSuccessfulRun(db, {
            companyId: finalizedRun.companyId,
            agentId: finalizedRun.agentId,
            runId: finalizedRun.id,
            issueId: runIssueId,
            questionResult,
          }).catch((err) => {
            logger.debug(
              { err, runId: finalizedRun.id, issueId: runIssueId },
              "successful-run auto-close failed",
            );
          });
        }
      }

      if (finalizedRun) {
        await updateRuntimeState(agent, finalizedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        });
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await clearTaskSessions(agent.companyId, agent.id, {
              taskKey,
              adapterType: agent.adapterType,
            });
          } else {
            await upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: agent.adapterType,
              taskKey,
              sessionParamsJson: nextSessionState.params,
              sessionDisplayId: nextSessionState.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
      }
      await finalizeAgentStatus(agent.id, outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown adapter failure";
      logger.error({ err, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const errorCode =
        err instanceof Error && typeof (err as { code?: string }).code === "string"
          ? ((err as { code?: string }).code ?? "adapter_failed")
          : "adapter_failed";
      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode,
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      });

      if (failedRun) {
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });
        await releaseIssueExecutionAndPromote(failedRun);

        await updateRuntimeState(agent, failedRun, {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        }, {
          legacySessionId: runtimeForAdapter.sessionId,
        });

        if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey,
            sessionParamsJson: previousSessionParams,
            sessionDisplayId: previousSessionDisplayId,
            lastRunId: failedRun.id,
            lastError: message,
          });
        }
      }

      await finalizeAgentStatus(agent.id, "failed");
    } finally {
      await startNextQueuedRunForAgent(agent.id);
    }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    const promotedRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore = await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        return newRun;
      }
    });

    if (!promotedRun) return;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    const issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);
    const writeSkippedRequest = async (reason: string) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });
    };

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);
      const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            return { kind: "deferred" as const };
          }

          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_deferred",
            payload: deferredPayload,
            status: "deferred_issue_execution",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          });

          return { kind: "deferred" as const };
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "queued",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

    const newRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId,
        invocationSource: source,
        triggerDetail,
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot,
        sessionIdBefore: sessionBefore,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({
        runId: newRun.id,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  return {
    list: (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select()
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      if (limit) {
        return query.limit(limit);
      }
      return query;
    },

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reapOrphanedRuns,
    reapOrphanedIssueLocks,
    forceUnlockIssue,

    tickTimers: async (now = new Date()) => {
      const allAgents = await db.select().from(agents);
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    cancelRun: async (runId: string) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (run.status !== "running" && run.status !== "queued") return run;

      const running = runningProcesses.get(run.id);
      if (running) {
        running.child.kill("SIGTERM");
        const graceMs = Math.max(1, running.graceSec) * 1000;
        setTimeout(() => {
          if (!running.child.killed) {
            running.child.kill("SIGKILL");
          }
        }, graceMs);
      }

      const cancelled = await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: "Cancelled by control plane",
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: "Cancelled by control plane",
      });

      if (cancelled) {
        await appendRunEvent(cancelled, 1, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: "run cancelled",
        });
        await releaseIssueExecutionAndPromote(cancelled);
      }

      runningProcesses.delete(run.id);
      await finalizeAgentStatus(run.agentId, "cancelled");
      await startNextQueuedRunForAgent(run.agentId);
      return cancelled;
    },

    cancelActiveForAgent: async (agentId: string) => {
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

      for (const run of runs) {
        await setRunStatus(run.id, "cancelled", {
          finishedAt: new Date(),
          error: "Cancelled due to agent pause",
          errorCode: "cancelled",
        });

        await setWakeupStatus(run.wakeupRequestId, "cancelled", {
          finishedAt: new Date(),
          error: "Cancelled due to agent pause",
        });

        const running = runningProcesses.get(run.id);
        if (running) {
          running.child.kill("SIGTERM");
          runningProcesses.delete(run.id);
        }
        await releaseIssueExecutionAndPromote(run);
      }

      return runs.length;
    },

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
