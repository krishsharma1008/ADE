import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectGradleVersion, detectJavaTarget, resolveJavaRuntime } from "../java-runtime.js";

describe("java runtime resolver", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function gradleProject() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "combyne-java-runtime-"));
    tmpDirs.push(dir);
    await mkdir(path.join(dir, "gradle", "wrapper"), { recursive: true });
    await writeFile(
      path.join(dir, "gradle", "wrapper", "gradle-wrapper.properties"),
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-7.4-bin.zip\n",
    );
    await writeFile(path.join(dir, "build.gradle"), "sourceCompatibility = '11'\ntargetCompatibility = '11'\n");
    return dir;
  }

  it("detects Gradle wrapper version and Java target", async () => {
    const dir = await gradleProject();
    expect(detectGradleVersion(dir)).toBe("7.4");
    expect(detectJavaTarget(dir)).toBe(11);
  });

  it("does not treat Java 25 / Gradle 7 mismatch as a repo failure", async () => {
    const dir = await gradleProject();
    const resolution = resolveJavaRuntime({ cwd: dir, env: { PATH: process.env.PATH ?? "" } });
    if (resolution.status === "setup_missing") {
      expect(resolution.guidance).toMatch(/Install JDK 17|COMBYNE_AUDIT_JAVA_HOME|JAVA_HOME/i);
      expect(resolution.gradleVersion).toBe("7.4");
      expect(resolution.javaTarget).toBe(11);
    } else {
      expect(resolution.javaMajor).toBeLessThanOrEqual(17);
      expect(resolution.javaMajor).toBeGreaterThanOrEqual(11);
    }
  });
});

