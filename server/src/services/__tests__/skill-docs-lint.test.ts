// F2/F3/F4 + F6-doc (e2e-run-2026-06-10 findings): the combyne skill docs taught
// policy-violating behavior — the Manager worked example closed the parent right
// after delegating subtasks, the IC example closed a CODE task directly (no
// branch/PR/in_review), the quick-reference table offered agents a merge endpoint,
// and Step 9 taught the generic create path that bypasses the delegation passdown.
// This lint pins the corrected text so the examples can't regress.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.resolve(here, "../../../../skills/combyne");

const skillMd = readFileSync(path.join(skillsRoot, "SKILL.md"), "utf8");
const apiReferenceMd = readFileSync(
  path.join(skillsRoot, "references/api-reference.md"),
  "utf8",
);

describe("combyne skill docs teach current policy (F2/F3/F4/F6 regression guard)", () => {
  it("F2: Manager example must not close the parent right after delegating", () => {
    expect(apiReferenceMd).not.toContain(
      '{ "status": "done", "comment": "Broke down into subtasks',
    );
    expect(apiReferenceMd).toMatch(/Leave the PARENT OPEN/i);
  });

  it("F3: IC example ends a code task at in_review with a tracked PR, not done", () => {
    expect(apiReferenceMd).not.toContain(
      '{ "status": "done", "comment": "Fixed sliding window calc',
    );
    const icExample = apiReferenceMd.slice(
      apiReferenceMd.indexOf("Worked Example: IC Heartbeat"),
      apiReferenceMd.indexOf("Worked Example: Manager"),
    );
    expect(icExample).toContain('"status": "in_review"');
    expect(icExample).toContain("/pull-requests");
    expect(icExample).toMatch(/NEVER closed by the agent/i);
  });

  it("F4: quick-reference table must not present a merge endpoint as agent-callable", () => {
    const quickRef = skillMd.slice(skillMd.indexOf("## Key Endpoints"));
    expect(quickRef).not.toMatch(/merge PR\s*\|\s*`PUT/i);
    expect(quickRef).toMatch(/merge PR\s*\|\s*Board\/dashboard ONLY/i);
  });

  it("F6: Step 9 teaches the delegate endpoint (passdown rail) for assigned subtasks", () => {
    const step9 = skillMd.slice(
      skillMd.indexOf("**Step 9 — Delegate if needed.**"),
      skillMd.indexOf("## Project Setup Workflow"),
    );
    expect(step9).toContain("POST /api/issues/{parentIssueId}/delegate");
    expect(step9).toMatch(/passdown packet/i);
    expect(step9).toMatch(/never mark a parent `done` at delegation time/i);
  });
});
