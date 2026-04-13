import type { Agent, CompanyPortabilitySidebarOrder, Project } from "@combyne/shared";

/**
 * Build a sidebar ordering object that captures the user's current agent and
 * project ordering so it can be embedded in the exported package manifest.
 *
 * Returns `null` when there are no agents and no projects (nothing to order).
 */
export function buildPortableSidebarOrder({
  agents,
  orderedAgents,
  projects,
  orderedProjects,
}: {
  agents: Agent[];
  orderedAgents: Agent[];
  projects: Project[];
  orderedProjects: Project[];
}): CompanyPortabilitySidebarOrder | null {
  if (agents.length === 0 && projects.length === 0) return null;

  return {
    agents: orderedAgents.map((a) => a.slug ?? a.name),
    projects: orderedProjects.map((p) => p.slug ?? p.name),
  };
}
