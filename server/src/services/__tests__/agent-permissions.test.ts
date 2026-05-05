import { describe, expect, it } from "vitest";
import { defaultPermissionsForRole, normalizeAgentPermissions } from "../agent-permissions.js";

describe("agent permissions", () => {
  it("grants CEO company-wide delegation and EM report-scoped delegation by default", () => {
    expect(defaultPermissionsForRole("ceo")).toMatchObject({
      canCreateAgents: true,
      canAssignTasks: true,
      taskAssignmentScope: "company",
    });
    expect(defaultPermissionsForRole("em")).toMatchObject({
      canCreateAgents: false,
      canAssignTasks: true,
      taskAssignmentScope: "reports",
    });
  });

  it("keeps IC agents focused by default and preserves explicit overrides", () => {
    expect(defaultPermissionsForRole("engineer")).toMatchObject({
      canAssignTasks: false,
      taskAssignmentScope: "none",
    });
    expect(
      normalizeAgentPermissions(
        { canAssignTasks: true, taskAssignmentScope: "reports" },
        "engineer",
      ),
    ).toMatchObject({
      canAssignTasks: true,
      taskAssignmentScope: "reports",
    });
  });
});
