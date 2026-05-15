import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function readFileIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function detectGradleVersion(cwd) {
  const props = readFileIfExists(path.join(cwd, "gradle", "wrapper", "gradle-wrapper.properties"));
  return props.match(/gradle-([0-9]+(?:\.[0-9]+){0,2})-/)?.[1] ?? null;
}

export function detectJavaTarget(cwd) {
  for (const file of ["build.gradle", "build.gradle.kts"]) {
    const body = readFileIfExists(path.join(cwd, file));
    const match =
      body.match(/(?:sourceCompatibility|targetCompatibility)\s*=?\s*(?:JavaVersion\.VERSION_)?['"]?(\d+)/) ??
      body.match(/languageVersion\s*=\s*JavaLanguageVersion\.of\((\d+)\)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function parseJavaMajor(output) {
  const match = String(output).match(/version "(?:(\d+)\.)?(\d+)(?:[._]\d+)?/);
  if (!match) return null;
  const first = match[1] ? Number(match[1]) : Number(match[2]);
  const second = Number(match[2]);
  return first === 1 ? second : first;
}

function javaVersionForHome(javaHome) {
  const javaBin = javaHome ? path.join(javaHome, "bin", "java") : "java";
  const result = spawnSync(javaBin, ["-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { major: parseJavaMajor(text), version: text || null };
}

function gradleMaxJavaMajor(gradleVersion) {
  const major = Number(String(gradleVersion ?? "").split(".")[0]);
  if (!Number.isFinite(major) || major <= 0) return 17;
  if (major >= 9) return 25;
  if (major >= 8) return 21;
  return 17;
}

function candidateHomes(explicit, env = process.env) {
  const out = [
    explicit,
    env.COMBYNE_AUDIT_JAVA_HOME,
    env.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home",
  ].filter(Boolean);
  for (const base of ["/Library/Java/JavaVirtualMachines", `${process.env.HOME ?? ""}/Library/Java/JavaVirtualMachines`]) {
    try {
      for (const entry of fs.readdirSync(base)) out.push(path.join(base, entry, "Contents", "Home"));
    } catch {
      // ignored
    }
  }
  return [...new Set(out)].filter((home) => fs.existsSync(path.join(home, "bin", "java")));
}

export function resolveJavaRuntime({ cwd, javaHome = null, env = process.env }) {
  const gradleVersion = detectGradleVersion(cwd);
  const javaTarget = detectJavaTarget(cwd);
  const maxMajor = gradleMaxJavaMajor(gradleVersion);
  const minMajor = javaTarget ?? 8;
  const notes = [];
  for (const candidate of candidateHomes(javaHome, env)) {
    const version = javaVersionForHome(candidate);
    if (version.major && version.major >= minMajor && version.major <= maxMajor) {
      return { status: "ok", javaHome: candidate, javaMajor: version.major, javaVersion: version.version, gradleVersion, javaTarget, guidance: null, notes };
    }
    if (version.major) notes.push(`Skipped ${candidate}: Java ${version.major} is outside required ${minMajor}-${maxMajor}.`);
  }
  const current = javaVersionForHome(null);
  if (current.major && current.major >= minMajor && current.major <= maxMajor) {
    return { status: "ok", javaHome: process.env.JAVA_HOME ?? null, javaMajor: current.major, javaVersion: current.version, gradleVersion, javaTarget, guidance: null, notes };
  }
  const install = maxMajor >= 17 ? "JDK 17" : `JDK ${maxMajor}`;
  return {
    status: "setup_missing",
    javaHome: null,
    javaMajor: current.major,
    javaVersion: current.version,
    gradleVersion,
    javaTarget,
    guidance: `Install ${install} and set COMBYNE_AUDIT_JAVA_HOME or pass --java-home. Detected Gradle ${gradleVersion ?? "unknown"} and Java target ${javaTarget ?? "unknown"}; current Java is ${current.major ?? "unknown"}.`,
    notes,
  };
}

export function envForJavaResolution(resolution, baseEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  if (resolution.status === "ok" && resolution.javaHome) {
    env.JAVA_HOME = resolution.javaHome;
    env.PATH = `${path.join(resolution.javaHome, "bin")}${path.delimiter}${env.PATH ?? ""}`;
  }
  return env;
}
