import { describe, expect, it } from "vitest";
import { extractContextRefCandidates, renderIssueContextRefs } from "../issue-context-refs.js";

describe("issue context refs", () => {
  it("extracts local files and URLs from issue text", () => {
    const refs = extractContextRefCandidates(
      "Use /tmp/lender-fields.csv and https://docs.google.com/spreadsheets/d/abc123/edit for LND-4999.",
    );

    expect(refs).toContain("/tmp/lender-fields.csv");
    expect(refs).toContain("https://docs.google.com/spreadsheets/d/abc123/edit");
  });

  it("renders inaccessible same-issue refs as explicit worker-access hints", () => {
    const body = renderIssueContextRefs([
      {
        id: "ref-1",
        companyId: "company-1",
        issueId: "issue-1",
        sourceCommentId: null,
        createdByAgentId: null,
        createdByUserId: "user-1",
        kind: "path",
        label: "fields.csv",
        rawRef: "/missing/fields.csv",
        resolvedRef: "/missing/fields.csv",
        accessibilityStatus: "missing",
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    expect(body).toMatch(/Issue context references/);
    expect(body).toMatch(/\/missing\/fields\.csv/);
    expect(body).toMatch(/not accessible from this worker/);
  });
});
