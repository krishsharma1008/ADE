import { describe, expect, it } from "vitest";
import { shouldCancelInFlightRunOnTerminalClose } from "../routes/issues.js";

describe("issue terminal close run cancellation", () => {
  it("does not cancel the same agent run that closes its own issue", () => {
    expect(
      shouldCancelInFlightRunOnTerminalClose({
        executionRunId: "run-123",
        actorType: "agent",
        actorRunId: "run-123",
      }),
    ).toBe(false);
  });

  it("cancels in-flight runs when board closes the issue", () => {
    expect(
      shouldCancelInFlightRunOnTerminalClose({
        executionRunId: "run-123",
        actorType: "board",
        actorRunId: null,
      }),
    ).toBe(true);
  });

  it("cancels in-flight runs for a different agent run", () => {
    expect(
      shouldCancelInFlightRunOnTerminalClose({
        executionRunId: "run-123",
        actorType: "agent",
        actorRunId: "run-456",
      }),
    ).toBe(true);
  });

  it("has nothing to cancel when there is no execution run", () => {
    expect(
      shouldCancelInFlightRunOnTerminalClose({
        executionRunId: null,
        actorType: "board",
        actorRunId: null,
      }),
    ).toBe(false);
  });
});
