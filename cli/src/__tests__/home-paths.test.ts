import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveCombyneHomeDir,
  resolveCombyneInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.combyne and default instance", () => {
    delete process.env.COMBYNE_HOME;
    delete process.env.COMBYNE_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(path.resolve(os.homedir(), ".combyne"));
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(os.homedir(), ".combyne", "instances", "default", "config.json"));
  });

  it("supports COMBYNE_HOME and explicit instance ids", () => {
    process.env.COMBYNE_HOME = "~/combyne-home";

    const home = resolveCombyneHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "combyne-home"));
    expect(resolveCombyneInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveCombyneInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
