import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = path.resolve(__dirname, "../../../../skills/combyne/SKILL.md");

// Extract just the "Reviewing Another Agent's PR" section (header through the next `### ` header).
function reviewSection(doc: string): string {
  const start = doc.indexOf("### Reviewing Another Agent's PR");
  expect(start, "review section header must exist").toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + "### Reviewing Another Agent's PR".length);
  const next = rest.indexOf("\n### ");
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe("combyne SKILL.md — Reviewing Another Agent's PR", () => {
  let doc: string;
  let section: string;

  beforeAll(async () => {
    doc = await readFile(SKILL_PATH, "utf8");
    section = reviewSection(doc);
  });

  it("requires a pr_review_requested task naming the exact repo#number", () => {
    expect(section).toContain("pr_review_requested");
    expect(section).toContain("repo#number");
    expect(section).toContain("COMBYNE_TASK_ID");
  });

  it("does not present a raw unsolicited `gh pr review` as an authorized action", () => {
    // No approve/request-changes submission command should be shown as something the agent runs.
    expect(section).not.toContain("gh pr review <number> --approve");
    expect(section).not.toContain("gh pr review <number> --request-changes");
    // The section explicitly warns against running a raw `gh pr review`.
    expect(section).toContain("Do **not** run a raw");
    expect(section).toContain("not an authorized action");
    expect(section).toContain("gh pr review");
  });

  it("tells the agent to check the queue or ask the requester when there is no review task", () => {
    expect(section.toLowerCase()).toContain("check your queue");
    expect(section.toLowerCase()).toContain("ask the requester");
  });

  it("does not present the board-only /reviews proxy as an agent action", () => {
    // The old proxy table listed an agent-callable "Create review" endpoint. It must be gone.
    expect(doc).not.toContain(
      "| Create review | `POST /api/companies/:companyId/integrations/github/repos/:repo/pulls/:number/reviews` |",
    );
    // The proxy table now marks review submission as board/dashboard only.
    expect(doc).toContain("Submit PR review | Board/dashboard only");
  });

  it("keeps the Design Quality Self-Review (own-PR) section intact and distinct from reviewing another agent's PR", () => {
    // Regression guard: the review-scope rewrite must NOT remove or merge the
    // separate own-diff self-review checkpoint.
    expect(doc).toContain("### Design Quality Self-Review");
    const selfStart = doc.indexOf("### Design Quality Self-Review");
    const reviewStart = doc.indexOf("### Reviewing Another Agent's PR");
    expect(selfStart).toBeGreaterThanOrEqual(0);
    expect(reviewStart).toBeGreaterThan(selfStart);
    // The self-review section explicitly states it is separate from reviewing
    // another agent's PR.
    const selfSection = doc.slice(selfStart, reviewStart);
    expect(selfSection.toLowerCase()).toContain("your own");
    expect(selfSection).toContain("reviewing another agent's PR");
  });
});
