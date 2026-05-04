import { execFile as nodeExecFile } from "node:child_process";
import path from "node:path";
import type {
  GitHubCheckRun,
  QaCommandProfile,
  QaDeviceDiscoveryDiagnostics,
  QaDeviceRegister,
  QaParserType,
  QaRunnerType,
} from "@combyne/shared";

const PASSING_CHECK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

export interface QaRunnerCommand {
  command: string;
  cwd: string | null;
  timeoutSec: number;
  env: Record<string, string>;
  artifactsPath: string | null;
  notes: string[];
}

export interface ParsedJUnitResult {
  title: string;
  status: "passed" | "failed" | "skipped";
  failureReason: string | null;
  durationMs: number | null;
}

export interface AndroidDiscoveryInput {
  workerId?: string;
  env?: NodeJS.ProcessEnv;
  execFile?: (
    file: string,
    args: string[],
    options: { timeout: number; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface AndroidDiscoveryResult {
  devices: QaDeviceRegister[];
  diagnostics: QaDeviceDiscoveryDiagnostics;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

export async function discoverLocalAndroidEmulators(input: AndroidDiscoveryInput = {}): Promise<AndroidDiscoveryResult> {
  const env = input.env ?? process.env;
  const execFile = input.execFile ?? execFilePromise;
  const workerId = input.workerId?.trim() || env.COMBYNE_QA_WORKER_ID || "qa-worker-local";
  const diagnostics: QaDeviceDiscoveryDiagnostics = {
    emulatorAvailable: false,
    adbAvailable: false,
    avdNames: [],
    runningDevices: [],
    warnings: [],
  };
  const devices = new Map<string, QaDeviceRegister>();

  const emulator = await firstWorkingCommand(emulatorCandidates(env), ["-list-avds"], execFile, env);
  if (emulator) {
    diagnostics.emulatorAvailable = true;
    diagnostics.avdNames = emulator.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const avdName of diagnostics.avdNames) {
      devices.set(`avd:${avdName}`, {
        workerId,
        name: avdName,
        kind: "android_emulator",
        platform: "android",
        healthStatus: "unknown",
        capabilities: {
          androidSdk: true,
          avdAvailable: true,
          emulatorFirst: true,
          frameworks: ["maestro", "appium", "detox", "espresso", "custom"],
          discoverySource: "emulator -list-avds",
        },
      });
    }
  } else {
    diagnostics.warnings.push("Android emulator binary not found. Set ANDROID_HOME/ANDROID_SDK_ROOT or add emulator to PATH.");
  }

  const adb = await firstWorkingCommand(adbCandidates(env), ["devices", "-l"], execFile, env);
  if (adb) {
    diagnostics.adbAvailable = true;
    const running = parseAdbDevices(adb.stdout);
    diagnostics.runningDevices = running.map((device) => device.serial);
    for (const device of running) {
      devices.set(`adb:${device.serial}`, {
        workerId,
        name: device.model ?? device.serial,
        kind: "android_emulator",
        platform: "android",
        healthStatus: device.status === "device" ? "healthy" : "unhealthy",
        capabilities: {
          androidSdk: true,
          running: device.status === "device",
          adbSerial: device.serial,
          adbStatus: device.status,
          model: device.model,
          emulatorFirst: true,
          frameworks: ["maestro", "appium", "detox", "espresso", "custom"],
          discoverySource: "adb devices -l",
        },
      });
    }
  } else {
    diagnostics.warnings.push("ADB binary not found. Set ANDROID_HOME/ANDROID_SDK_ROOT or add adb to PATH.");
  }

  if (devices.size === 0 && diagnostics.emulatorAvailable) {
    diagnostics.warnings.push("Android SDK was found, but no AVDs or running emulator devices were detected.");
  }

  return { devices: Array.from(devices.values()), diagnostics };
}

export function buildQaRunnerCommand(input: {
  runnerType: QaRunnerType | string;
  commandProfile?: QaCommandProfile | Record<string, unknown> | null;
}): QaRunnerCommand {
  const profile = (input.commandProfile ?? {}) as QaCommandProfile;
  const timeoutSec = Math.max(1, Math.min(Number(profile.timeoutSec ?? 1800), 86_400));
  const notes: string[] = [];
  let command = profile.command?.trim() ?? "";

  if (!command) {
    switch (input.runnerType) {
      case "android_emulator":
        command = profile.testPath
          ? `maestro test ${shellQuote(profile.testPath)}`
          : "maestro test .maestro";
        notes.push("Defaulted Android emulator runner to Maestro-compatible command.");
        break;
      case "rest_assured":
      case "lender_automated":
        command = "./gradlew test";
        notes.push("Defaulted Java API runner to Gradle test. Override commandProfile.command for Maven or service tasks.");
        break;
      case "github_ci_api":
        command = "github-checks";
        notes.push("GitHub CI/API runner reads provider checks and does not execute a local command.");
        break;
      case "playwright":
        command = "pnpm test:e2e";
        break;
      case "selenium":
        command = "cd tests/selenium && pnpm test";
        break;
      default:
        command = "echo \"Configure commandProfile.command for this QA suite\"";
        notes.push("No default command exists for custom_command.");
    }
  }

  return {
    command,
    cwd: profile.cwd ?? null,
    timeoutSec,
    env: asStringRecord(profile.env),
    artifactsPath: profile.artifactsPath ?? null,
    notes,
  };
}

export function parseJUnitXml(xml: string): ParsedJUnitResult[] {
  const results: ParsedJUnitResult[] = [];
  const caseRegex = /<testcase\b([^>]*)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
  let match: RegExpExecArray | null;
  while ((match = caseRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1] ?? match[2] ?? "");
    const body = match[3] ?? "";
    const className = attrs.classname ? `${attrs.classname}.` : "";
    const title = `${className}${attrs.name ?? "unnamed test"}`;
    const failure = body.match(/<(failure|error)\b[^>]*>([\s\S]*?)<\/\1>/);
    const skipped = /<skipped\b/.test(body);
    const seconds = attrs.time ? Number(attrs.time) : NaN;
    results.push({
      title,
      status: failure ? "failed" : skipped ? "skipped" : "passed",
      failureReason: failure ? stripXml(failure[2] ?? "").slice(0, 4000) : null,
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    });
  }
  return results;
}

export function statusFromGitHubChecks(checks: GitHubCheckRun[], namePattern?: string | null): {
  status: "passed" | "failed" | "blocked";
  results: ParsedJUnitResult[];
} {
  const pattern = namePattern ? new RegExp(namePattern, "i") : null;
  const selected = pattern ? checks.filter((check) => pattern.test(check.name)) : checks;
  if (selected.length === 0) {
    return {
      status: "blocked",
      results: [{ title: "GitHub checks", status: "failed", failureReason: "No matching GitHub checks found", durationMs: null }],
    };
  }
  const pending = selected.filter((check) => check.status !== "completed");
  const failed = selected.filter(
    (check) =>
      check.status === "completed" &&
      !PASSING_CHECK_CONCLUSIONS.has(String(check.conclusion ?? "").toLowerCase()),
  );
  return {
    status: pending.length > 0 ? "blocked" : failed.length > 0 ? "failed" : "passed",
    results: selected.map((check) => ({
      title: check.name,
      status:
        check.status !== "completed"
          ? "failed"
          : PASSING_CHECK_CONCLUSIONS.has(String(check.conclusion ?? "").toLowerCase())
            ? "passed"
            : "failed",
      failureReason:
        check.status !== "completed"
          ? `Check is ${check.status}`
          : PASSING_CHECK_CONCLUSIONS.has(String(check.conclusion ?? "").toLowerCase())
            ? null
            : `Conclusion: ${check.conclusion ?? "unknown"}`,
      durationMs: null,
    })),
  };
}

export function recommendedArtifactTypesForParser(parserType: QaParserType | string): string[] {
  if (parserType === "junit_xml" || parserType === "surefire" || parserType === "gradle") {
    return ["junit_xml", "command_log", "rest_assured_report"];
  }
  if (parserType === "github_checks") return ["github_check_log", "github_annotation"];
  if (parserType === "maestro") return ["screenshot", "video", "logcat", "maestro_report"];
  return ["command_log"];
}

function parseAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(input)) !== null) {
    attrs[match[1]!] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function stripXml(input: string): string {
  return decodeXml(input.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeXml(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function execFilePromise(
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function emulatorCandidates(env: NodeJS.ProcessEnv) {
  return unique([
    env.ANDROID_EMULATOR_PATH,
    env.ANDROID_HOME ? path.join(env.ANDROID_HOME, "emulator", "emulator") : null,
    env.ANDROID_SDK_ROOT ? path.join(env.ANDROID_SDK_ROOT, "emulator", "emulator") : null,
    "emulator",
  ]);
}

function adbCandidates(env: NodeJS.ProcessEnv) {
  return unique([
    env.ANDROID_ADB_PATH,
    env.ANDROID_HOME ? path.join(env.ANDROID_HOME, "platform-tools", "adb") : null,
    env.ANDROID_SDK_ROOT ? path.join(env.ANDROID_SDK_ROOT, "platform-tools", "adb") : null,
    "adb",
  ]);
}

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)));
}

async function firstWorkingCommand(
  candidates: string[],
  args: string[],
  execFile: NonNullable<AndroidDiscoveryInput["execFile"]>,
  env: NodeJS.ProcessEnv,
) {
  for (const candidate of candidates) {
    try {
      const result = await execFile(candidate, args, { timeout: 5000, env });
      return { command: candidate, ...result };
    } catch {
      // Try the next configured location.
    }
  }
  return null;
}

function parseAdbDevices(stdout: string): Array<{ serial: string; status: string; model: string | null }> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.toLowerCase().startsWith("list of devices"))
    .map((line) => {
      const [serial = "", status = "", ...rest] = line.split(/\s+/);
      const model = rest.find((entry) => entry.startsWith("model:"))?.slice("model:".length) ?? null;
      return { serial, status, model };
    })
    .filter((device) => device.serial.length > 0 && device.status.length > 0);
}
