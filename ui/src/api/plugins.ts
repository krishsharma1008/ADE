import type { PluginRecord } from "@combyne/shared";
import { api } from "./client";

export interface PluginExample {
  packageName: string;
  pluginKey: string;
  displayName: string;
  description: string;
  localPath: string;
  tag: string;
}

export interface PluginHealthCheckResult {
  pluginId: string;
  status: string;
  healthy: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message?: string;
  }>;
  lastError?: string;
}

export interface PluginDashboardData {
  checkedAt: string;
  worker: {
    status: string;
    pid: number | null;
    uptime: number | null;
    pendingRequests: number;
    totalCrashes: number;
    consecutiveCrashes: number;
    lastCrashAt: number | null;
  } | null;
  recentJobRuns: Array<{
    id: string;
    jobId: string;
    jobKey: string | null;
    status: string;
    trigger: string;
    durationMs: number | null;
    createdAt: string;
  }>;
  recentWebhookDeliveries: Array<{
    id: string;
    webhookKey: string;
    status: string;
    durationMs: number | null;
    createdAt: string;
  }>;
}

export interface PluginLogEntry {
  id: string;
  level: string;
  message: string;
  createdAt: string;
}

export interface PluginUiContribution {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  updatedAt: string;
  uiEntryFile: string;
  slots: Array<{
    type: string;
    id?: string;
    routePath?: string;
    [key: string]: unknown;
  }>;
  launchers: Array<{
    [key: string]: unknown;
  }>;
}

export interface PluginConfigTestResult {
  valid: boolean;
  message?: string;
}

export const pluginsApi = {
  list: () =>
    api.get<PluginRecord[]>("/plugins"),

  listExamples: () =>
    api.get<PluginExample[]>("/plugins/examples"),

  listUiContributions: () =>
    api.get<PluginUiContribution[]>("/plugins/ui-contributions"),

  get: (pluginId: string) =>
    api.get<PluginRecord>(`/plugins/${pluginId}`),

  install: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
    api.post<PluginRecord>("/plugins/install", params),

  uninstall: (pluginId: string) =>
    api.delete<void>(`/plugins/${pluginId}`),

  enable: (pluginId: string) =>
    api.post<PluginRecord>(`/plugins/${pluginId}/enable`, {}),

  disable: (pluginId: string) =>
    api.post<PluginRecord>(`/plugins/${pluginId}/disable`, {}),

  health: (pluginId: string) =>
    api.get<PluginHealthCheckResult>(`/plugins/${pluginId}/health`),

  dashboard: (pluginId: string) =>
    api.get<PluginDashboardData>(`/plugins/${pluginId}/dashboard`),

  logs: (pluginId: string, options?: { limit?: number }) => {
    const params = options?.limit != null ? `?limit=${options.limit}` : "";
    return api.get<PluginLogEntry[]>(`/plugins/${pluginId}/logs${params}`);
  },

  getConfig: (pluginId: string) =>
    api.get<{ configJson: Record<string, unknown> }>(`/plugins/${pluginId}/config`),

  saveConfig: (pluginId: string, configJson: Record<string, unknown>) =>
    api.post<{ configJson: Record<string, unknown> }>(`/plugins/${pluginId}/config`, { configJson }),

  testConfig: (pluginId: string, configJson: Record<string, unknown>) =>
    api.post<PluginConfigTestResult>(`/plugins/${pluginId}/config/test`, { configJson }),
};
