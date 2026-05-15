import { describe, expect, it } from "vitest";
import {
  blockedIssueDescription,
  blockedIssueTitle,
  isOpenManagerQuestion,
  isUserFacingQuestion,
  timelineCommentLabel,
} from "./issue-comments";

describe("issue comment helpers", () => {
  it("keeps manager questions out of user-facing question cards", () => {
    expect(isUserFacingQuestion({ kind: "question", answeredAt: null })).toBe(true);
    expect(isUserFacingQuestion({ kind: "manager_question", answeredAt: null })).toBe(false);
    expect(isOpenManagerQuestion({ kind: "manager_question", answeredAt: null })).toBe(true);
  });

  it("labels internal manager question threads", () => {
    expect(timelineCommentLabel({ kind: "manager_question", answeredAt: null })).toBe("Internal blocker");
    expect(timelineCommentLabel({ kind: "manager_answer", answeredAt: null })).toBe("EM answer");
    expect(timelineCommentLabel({ kind: "question", answeredAt: null })).toBe("User question");
  });

  it("describes internally blocked issues as waiting on EM or manager", () => {
    expect(blockedIssueTitle({ blockedSource: "agent" }, 1)).toBe("Waiting on EM/manager");
    expect(blockedIssueDescription({ blockedSource: "agent", blockedReason: "Waiting on EM/manager: Pick a default" }, 1))
      .toContain("sub-agent asked an internal question");
  });
});
