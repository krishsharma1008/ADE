import { api } from "./client";

export interface GeneralSettings {
  censorUsernameInLogs?: boolean;
}

export interface ExperimentalSettings {
  enableIsolatedWorkspaces?: boolean;
  autoRestartDevServerWhenIdle?: boolean;
}

export const instanceSettingsApi = {
  getGeneral: () =>
    api.get<GeneralSettings>("/instance/settings/general"),

  updateGeneral: (patch: Partial<GeneralSettings>) =>
    api.patch<GeneralSettings>("/instance/settings/general", patch),

  getExperimental: () =>
    api.get<ExperimentalSettings>("/instance/settings/experimental"),

  updateExperimental: (patch: Partial<ExperimentalSettings>) =>
    api.patch<ExperimentalSettings>("/instance/settings/experimental", patch),
};
