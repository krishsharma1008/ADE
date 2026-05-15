import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface JavaResolution {
  status: "ok" | "setup_missing";
  javaHome: string | null;
  javaMajor: number | null;
  javaVersion: string | null;
  gradleVersion: string | null;
  javaTarget: number | null;
  guidance: string | null;
  notes: string[];
}

function readFileIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function detectGradleVersion(cwd: string): string | null {
  const props = readFileIfExists(path.join(cwd, "gradle", "wrapper", "gradle-wrapper.properties"));
  const match = props.match(/gradle-([0-9]+(?:\.[0-9]+){0,2})-/);
  return match?.[1] ?? null;
}

export function detectJavaTarget(cwd: string): number | null {
  const candidates = ["build.gradle", "build.gradle.kts"];
  for (const file of candidates) {
    const body = readFileIfExists(path.join(cwd, file));
    const match =
      body.match(/(?:sourceCompatibility|targetCompatibility)\s*=?\s*(?:JavaVersion\.VERSION_)?['"]?(\d+)/) ??
      body.match(/languageVersion\s*=\s*JavaLanguageVersion\.of\((\d+)\)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function parseJavaMajor(versionOutput: string): number | null {
  const match = versionOutput.match(/version "(?:(\d+)\.)?(\d+)(?:[._]\d+)?/);
  if (!match) return null;
  const first = match[1] ? Number(match[1]) : Number(match[2]);
  const second = Number(match[2]);
  if (first === 1) return second;
  return first;
}

function javaVersionForHome(javaHome: string | null): { major: number | null; version: string | null } {
  const javaBin = javaHome ? path.join(javaHome, "bin", "java") : "java";
  const result = spawnSync(javaBin, ["-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return { major: parseJavaMajor(text), version: text.trim() };
  } catch {
    return { major: null, version: null };
  }
}

function gradleMaxJavaMajor(gradleVersion: string | null): number {
  const major = Number((gradleVersion ?? "").split(".")[0]);
  if (!Number.isFinite(major) || major <= 0) return 17;
  if (major >= 9) return 25;
  if (major >= 8) return 21;
  return 17;
}

function candidateJavaHomes(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    explicit,
    env.COMBYNE_AUDIT_JAVA_HOME,
    env.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home",
  ].filter((value): value is string => Boolean(value));
  for (const base of ["/Library/Java/JavaVirtualMachines", `${process.env.HOME ?? ""}/Library/Java/JavaVirtualMachines`]) {
    try {
      for (const entry of fs.readdirSync(base)) {
        candidates.push(path.join(base, entry, "Contents", "Home"));
      }
    } catch {
      // ignored
    }
  }
  return [...new Set(candidates)].filter((home) => fs.existsSync(path.join(home, "bin", "java")));
}

export function resolveJavaRuntime(input: {
  cwd: string;
  javaHome?: string | null;
  env?: NodeJS.ProcessEnv;
}): JavaResolution {
  const gradleVersion = detectGradleVersion(input.cwd);
  const javaTarget = detectJavaTarget(input.cwd);
  const maxMajor = gradleMaxJavaMajor(gradleVersion);
  const minMajor = javaTarget ?? 8;
  const notes: string[] = [];

  for (const candidate of candidateJavaHomes(input.javaHome, input.env)) {
    const version = javaVersionForHome(candidate);
    if (!version.major) continue;
    if (version.major >= minMajor && version.major <= maxMajor) {
      return {
        status: "ok",
        javaHome: candidate,
        javaMajor: version.major,
        javaVersion: version.version,
        gradleVersion,
        javaTarget,
        guidance: null,
        notes,
      };
    }
    notes.push(`Skipped ${candidate}: Java ${version.major} is outside required ${minMajor}-${maxMajor}.`);
  }

  const current = javaVersionForHome(null);
  if (current.major && current.major >= minMajor && current.major <= maxMajor) {
    return {
      status: "ok",
      javaHome: process.env.JAVA_HOME ?? null,
      javaMajor: current.major,
      javaVersion: current.version,
      gradleVersion,
      javaTarget,
      guidance: null,
      notes,
    };
  }
  const install = maxMajor >= 17 ? "JDK 17" : `JDK ${maxMajor}`;
  return {
    status: "setup_missing",
    javaHome: null,
    javaMajor: current.major,
    javaVersion: current.version,
    gradleVersion,
    javaTarget,
    guidance:
      `Install ${install} and set COMBYNE_AUDIT_JAVA_HOME or commandProfile.env.JAVA_HOME to that JDK. ` +
      `Detected Gradle ${gradleVersion ?? "unknown"} and Java target ${javaTarget ?? "unknown"}; current Java is ${current.major ?? "unknown"}.`,
    notes,
  };
}

export function applyJavaResolutionEnv(
  baseEnv: Record<string, string> | NodeJS.ProcessEnv,
  resolution: JavaResolution,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  if (resolution.status === "ok" && resolution.javaHome) {
    env.JAVA_HOME = resolution.javaHome;
    env.PATH = `${path.join(resolution.javaHome, "bin")}${path.delimiter}${env.PATH ?? ""}`;
  }
  return env;
}
