import type { ProjectStatus } from "../constants.js";

export interface ProjectGoalRef {
  id: string;
  title: string;
}

export interface ProjectWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  metadata: Record<string, unknown> | null;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
  // Optional provisioning/runtime metadata populated by the workspace-runtime
  // service. Absent on bare-bones workspaces.
  sourceType?: string | null;
  visibility?: string | null;
  defaultRef?: string | null;
  setupCommand?: string | null;
  cleanupCommand?: string | null;
  remoteProvider?: string | null;
  remoteWorkspaceRef?: string | null;
  sharedWorkspaceKey?: string | null;
  runtimeConfig?: Record<string, unknown> | null;
  runtimeServices?: Array<Record<string, unknown>> | null;
}

export interface Project {
  id: string;
  companyId: string;
  urlKey: string;
  /** URL-safe stable identifier. Alias for urlKey on the read APIs. */
  slug?: string;
  /** @deprecated Use goalIds / goals instead */
  goalId: string | null;
  goalIds: string[];
  goals: ProjectGoalRef[];
  name: string;
  description: string | null;
  status: ProjectStatus;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
