export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canAssignTasks: boolean;
  taskAssignmentScope: "none" | "reports" | "company";
};

const MANAGER_ROLES = new Set(["ceo", "cto", "cmo", "cfo", "pm", "em", "manager"]);

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  const normalizedRole = role.trim().toLowerCase();
  const isManager = MANAGER_ROLES.has(normalizedRole);
  return {
    canCreateAgents: normalizedRole === "ceo",
    canAssignTasks: isManager,
    taskAssignmentScope: normalizedRole === "ceo" ? "company" : isManager ? "reports" : "none",
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  return {
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canAssignTasks:
      typeof record.canAssignTasks === "boolean"
        ? record.canAssignTasks
        : defaults.canAssignTasks,
    taskAssignmentScope:
      record.taskAssignmentScope === "company" ||
      record.taskAssignmentScope === "reports" ||
      record.taskAssignmentScope === "none"
        ? record.taskAssignmentScope
        : defaults.taskAssignmentScope,
  };
}
