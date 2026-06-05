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

export const databaseApi = {
  getStatus: () => api.get<ContextDatabaseStatus>("/instance/context-database"),
  test: (url: string) =>
    api.post<ContextDatabaseProbe>("/instance/context-database/test", { url }),
  save: (url: string) =>
    api.post<ContextDatabaseSaveResult>("/instance/context-database/save", { url }),
  saveEmbeddingConfig: (payload: {
    provider: string;
    model: string;
    apiKey: string;
    disclosureAcked: true;
  }) => api.post<EmbeddingConfigSaveResult>("/instance/embedding-config", payload),
};
