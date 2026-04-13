import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@combyne/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  buildCombyneEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@combyne/adapter-utils/server-utils";
import {
  parseBrowserUseOutput,
} from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the bundled Python runner script path.
 * In development: src/server/ -> ../../scripts/
 * In published dist: dist/server/ -> ../../scripts/
 */
function resolveRunnerScript(): string {
  const candidates = [
    path.resolve(__moduleDir, "../../scripts/run_browser_use.py"),
    path.resolve(__moduleDir, "../../../scripts/run_browser_use.py"),
  ];
  return candidates[0]!;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  const pythonCommand = asString(config.pythonCommand, "python3");
  const browserType = asString(config.browserType, "chromium");
  const headless = asBoolean(config.headless, true);
  const model = asString(config.model, "gpt-4o");
  const apiKey = asString(config.apiKey, "");
  const llmProvider = asString(config.llmProvider, "openai");
  const maxSteps = asNumber(config.maxSteps, 50);
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const graceSec = asNumber(config.graceSec, 20);

  const promptTemplate = asString(
    config.promptTemplate,
    "{{context.prompt}}",
  );

  const workspaceContext = parseObject(context.combyneWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Build environment
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildCombyneEnv(agent) };
  env.COMBYNE_RUN_ID = runId;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Pass API key via environment if configured
  if (apiKey) {
    if (llmProvider === "anthropic") {
      env.ANTHROPIC_API_KEY = apiKey;
    } else {
      env.OPENAI_API_KEY = apiKey;
    }
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(pythonCommand, cwd, runtimeEnv);

  // Build task prompt
  const task = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });

  // Build stdin config for the Python script
  const pythonConfig = JSON.stringify({
    task,
    model,
    llmProvider,
    apiKey: apiKey || undefined,
    browserType,
    headless,
    maxSteps,
  });

  const runnerScript = resolveRunnerScript();

  // Verify runner script exists
  try {
    await fs.access(runnerScript);
  } catch {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Browser-use runner script not found at ${runnerScript}`,
      errorCode: "runner_script_missing",
    };
  }

  const args = [runnerScript];

  if (onMeta) {
    await onMeta({
      adapterType: "browser_use",
      command: pythonCommand,
      cwd,
      commandArgs: args,
      commandNotes: [
        "Runs browser-use Python agent via stdin JSON configuration.",
        `Browser: ${browserType}, headless: ${headless}, model: ${model} (${llmProvider})`,
      ],
      env: redactEnvForLogs(env),
      prompt: task,
      context,
    });
  }

  const proc = await runChildProcess(runId, pythonCommand, args, {
    cwd,
    env,
    stdin: pythonConfig,
    timeoutSec,
    graceSec,
    onLog,
  });

  const parsed = parseBrowserUseOutput(proc.stdout);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
    };
  }

  if (!parsed.resultEvent) {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        stderrLine
          ? `Browser-use exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
          : `Browser-use exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  const isError = parsed.resultEvent.is_error === true;
  const resultText = asString(parsed.resultEvent.result, "");
  const subtype = asString(parsed.resultEvent.subtype, "");

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: isError ? resultText || `Browser-use failed: ${subtype}` : null,
    errorCode: isError ? "browser_use_error" : null,
    provider: llmProvider || null,
    model,
    resultJson: parsed.resultEvent,
    summary: isError ? "" : resultText,
  };
}
