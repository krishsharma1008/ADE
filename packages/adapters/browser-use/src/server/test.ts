import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@combyne/adapter-utils";
import {
  asString,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@combyne/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const pythonCommand = asString(config.pythonCommand, "python3");
  const cwd = asString(config.cwd, process.cwd());

  // Check working directory
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "browser_use_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "browser_use_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  // Check Python is available
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureCommandResolvable(pythonCommand, cwd, runtimeEnv);
    checks.push({
      code: "browser_use_python_resolvable",
      level: "info",
      message: `Python command is executable: ${pythonCommand}`,
    });
  } catch (err) {
    checks.push({
      code: "browser_use_python_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Python command is not executable",
      detail: pythonCommand,
      hint: `Install Python 3 or set pythonCommand in adapter config to the correct path.`,
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // Check Python version
  const versionProbe = await runChildProcess(
    `browser-use-envtest-version-${Date.now()}`,
    pythonCommand,
    ["--version"],
    {
      cwd,
      env,
      timeoutSec: 10,
      graceSec: 3,
      onLog: async () => {},
    },
  );
  const versionOutput = firstNonEmptyLine(versionProbe.stdout) || firstNonEmptyLine(versionProbe.stderr);
  if ((versionProbe.exitCode ?? 1) === 0 && versionOutput) {
    checks.push({
      code: "browser_use_python_version",
      level: "info",
      message: `Python version: ${versionOutput}`,
    });
  } else {
    checks.push({
      code: "browser_use_python_version_unknown",
      level: "warn",
      message: "Could not determine Python version.",
      hint: `Run \`${pythonCommand} --version\` manually to verify.`,
    });
  }

  // Check browser-use is installed
  const browserUseProbe = await runChildProcess(
    `browser-use-envtest-import-${Date.now()}`,
    pythonCommand,
    ["-c", "import browser_use; print(browser_use.__version__)"],
    {
      cwd,
      env,
      timeoutSec: 15,
      graceSec: 3,
      onLog: async () => {},
    },
  );
  const browserUseVersion = firstNonEmptyLine(browserUseProbe.stdout);
  if ((browserUseProbe.exitCode ?? 1) === 0 && browserUseVersion) {
    checks.push({
      code: "browser_use_package_installed",
      level: "info",
      message: `browser-use is installed (version ${browserUseVersion}).`,
    });
  } else {
    const detail = firstNonEmptyLine(browserUseProbe.stderr);
    checks.push({
      code: "browser_use_package_missing",
      level: "error",
      message: "browser-use Python package is not installed.",
      detail: detail || undefined,
      hint: `Install with: ${pythonCommand} -m pip install browser-use`,
    });
  }

  // Check playwright is installed
  const playwrightProbe = await runChildProcess(
    `browser-use-envtest-playwright-${Date.now()}`,
    pythonCommand,
    ["-c", "from playwright.sync_api import sync_playwright; print('ok')"],
    {
      cwd,
      env,
      timeoutSec: 15,
      graceSec: 3,
      onLog: async () => {},
    },
  );
  if ((playwrightProbe.exitCode ?? 1) === 0) {
    checks.push({
      code: "browser_use_playwright_installed",
      level: "info",
      message: "Playwright Python package is installed.",
    });
  } else {
    const detail = firstNonEmptyLine(playwrightProbe.stderr);
    checks.push({
      code: "browser_use_playwright_missing",
      level: "error",
      message: "Playwright Python package is not installed or browsers are not set up.",
      detail: detail || undefined,
      hint: `Install with: ${pythonCommand} -m pip install playwright && ${pythonCommand} -m playwright install`,
    });
  }

  // Check LLM provider package
  const llmProvider = asString(config.llmProvider, "openai");
  const llmPkgName = llmProvider === "anthropic" ? "langchain_anthropic" : "langchain_openai";
  const llmProbe = await runChildProcess(
    `browser-use-envtest-llm-${Date.now()}`,
    pythonCommand,
    ["-c", `import ${llmPkgName}; print('ok')`],
    {
      cwd,
      env,
      timeoutSec: 10,
      graceSec: 3,
      onLog: async () => {},
    },
  );
  if ((llmProbe.exitCode ?? 1) === 0) {
    checks.push({
      code: "browser_use_llm_package_installed",
      level: "info",
      message: `LLM provider package ${llmPkgName} is installed.`,
    });
  } else {
    checks.push({
      code: "browser_use_llm_package_missing",
      level: "warn",
      message: `LLM provider package ${llmPkgName} is not installed.`,
      hint: `Install with: ${pythonCommand} -m pip install ${llmPkgName.replace("_", "-")}`,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
