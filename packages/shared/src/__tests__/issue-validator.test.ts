import { describe, expect, it } from "vitest";
import { createIssueSchema, updateIssueSchema } from "../validators/issue.js";

describe("issue validators", () => {
  it("defaults new issues to small complexity", () => {
    const parsed = createIssueSchema.parse({ title: "Fix typo" });
    expect(parsed.complexity).toBe("small");
  });

  it("accepts valid complexity updates and rejects invalid values", () => {
    expect(updateIssueSchema.parse({ complexity: "large" }).complexity).toBe("large");
    expect(() => updateIssueSchema.parse({ complexity: "huge" })).toThrow();
  });
});

