import { describe, it, expect } from "vitest";
import {
  parseCron,
  validateCron,
  nextCronTick,
  nextCronTickFromExpression,
} from "../services/cron.js";

describe("parseCron", () => {
  it("parses a simple every-hour expression", () => {
    const result = parseCron("0 * * * *");
    expect(result.minutes).toEqual([0]);
    expect(result.hours).toHaveLength(24);
    expect(result.daysOfMonth).toHaveLength(31);
    expect(result.months).toHaveLength(12);
    expect(result.daysOfWeek).toHaveLength(7);
  });

  it("parses a specific time expression", () => {
    const result = parseCron("30 9 * * 1-5");
    expect(result.minutes).toEqual([30]);
    expect(result.hours).toEqual([9]);
    expect(result.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses step expressions", () => {
    const result = parseCron("*/15 * * * *");
    expect(result.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses comma-separated values", () => {
    const result = parseCron("0 8,12,18 * * *");
    expect(result.hours).toEqual([8, 12, 18]);
  });

  it("parses range with step", () => {
    const result = parseCron("0 9-17/2 * * *");
    expect(result.hours).toEqual([9, 11, 13, 15, 17]);
  });

  it("throws on empty expression", () => {
    expect(() => parseCron("")).toThrow("must not be empty");
  });

  it("throws on wrong number of fields", () => {
    expect(() => parseCron("* * *")).toThrow("exactly 5 fields");
  });

  it("throws on out-of-range value", () => {
    expect(() => parseCron("60 * * * *")).toThrow("out of range");
  });

  it("throws on invalid range (start > end)", () => {
    expect(() => parseCron("0 23-1 * * *")).toThrow("start > end");
  });
});

describe("validateCron", () => {
  it("returns null for valid expressions", () => {
    expect(validateCron("0 * * * *")).toBeNull();
    expect(validateCron("*/5 9-17 * * 1-5")).toBeNull();
  });

  it("returns error message for invalid expressions", () => {
    expect(validateCron("")).toContain("must not be empty");
    expect(validateCron("bad")).toContain("exactly 5 fields");
  });
});

describe("nextCronTick", () => {
  it("finds the next hourly tick", () => {
    const cron = parseCron("0 * * * *");
    const after = new Date("2026-04-01T10:30:00Z");
    const next = nextCronTick(cron, after);
    expect(next).toEqual(new Date("2026-04-01T11:00:00Z"));
  });

  it("finds the next daily tick at specific time", () => {
    const cron = parseCron("30 9 * * *");
    const after = new Date("2026-04-01T10:00:00Z");
    const next = nextCronTick(cron, after);
    expect(next).toEqual(new Date("2026-04-02T09:30:00Z"));
  });

  it("finds the next weekday tick", () => {
    const cron = parseCron("0 9 * * 1"); // Monday at 9
    // 2026-04-01 is a Wednesday
    const after = new Date("2026-04-01T10:00:00Z");
    const next = nextCronTick(cron, after);
    // Next Monday is April 6
    expect(next).toEqual(new Date("2026-04-06T09:00:00Z"));
  });

  it("handles month boundaries", () => {
    const cron = parseCron("0 0 1 * *"); // First of every month at midnight
    const after = new Date("2026-04-15T00:00:00Z");
    const next = nextCronTick(cron, after);
    expect(next).toEqual(new Date("2026-05-01T00:00:00Z"));
  });
});

describe("nextCronTickFromExpression", () => {
  it("combines parsing and tick calculation", () => {
    const after = new Date("2026-04-01T10:30:00Z");
    const next = nextCronTickFromExpression("0 * * * *", after);
    expect(next).toEqual(new Date("2026-04-01T11:00:00Z"));
  });

  it("throws on invalid expression", () => {
    expect(() => nextCronTickFromExpression("bad")).toThrow();
  });
});
