import { api } from "./client";

/**
 * Current context-DB connection status (PR-15 §3.7 / Database tab). All values
 * come from GET /instance/context-database (instance-admin gated server-side).
 * The endpoint redacts the password, so `redactedEndpoint` is safe to render.
 */
export interface ContextDatabaseStatus {
  mode: "external" | "embedded";
  usingSeparateContextDb: boolean;
  /** Password-masked connection string (never the raw credential). */
  redactedEndpoint: string;
  serverVersion: string | null;
  memorySchemaPresent: boolean;
  memoryEntryCount: number | null;
  configuredVia: "env" | "config-file" | "default";
}

/** Result of probing an arbitrary url WITHOUT persisting it (POST .../test). */
export interface ContextDatabaseProbe {
  ok: boolean;
  serverVersion: string | null;
  memorySchemaPresent: boolean;
  memoryEntryCount: number | null;
  error?: string;
}

/** Result of saving a url for next boot (POST .../save). Restart-gated. */
export interface ContextDatabaseSaveResult {
  saved: boolean;
  restartRequired: boolean;
  redactedEndpoint: string;
}

/**
 * Result of writing the embedding config (POST /instance/embedding-config). The
 * key is write-only and NEVER returned — only the non-secret echoes come back.
 */
export interface EmbeddingConfigSaveResult {
  saved: boolean;
  restartRequired: boolean;
  provider: string;
  model: string;
  disclosureAcked: boolean;
}

/**
 * The joinable teams (the companies registry) on a shared context DB
 * (POST .../teams). Open join — every team is returned. On an unreachable/invalid
 * or unconfigured DB the helper returns ok:false with companies:[] and a safe
 * error message (never the credential).
 */
export interface ContextDatabaseTeamsResult {
  ok: boolean;
  companies: Array<{ id: string; name: string }>;
  error?: string;
}

/**
 * Result of joining (adopting) an existing team (POST .../join). The local company
 * is adopted at the team's canonical id; only `redactedEndpoint` (never the raw
 * credential) is echoed. `restartRequired` is true only when a NEW url was
 * persisted; `action` surfaces idempotency (a re-join => 'kept').
 */
export interface ContextDatabaseJoinResult {
  joined: boolean;
  restartRequired: boolean;
  company: { id: string; name: string; issuePrefix: string };
  redactedEndpoint: string;
  action: "inserted" | "kept" | "renamed";
}

export const databaseApi = {
  getStatus: () => api.get<ContextDatabaseStatus>("/instance/context-database"),
  test: (url: string) =>
    api.post<ContextDatabaseProbe>("/instance/context-database/test", { url }),
  save: (url: string) =>
    api.post<ContextDatabaseSaveResult>("/instance/context-database/save", { url }),
  // List the joinable teams on a shared context DB. `url` is optional — when
  // omitted the route honors an already-configured rail (env or config-file).
  listTeams: (url?: string) =>
    api.post<ContextDatabaseTeamsResult>(
      "/instance/context-database/teams",
      url ? { url } : {},
    ),
  // Join (adopt) an existing team. `url` is optional for the same reason.
  join: (payload: { url?: string; teamId: string; teamName: string }) =>
    api.post<ContextDatabaseJoinResult>("/instance/context-database/join", payload),
  saveEmbeddingConfig: (payload: {
    provider: string;
    model: string;
    apiKey: string;
    disclosureAcked: true;
  }) => api.post<EmbeddingConfigSaveResult>("/instance/embedding-config", payload),
};
