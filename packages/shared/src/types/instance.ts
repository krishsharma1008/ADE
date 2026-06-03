export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
}

export type DefaultIsolationMode = "per_issue_worktree" | "shared_workspace";

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  defaultIsolationMode: DefaultIsolationMode;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
