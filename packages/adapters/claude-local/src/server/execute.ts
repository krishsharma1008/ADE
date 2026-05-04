import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@combyne/adapter-utils";
import type { RunProcessResult } from "@combyne/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildCombyneEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@combyne/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const COMBYNE_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills"),         // published: <pkg>/dist/server/ -> <pkg>/skills/
  path.resolve(__moduleDir, "../../../../../skills"), // dev: src/server/ -> repo root/skills/
];

async function resolveCombyneSkillsDir(): Promise<string | null> {
  if (process.env.COMBYNE_SKILLS_DIR) {
    const isDir = await fs.stat(process.env.COMBYNE_SKILLS_DIR).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return process.env.COMBYNE_SKILLS_DIR;
  }
  for (const candidate of COMBYNE_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

/**
 * Create a tmpdir with `.claude/skills/` containing symlinks to skills from
 * the repo's `skills/` directory, so `--add-dir` makes Claude Code discover
 * them as proper registered skills.
 */
async function buildSkillsDir(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const skillsDir = await resolveCombyneSkillsDir();
  if (!skillsDir) return tmp;
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await fs.symlink(
        path.join(skillsDir, entry.name),
        path.join(target, entry.name),
      );
    }
  }
  return tmp;
}

async function buildMergeGuardDir(runId: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-merge-guard-"));
  const script = (tool: "gh" | "git") => `#!/usr/bin/env bash
set -euo pipefail
COMBYNE_GUARD_DIR=${JSON.stringify(tmp)}
tool=${JSON.stringify(tool)}
if [[ "$tool" == "gh" ]]; then
  if [[ "\${1:-}" == "pr" && "\${2:-}" == "merge" ]]; then
    echo "[combyne] Blocked gh pr merge. Request merge from the Combyne dashboard PR panel after checks pass." >&2
    exit 78
  fi
  if [[ "$*" == *"/pulls/"*"/merge"* ]]; then
    echo "[combyne] Blocked direct GitHub pull merge API call. Request dashboard merge instead." >&2
    exit 78
  fi
fi
if [[ "$tool" == "git" && "\${1:-}" == "merge" ]]; then
  for arg in "$@"; do
    case "$arg" in
      main|master|develop|development|origin/main|origin/master|origin/develop|origin/development)
        echo "[combyne] Blocked direct git merge into a protected base branch. Request dashboard merge instead." >&2
        exit 78
        ;;
    esac
  done
fi
export PATH="\${PATH#$COMBYNE_GUARD_DIR:}"
command "$tool" "$@"
`;
  for (const tool of ["gh", "git"] as const) {
    const target = path.join(tmp, tool);
    await fs.writeFile(target, script(tool), "utf8");
    await fs.chmod(target, 0o755);
  }
  await fs.writeFile(path.join(tmp, "README.txt"), `Combyne merge command guard for run ${runId}\n`, "utf8");
  return tmp;
}

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface ClaudeRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" {
  // Claude uses API-key auth when ANTHROPIC_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.combyneWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceHints = Array.isArray(context.combyneWorkspaces)
    ? context.combyneWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.COMBYNE_API_KEY === "string" && envConfig.COMBYNE_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildCombyneEnv(agent) };
  env.COMBYNE_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) {
    env.COMBYNE_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.COMBYNE_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.COMBYNE_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.COMBYNE_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.COMBYNE_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.COMBYNE_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (effectiveWorkspaceCwd) {
    env.COMBYNE_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.COMBYNE_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceId) {
    env.COMBYNE_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.COMBYNE_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.COMBYNE_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceHints.length > 0) {
    env.COMBYNE_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.COMBYNE_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Combyne work.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const commandNotes = instructionsFilePath
    ? [
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      ]
    : [];

  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  const billingType = resolveClaudeBillingType(env);
  const skillsDir = await buildSkillsDir();
  const mergeGuardDir = await buildMergeGuardDir(runId);
  const pathEnv = ensurePathInEnv({ ...process.env, ...env });
  env.PATH = `${mergeGuardDir}:${pathEnv.PATH ?? pathEnv.Path ?? ""}`;

  // When instructionsFilePath is configured, create a combined temp file that
  // includes both the file content and the path directive, so we only need
  // --append-system-prompt-file (Claude CLI forbids using both flags together).
  let effectiveInstructionsFilePath = instructionsFilePath;
  if (instructionsFilePath) {
    const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
    const pathDirective = `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
    const combinedPath = path.join(skillsDir, "agent-instructions.md");
    await fs.writeFile(combinedPath, instructionsContent + pathDirective, "utf-8");
    effectiveInstructionsFilePath = combinedPath;
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stderr",
      `[combyne] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  const renderedPrompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });
  const preambleSegments: string[] = [];

  // Focus directive — Round 3 item #2. When the wake has an active focus
  // issue, the loudest "work on THIS one" block comes before everything else
  // so the model doesn't bleed attention across sibling issues in the queue.
  const focusDirective = parseObject(context.combyneFocusDirective);
  const focusDirectiveBody = asString(focusDirective.body, "").trim();
  if (focusDirectiveBody.length > 0) {
    preambleSegments.push(focusDirectiveBody);
  }

  const bootstrap = parseObject(context.combyneBootstrapAnalysis);
  const bootstrapPreamble = asString(bootstrap.preamble, "").trim();
  if (bootstrapPreamble.length > 0) {
    preambleSegments.push(bootstrapPreamble);
  }
  const handoff = parseObject(context.combyneHandoffBrief);
  const handoffBrief = asString(handoff.brief, "").trim();
  if (handoffBrief.length > 0) {
    preambleSegments.push(`# Handoff brief from prior agent\n\n${handoffBrief}`);
  }
  const memory = parseObject(context.combyneMemoryPreamble);
  const memoryBody = asString(memory.body, "").trim();
  if (memoryBody.length > 0) {
    preambleSegments.push(`# Recent memory\n\n${memoryBody}`);
  }
  const longTermMemory = parseObject(context.combyneLongTermMemoryPreamble);
  const longTermMemoryBody = asString(longTermMemory.body, "").trim();
  if (longTermMemoryBody.length > 0) {
    preambleSegments.push(`# Long-term company memory\n\n${longTermMemoryBody}`);
  }
  const acceptedWork = parseObject(context.combyneAcceptedWorkBrief);
  const acceptedWorkBody = asString(acceptedWork.body, "").trim();
  if (acceptedWorkBody.length > 0) {
    preambleSegments.push(`# Accepted work memory task\n\n${acceptedWorkBody}`);
  }
  const assigned = parseObject(context.combyneAssignedIssues);
  // When focus directive is present the focus block is already rendered above;
  // use digestBody (other issues only) to avoid duplicating the focus header.
  const digestBody = asString(assigned.digestBody, "").trim();
  const legacyBody = asString(assigned.body, "").trim();
  const queueBody = focusDirectiveBody.length > 0 ? digestBody : legacyBody;
  if (queueBody.length > 0) {
    preambleSegments.push(`# Your current task queue\n\n${queueBody}`);
  }
  const gitState = parseObject(context.combyneGitState);
  const gitSummary = asString(gitState.summary, "").trim();
  if (gitSummary.length > 0) {
    preambleSegments.push(`# Workspace git state\n\n${gitSummary}`);
  }
  const companyProjects = parseObject(context.combyneCompanyProjects);
  const projectsBody = asString(companyProjects.body, "").trim();
  if (projectsBody.length > 0) {
    preambleSegments.push(`# Company projects\n\n${projectsBody}`);
  }
  const hirePlaybook = parseObject(context.combyneHirePlaybook);
  const hireBody = asString(hirePlaybook.body, "").trim();
  if (hireBody.length > 0) {
    preambleSegments.push(hireBody);
  }
  const prompt =
    preambleSegments.length > 0
      ? `${preambleSegments.join("\n\n---\n\n")}\n\n---\n\n${renderedPrompt}`
      : renderedPrompt;

  const buildClaudeArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (chrome) args.push("--chrome");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (effectiveInstructionsFilePath) {
      args.push("--append-system-prompt-file", effectiveInstructionsFilePath);
    }
    args.push("--add-dir", skillsDir);
    // Expose every Combyne-managed project workspace to Claude as an
    // additional allowed directory. Mirrors the interactive-terminal fix
    // so heartbeat runs don't come back with "project not found" when the
    // user has wired the workspace on the Projects page.
    const projectDirs = Array.isArray(context.combyneProjectWorkspaceDirs)
      ? context.combyneProjectWorkspaceDirs.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
    for (const dir of projectDirs) {
      args.push("--add-dir", dir);
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildClaudeArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command,
        cwd,
        commandArgs: args,
        commandNotes,
        env: redactEnvForLogs(env),
        prompt,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onLog,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await onLog(
        "stderr",
        `[combyne] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
    fs.rm(mergeGuardDir, { recursive: true, force: true }).catch(() => {});
  }
}
