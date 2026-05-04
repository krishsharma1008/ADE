import { describe, expect, it } from "vitest";
import { buildQaRunnerCommand, discoverLocalAndroidEmulators, parseJUnitXml, statusFromGitHubChecks } from "../qa-runner.js";

describe("qa runner helpers", () => {
  it("builds required runner commands with framework-agnostic profiles", () => {
    expect(buildQaRunnerCommand({ runnerType: "android_emulator", commandProfile: { testPath: "flows/login.yaml" } }).command)
      .toContain("maestro test");
    expect(buildQaRunnerCommand({ runnerType: "rest_assured", commandProfile: { command: "mvn test" } }).command)
      .toBe("mvn test");
    expect(buildQaRunnerCommand({ runnerType: "lender_automated", commandProfile: {} }).command)
      .toBe("./gradlew test");
    expect(buildQaRunnerCommand({ runnerType: "github_ci_api", commandProfile: {} }).command)
      .toBe("github-checks");
  });

  it("parses REST Assured/Surefire-style JUnit XML", () => {
    const results = parseJUnitXml(`
      <testsuite>
        <testcase classname="LenderApiTest" name="approvedPayload" time="1.25" />
        <testcase classname="LenderApiTest" name="rejectsInvalidPayload" time="0.5">
          <failure>expected 400 but got 200</failure>
        </testcase>
      </testsuite>
    `);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: "LenderApiTest.approvedPayload", status: "passed", durationMs: 1250 });
    expect(results[1]).toMatchObject({ title: "LenderApiTest.rejectsInvalidPayload", status: "failed" });
    expect(results[1]?.failureReason).toContain("expected 400");
  });

  it("normalizes GitHub CI API checks without local git paths", () => {
    const normalized = statusFromGitHubChecks([
      { id: 1, name: "api / rest assured", status: "completed", conclusion: "success", startedAt: "", completedAt: "" },
      { id: 2, name: "lint", status: "completed", conclusion: "failure", startedAt: "", completedAt: "" },
    ], "api");

    expect(normalized.status).toBe("passed");
    expect(normalized.results).toHaveLength(1);

    const failed = statusFromGitHubChecks([
      { id: 3, name: "api / rest assured", status: "completed", conclusion: "failure", startedAt: "", completedAt: "" },
    ]);
    expect(failed.status).toBe("failed");
    expect(failed.results[0]?.failureReason).toContain("failure");
  });

  it("discovers available Android AVDs and running emulator devices without installing anything", async () => {
    const result = await discoverLocalAndroidEmulators({
      workerId: "worker-a",
      env: {},
      execFile: async (file, args) => {
        if (file === "emulator" && args.join(" ") === "-list-avds") {
          return { stdout: "Pixel_7_API_35\n", stderr: "" };
        }
        if (file === "adb" && args.join(" ") === "devices -l") {
          return {
            stdout: "List of devices attached\nemulator-5554 device product:sdk model:Pixel_7_API_35 device:emu\n",
            stderr: "",
          };
        }
        throw new Error("not found");
      },
    });

    expect(result.diagnostics.emulatorAvailable).toBe(true);
    expect(result.diagnostics.adbAvailable).toBe(true);
    expect(result.diagnostics.avdNames).toEqual(["Pixel_7_API_35"]);
    expect(result.devices.map((device) => device.name)).toContain("Pixel_7_API_35");
    expect(result.devices.some((device) => device.healthStatus === "healthy")).toBe(true);
  });

  it("reports clear diagnostics when Android tooling is not installed", async () => {
    const result = await discoverLocalAndroidEmulators({
      env: {},
      execFile: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });

    expect(result.devices).toHaveLength(0);
    expect(result.diagnostics.emulatorAvailable).toBe(false);
    expect(result.diagnostics.adbAvailable).toBe(false);
    expect(result.diagnostics.warnings.join("\n")).toContain("Android emulator binary not found");
  });
});
