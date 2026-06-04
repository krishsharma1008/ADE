import { readConfigFile } from "./config-file.js";
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { resolveCombyneEnvPath } from "./paths.js";
import {
  AUTH_BASE_URL_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  type AuthBaseUrlMode,
  type DeploymentExposure,
  type DeploymentMode,
  type SecretProvider,
  type StorageProvider,
} from "@combyne/shared";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
} from "./home-paths.js";

function envVar(suffix: string): string | undefined {
  return process.env[`COMBYNE_${suffix}`];
}

const COMBYNE_ENV_FILE_PATH = resolveCombyneEnvPath();
if (existsSync(COMBYNE_ENV_FILE_PATH)) {
  loadDotenv({ path: COMBYNE_ENV_FILE_PATH, override: false, quiet: true });
}

type DatabaseMode = "embedded-postgres" | "postgres";

export interface Config {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  host: string;
  port: number;
  allowedHostnames: string[];
  authBaseUrlMode: AuthBaseUrlMode;
  authPublicBaseUrl: string | undefined;
  authDisableSignUp: boolean;
  databaseMode: DatabaseMode;
  databaseUrl: string | undefined;
  /**
   * Optional separate Postgres for the memory/context layer. When set (and
   * distinct from databaseUrl) the memory tables physically live here; unset
   * (default '') means single-DB mode = today's behavior, fully backward-compatible.
   */
  contextDatabaseUrl: string;
  embeddedPostgresDataDir: string;
  embeddedPostgresPort: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
  serveUi: boolean;
  uiDevMiddleware: boolean;
  secretsProvider: SecretProvider;
  secretsStrictMode: boolean;
  secretsMasterKeyFilePath: string;
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir: string;
  storageS3Bucket: string;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  storageS3Prefix: string;
  storageS3ForcePathStyle: boolean;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  companyDeletionEnabled: boolean;
  licenseEnabled: boolean;
  licenseSupabaseUrl: string;
  licenseSupabaseAnonKey: string;
  licenseHeartbeatIntervalMinutes: number;
  licenseGracePeriodHours: number;
  // ---- Sufficiency gate (PR-10, MEMORY_UI_AND_QUALITY_PLAN §2) ----
  /**
   * Master flag for the ask-don't-hallucinate sufficiency gate. DEFAULT OFF.
   * While off the heartbeat emits a `sufficiency_verdict` telemetry event only
   * and NEVER withholds context or posts a question (§2.8 — the gate is a true
   * no-op until 0049 + HOOK 1 calibrate it). The ask-mode flip is a later
   * (Phase 3) config change after threshold calibration.
   */
  sufficiencyGateEnabled: boolean;
  /** Hash-64 calibrated minimum top score below which context is sub-threshold (§2.3). */
  sufficiencyMinScore: number;
  /** Hash-64 calibrated minimum requirement-coverage fraction (§2.3). */
  sufficiencyReqCoverMin: number;
  // ---- Managed-API embeddings (PR-11, MEMORY_UI_AND_QUALITY_PLAN §1.2) ----
  /** Embedding provider. Default 'openai'. Part of the embedding_version string. */
  embeddingProvider: string;
  /** Embedding model. Default 'text-embedding-3-small'. Part of embedding_version. */
  embeddingModel: string;
  /** Embedding dimension. Default 1536. Part of embedding_version; THROW on API mismatch. */
  embeddingDim: number;
  /**
   * ONE team-shared embedding API key, set once at install. Resolves
   * COMBYNE_EMBEDDING_API_KEY → OPENAI_API_KEY → '' (never throws on unset).
   * Empty key COERCES vectorSearchEnabled to false (zero egress, never crash).
   */
  embeddingApiKey: string;
  /**
   * ANN/vector-search master flag. COMBYNE_VECTOR_SEARCH_ENABLED === 'true'.
   * DEFAULT false. COERCED false when embeddingApiKey is empty — so the OFF
   * state (incl. all CI/test runs) takes the hash-64 jsonb path with no
   * provider call and no egress.
   */
  vectorSearchEnabled: boolean;
  /** Monthly cost cap (USD) — visibility-only, no hard cutoff. '' = no cap. */
  embeddingMonthlyCapUsd: string;
  /** Embedder requests-per-minute soft budget for the backfill batcher. Default 3000. */
  embeddingRpm: number;
}

export function loadConfig(): Config {
  const fileConfig = readConfigFile();
  const fileDatabaseMode =
    (fileConfig?.database.mode === "postgres" ? "postgres" : "embedded-postgres") as DatabaseMode;

  const fileDbUrl =
    fileDatabaseMode === "postgres"
      ? fileConfig?.database.connectionString
      : undefined;
  const fileDatabaseBackup = fileConfig?.database.backup;
  const fileSecrets = fileConfig?.secrets;
  const fileStorage = fileConfig?.storage;
  const strictModeFromEnv = envVar("SECRETS_STRICT_MODE");
  const secretsStrictMode =
    strictModeFromEnv !== undefined
      ? strictModeFromEnv === "true"
      : (fileSecrets?.strictMode ?? false);

  const providerFromEnvRaw = envVar("SECRETS_PROVIDER");
  const providerFromEnv =
    providerFromEnvRaw && SECRET_PROVIDERS.includes(providerFromEnvRaw as SecretProvider)
      ? (providerFromEnvRaw as SecretProvider)
      : null;
  const providerFromFile = fileSecrets?.provider;
  const secretsProvider: SecretProvider = providerFromEnv ?? providerFromFile ?? "local_encrypted";

  const storageProviderFromEnvRaw = envVar("STORAGE_PROVIDER");
  const storageProviderFromEnv =
    storageProviderFromEnvRaw && STORAGE_PROVIDERS.includes(storageProviderFromEnvRaw as StorageProvider)
      ? (storageProviderFromEnvRaw as StorageProvider)
      : null;
  const storageProvider: StorageProvider = storageProviderFromEnv ?? fileStorage?.provider ?? "local_disk";
  const storageLocalDiskBaseDir = resolveHomeAwarePath(
    envVar("STORAGE_LOCAL_DIR") ??
      fileStorage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
  const storageS3Bucket = envVar("STORAGE_S3_BUCKET") ?? fileStorage?.s3?.bucket ?? "combyne";
  const storageS3Region = envVar("STORAGE_S3_REGION") ?? fileStorage?.s3?.region ?? "us-east-1";
  const storageS3Endpoint = envVar("STORAGE_S3_ENDPOINT") ?? fileStorage?.s3?.endpoint ?? undefined;
  const storageS3Prefix = envVar("STORAGE_S3_PREFIX") ?? fileStorage?.s3?.prefix ?? "";
  const storageS3ForcePathStyle =
    envVar("STORAGE_S3_FORCE_PATH_STYLE") !== undefined
      ? envVar("STORAGE_S3_FORCE_PATH_STYLE") === "true"
      : (fileStorage?.s3?.forcePathStyle ?? false);

  const deploymentModeFromEnvRaw = envVar("DEPLOYMENT_MODE");
  const deploymentModeFromEnv =
    deploymentModeFromEnvRaw && DEPLOYMENT_MODES.includes(deploymentModeFromEnvRaw as DeploymentMode)
      ? (deploymentModeFromEnvRaw as DeploymentMode)
      : null;
  const deploymentMode: DeploymentMode = deploymentModeFromEnv ?? fileConfig?.server.deploymentMode ?? "local_trusted";
  const deploymentExposureFromEnvRaw = envVar("DEPLOYMENT_EXPOSURE");
  const deploymentExposureFromEnv =
    deploymentExposureFromEnvRaw &&
    DEPLOYMENT_EXPOSURES.includes(deploymentExposureFromEnvRaw as DeploymentExposure)
      ? (deploymentExposureFromEnvRaw as DeploymentExposure)
      : null;
  const deploymentExposure: DeploymentExposure =
    deploymentMode === "local_trusted"
      ? "private"
      : (deploymentExposureFromEnv ?? fileConfig?.server.exposure ?? "private");
  const authBaseUrlModeFromEnvRaw = envVar("AUTH_BASE_URL_MODE");
  const authBaseUrlModeFromEnv =
    authBaseUrlModeFromEnvRaw &&
    AUTH_BASE_URL_MODES.includes(authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      ? (authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      : null;
  const publicUrlFromEnv = envVar("PUBLIC_URL");
  const authPublicBaseUrlRaw =
    envVar("AUTH_PUBLIC_BASE_URL") ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    publicUrlFromEnv ??
    fileConfig?.auth?.publicBaseUrl;
  const authPublicBaseUrl = authPublicBaseUrlRaw?.trim() || undefined;
  const authBaseUrlMode: AuthBaseUrlMode =
    authBaseUrlModeFromEnv ??
    fileConfig?.auth?.baseUrlMode ??
    (authPublicBaseUrl ? "explicit" : "auto");
  const disableSignUpFromEnv = envVar("AUTH_DISABLE_SIGN_UP");
  const authDisableSignUp: boolean =
    disableSignUpFromEnv !== undefined
      ? disableSignUpFromEnv === "true"
      : (fileConfig?.auth?.disableSignUp ?? false);
  const allowedHostnamesFromEnvRaw = envVar("ALLOWED_HOSTNAMES");
  const allowedHostnamesFromEnv = allowedHostnamesFromEnvRaw
    ? allowedHostnamesFromEnvRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : null;
  const publicUrlHostname = authPublicBaseUrl
    ? (() => {
      try {
        return new URL(authPublicBaseUrl).hostname.trim().toLowerCase();
      } catch {
        return null;
      }
    })()
    : null;
  const allowedHostnames = Array.from(
    new Set(
      [
        ...(allowedHostnamesFromEnv ?? fileConfig?.server.allowedHostnames ?? []),
        ...(publicUrlHostname ? [publicUrlHostname] : []),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const companyDeletionEnvRaw = envVar("ENABLE_COMPANY_DELETION");
  const companyDeletionEnabled =
    companyDeletionEnvRaw !== undefined
      ? companyDeletionEnvRaw === "true"
      : deploymentMode === "local_trusted";
  const databaseBackupEnabled =
    envVar("DB_BACKUP_ENABLED") !== undefined
      ? envVar("DB_BACKUP_ENABLED") === "true"
      : (fileDatabaseBackup?.enabled ?? true);
  const databaseBackupIntervalMinutes = Math.max(
    1,
    Number(envVar("DB_BACKUP_INTERVAL_MINUTES")) ||
      fileDatabaseBackup?.intervalMinutes ||
      60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    Number(envVar("DB_BACKUP_RETENTION_DAYS")) ||
      fileDatabaseBackup?.retentionDays ||
      30,
  );
  const databaseBackupDir = resolveHomeAwarePath(
    envVar("DB_BACKUP_DIR") ??
      fileDatabaseBackup?.dir ??
      resolveDefaultBackupDir(),
  );

  const fileLicense = fileConfig?.license;
  const licenseEnabled =
    envVar("LICENSE_ENABLED") !== undefined
      ? envVar("LICENSE_ENABLED") === "true"
      : (fileLicense?.enabled ?? false);
  const licenseSupabaseUrl =
    envVar("LICENSE_SUPABASE_URL") ?? fileLicense?.supabaseUrl ?? "https://cmkybsmznmhclytbjnwh.supabase.co";
  const licenseSupabaseAnonKey =
    envVar("LICENSE_SUPABASE_ANON_KEY") ?? fileLicense?.supabaseAnonKey ?? "";
  const licenseHeartbeatIntervalMinutes = Math.max(
    15,
    Number(envVar("LICENSE_HEARTBEAT_INTERVAL_MINUTES")) || fileLicense?.heartbeatIntervalMinutes || 60,
  );
  const licenseGracePeriodHours = Math.max(
    1,
    Number(envVar("LICENSE_GRACE_PERIOD_HOURS")) || fileLicense?.gracePeriodHours || 24,
  );

  // ---- Sufficiency gate (PR-10) — default OFF; thresholds are hash-64 calibrated. ----
  const sufficiencyGateEnabled = envVar("SUFFICIENCY_GATE_ENABLED") === "true";
  const sufficiencyMinScoreRaw = Number(envVar("SUFFICIENCY_MIN_SCORE"));
  const sufficiencyMinScore = Number.isFinite(sufficiencyMinScoreRaw)
    ? sufficiencyMinScoreRaw
    : 0.22;
  const sufficiencyReqCoverRaw = Number(envVar("REQ_COVER_MIN"));
  const sufficiencyReqCoverMin = Number.isFinite(sufficiencyReqCoverRaw)
    ? sufficiencyReqCoverRaw
    : 0.34;

  // ---- Managed-API embeddings (PR-11) ----
  // Mirror the envVar pattern: never throw on unset. The key resolves
  // COMBYNE_EMBEDDING_API_KEY → OPENAI_API_KEY → '' (lazy validation happens in
  // the driver on first use, exactly like the summarizer driver).
  const embeddingProvider = envVar("EMBEDDING_PROVIDER") ?? "openai";
  const embeddingModel = envVar("EMBEDDING_MODEL") ?? "text-embedding-3-small";
  const embeddingDimRaw = Number(envVar("EMBEDDING_DIM"));
  const embeddingDim = Number.isFinite(embeddingDimRaw) && embeddingDimRaw > 0 ? embeddingDimRaw : 1536;
  const embeddingApiKey = envVar("EMBEDDING_API_KEY") ?? process.env.OPENAI_API_KEY ?? "";
  // COERCION (closes the chatty-fallback hole): an empty key forces vector
  // search OFF regardless of the flag, so no path can egress with no key set.
  const vectorSearchEnabled =
    envVar("VECTOR_SEARCH_ENABLED") === "true" && embeddingApiKey.length > 0;
  const embeddingMonthlyCapUsd = envVar("EMBEDDING_MONTHLY_CAP_USD") ?? "";
  const embeddingRpmRaw = Number(envVar("EMBEDDING_RPM"));
  const embeddingRpm = Number.isFinite(embeddingRpmRaw) && embeddingRpmRaw > 0 ? embeddingRpmRaw : 3000;

  return {
    deploymentMode,
    deploymentExposure,
    host: process.env.HOST ?? fileConfig?.server.host ?? "127.0.0.1",
    port: Number(process.env.PORT) || fileConfig?.server.port || 3100,
    allowedHostnames,
    authBaseUrlMode,
    authPublicBaseUrl,
    authDisableSignUp,
    databaseMode: fileDatabaseMode,
    databaseUrl: process.env.DATABASE_URL ?? fileDbUrl,
    // Separate dedicated context DB. Mirrors the envVar pattern: '' when unset →
    // resolveContextDb() falls back to the main db (single-DB mode, zero change).
    contextDatabaseUrl: envVar("CONTEXT_DATABASE_URL") ?? "",
    embeddedPostgresDataDir: resolveHomeAwarePath(
      fileConfig?.database.embeddedPostgresDataDir ?? resolveDefaultEmbeddedPostgresDir(),
    ),
    embeddedPostgresPort:
      Number(envVar("EMBEDDED_POSTGRES_PORT")) ||
      fileConfig?.database.embeddedPostgresPort ||
      54329,
    databaseBackupEnabled,
    databaseBackupIntervalMinutes,
    databaseBackupRetentionDays,
    databaseBackupDir,
    serveUi:
      process.env.SERVE_UI !== undefined
        ? process.env.SERVE_UI === "true"
        : fileConfig?.server.serveUi ?? true,
    uiDevMiddleware: envVar("UI_DEV_MIDDLEWARE") === "true",
    secretsProvider,
    secretsStrictMode,
    secretsMasterKeyFilePath:
      resolveHomeAwarePath(
        envVar("SECRETS_MASTER_KEY_FILE") ??
          fileSecrets?.localEncrypted.keyFilePath ??
          resolveDefaultSecretsKeyFilePath(),
      ),
    storageProvider,
    storageLocalDiskBaseDir,
    storageS3Bucket,
    storageS3Region,
    storageS3Endpoint,
    storageS3Prefix,
    storageS3ForcePathStyle,
    heartbeatSchedulerEnabled: process.env.HEARTBEAT_SCHEDULER_ENABLED !== "false",
    heartbeatSchedulerIntervalMs: Math.max(10000, Number(process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS) || 30000),
    companyDeletionEnabled,
    licenseEnabled,
    licenseSupabaseUrl,
    licenseSupabaseAnonKey,
    licenseHeartbeatIntervalMinutes,
    licenseGracePeriodHours,
    sufficiencyGateEnabled,
    sufficiencyMinScore,
    sufficiencyReqCoverMin,
    embeddingProvider,
    embeddingModel,
    embeddingDim,
    embeddingApiKey,
    vectorSearchEnabled,
    embeddingMonthlyCapUsd,
    embeddingRpm,
  };
}
