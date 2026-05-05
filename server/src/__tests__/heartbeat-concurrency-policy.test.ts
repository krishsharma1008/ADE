import { describe, expect, it } from "vitest";
import {
  defaultMaxConcurrentRunsForAgent,
  resolveHeartbeatMaxConcurrentRuns,
} from "../services/heartbeat.js";

describe("heartbeat concurrency policy", () => {
  it("defaults coordinator roles to a small parallel delegation window", () => {
    expect(defaultMaxConcurrentRunsForAgent({ role: "ceo", permissions: {} })).toBe(3);
    expect(defaultMaxConcurrentRunsForAgent({ role: "pm", permissions: {} })).toBe(3);
    expect(defaultMaxConcurrentRunsForAgent({ role: "manager", permissions: {} })).toBe(3);
  });

  it("keeps individual contributors serialized by default", () => {
    expect(defaultMaxConcurrentRunsForAgent({ role: "engineer", permissions: {} })).toBe(1);
    expect(defaultMaxConcurrentRunsForAgent({ role: "qa", permissions: {} })).toBe(1);
  });

  it("treats canCreateAgents as coordinator-style work", () => {
    expect(
      defaultMaxConcurrentRunsForAgent({
        role: "engineer",
        permissions: { canCreateAgents: true },
      }),
    ).toBe(3);
  });

  it("respects explicit maxConcurrentRuns overrides", () => {
    expect(resolveHeartbeatMaxConcurrentRuns({ maxConcurrentRuns: 1 }, { role: "pm" })).toBe(1);
    expect(resolveHeartbeatMaxConcurrentRuns({ maxConcurrentRuns: 4 }, { role: "engineer" })).toBe(4);
    expect(resolveHeartbeatMaxConcurrentRuns({ maxConcurrentRuns: 20 }, { role: "pm" })).toBe(10);
  });

  it("uses role defaults when maxConcurrentRuns is omitted", () => {
    expect(resolveHeartbeatMaxConcurrentRuns({}, { role: "pm" })).toBe(3);
    expect(resolveHeartbeatMaxConcurrentRuns({}, { role: "engineer" })).toBe(1);
  });
});
