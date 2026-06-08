import { readConfigFile, readConfigFileContextDatabaseUrl, readConfigFileEmbedding } from "./config-file.js";
import { existsSync, readFileSync } from "node:fs";
import { config as loadDotenv, parse as parseDotenv } from "dotenv";
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
  // Parse the file BEFORE loadDotenv so we can detect the dangerous case where a
  // stale/empty process env shadows the instance .env's context URL (override is
  // false, so a present-but-empty process value wins). For the SHARED context
  // rail that silent shadow routes "shared" writes to the LOCAL ops DB — invisible
  // until a teammate sees nothing. Reconcile + warn loudly so it's diagnosable.
  let parsedEnvFile: Record<string, string> = {};
  try {
    parsedEnvFile = parseDotenv(readFileSync(COMBYNE_ENV_FILE_PATH, "utf-8"));
  } catch {
    parsedEnvFile = {};
  }
  loadDotenv({ path: COMBYNE_ENV_FILE_PATH, override: false, quiet: true });
  const fileCtx = (parsedEnvFile.COMBYNE_CONTEXT_DATABASE_URL ?? "").trim();
  const procCtx = (process.env.COMBYNE_CONTEXT_DATABASE_URL ?? "").trim();
  if (fileCtx && fileCtx !== procCtx) {
    // eslint-disable-next-line no-console -- pre-logger boot path; never logs the value
    console.warn(
      `[combyne] COMBYNE_CONTEXT_DATABASE_URL in ${COMBYNE_ENV_FILE_PATH} was shadowed by the process ` +
        `environment (process value: ${procCtx ? "<different non-empty>" : "<empty>"}); the shared context ` +
        `rail may have been routing to the local ops DB. Adopting the instance .env value.`,
    );
    process.env.COMBYNE_CONTEXT_DATABASE_URL = fileCtx;
  }
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
  /** Refuse to boot when a separate context DB is expected but missing/unreachable. */
  contextRequired: boolean;
  /** Pinned canonical company UUID for the shared context rail. '' = unenforced. */
  contextCompanyId: string;
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
   * ANN/vector-search master state. ON automatically when a DELIBERATE embedding
   * key is present — the dedicated COMBYNE_EMBEDDING_API_KEY env var or a UI-saved
   * config.json key (privacy-disclosure acked) — UNLESS COMBYNE_VECTOR_SEARCH_ENABLED
   * =false (kill-switch). A generic host OPENAI_API_KEY alone does NOT enable it:
   * that requires an explicit COMBYNE_VECTOR_SEARCH_ENABLED=true so a stray key never
   * silently egresses memory. COERCED false when no key is present (incl. all CI/test
   * runs) so the OFF state takes the hash-64 jsonb path with no provider call.
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
  // Mirror the envVar pattern: never throw on unset. Resolution is env-wins, then
  // the UI-saved config.json block (which the strict schema strips, so we read it
  // via the bypass reader — the SAME keys writeConfigFile persists on the embedding
  // -config save). Net: a key set in the Memory→Setup UI activates on next restart
  // with no env var, while any env var still takes precedence. Lazy validation
  // happens in the driver on first use, exactly like the summarizer driver.
  const fileEmbedding = readConfigFileEmbedding();
  const embeddingProvider = envVar("EMBEDDING_PROVIDER") ?? fileEmbedding?.provider ?? "openai";
  const embeddingModel = envVar("EMBEDDING_MODEL") ?? fileEmbedding?.model ?? "text-embedding-3-small";
  const embeddingDimRaw = Number(envVar("EMBEDDING_DIM"));
  const embeddingDim = Number.isFinite(embeddingDimRaw) && embeddingDimRaw > 0
    ? embeddingDimRaw
    : (fileEmbedding?.dim ?? 1536);
  const embeddingApiKey =
    envVar("EMBEDDING_API_KEY") ?? process.env.OPENAI_API_KEY ?? fileEmbedding?.apiKey ?? "";
  // A DELIBERATE embedding key is one the operator set with embedding INTENT: the
  // dedicated COMBYNE_EMBEDDING_API_KEY env var, or a key saved through the UI
  // Memory→Setup tab (config.json, which carries a privacy-disclosure ack). A
  // generic host OPENAI_API_KEY (often present for the summarizer) is NOT embedding
  // intent — it must not silently turn on remote embedding + memory egress.
  const deliberateEmbeddingKey =
    (envVar("EMBEDDING_API_KEY") ?? fileEmbedding?.apiKey ?? "").length > 0;
  // ENABLE rules (egress only ever with a key present):
  //   - flag === "false"  → OFF (kill-switch), always; no path can egress with a key.
  //   - deliberate key    → ON automatically (UI-saved or COMBYNE_EMBEDDING_API_KEY),
  //                         so the Setup tab / dedicated env var activates on restart
  //                         with no flag — UNLESS the kill-switch forces it off.
  //   - generic key only  → ON only with an EXPLICIT COMBYNE_VECTOR_SEARCH_ENABLED
  //                         =true opt-in, so a stray OPENAI_API_KEY never egresses
  //                         memory bodies without the operator asking for it.
  //   - no key            → OFF (zero egress) — re-checked in memory-embedder.ts.
  const vectorFlag = envVar("VECTOR_SEARCH_ENABLED");
  const vectorSearchEnabled =
    embeddingApiKey.length > 0 &&
    vectorFlag !== "false" &&
    (deliberateEmbeddingKey || vectorFlag === "true");
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
    // Env wins; an unset OR empty env falls back to the UI-saved config.json value
    // (which the strict schema strips), so a context URL saved in the UI is not
    // silently dropped — env precedence matches the status route.
    contextDatabaseUrl: (envVar("CONTEXT_DATABASE_URL") || readConfigFileContextDatabaseUrl()) ?? "",
    // Hard-refuse-to-boot when a separate context DB is expected but missing/
    // unreachable, instead of silently failing open to the local ops DB.
    contextRequired: envVar("CONTEXT_REQUIRED") === "true",
    // The team's pinned canonical company UUID for the shared context rail. When
    // set, memory routes assert the URL :companyId matches this pin so a mistyped
    // tenant id can't address another team's context. '' = unenforced.
    contextCompanyId: envVar("CONTEXT_COMPANY_ID") ?? "",
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

/** Minimal logger shape so this is unit-testable without the pino instance. */
type PostureLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (msg: string) => void;
};

/**
 * Log the resolved embedding/vector-retrieval posture once at startup so a
 * shared-corpus deployment can see whether THIS machine is on the real provider
 * version or the hash-64 lexical fallback. Mirrors the summarizer warn so the
 * "flag set but no key → silently coerced off" case is surfaced (CFG-3). Never
 * logs the key itself.
 */
export function logEmbeddingPosture(
  config: Pick<
    Config,
    "vectorSearchEnabled" | "embeddingApiKey" | "embeddingProvider" | "embeddingModel" | "embeddingDim"
  >,
  logger: PostureLogger,
): void {
  // Read the SAME prefixed name the coercion uses (envVar prepends COMBYNE_), so a
  // bare-flag + key deployment is diagnosed consistently rather than silently
  // ignored. The flag is now an optional kill-switch: "true" is an explicit
  // opt-in intent, "false" forces hash-64 even with a key.
  const requestedVector = process.env.COMBYNE_VECTOR_SEARCH_ENABLED === "true";
  const hasKey = config.embeddingApiKey.length > 0;
  logger.info(
    {
      vectorSearchEnabled: config.vectorSearchEnabled,
      embeddingProvider: config.embeddingProvider,
      embeddingModel: config.embeddingModel,
      embeddingDim: config.embeddingDim,
      hasKey, // never log the key itself
    },
    "embedding/vector retrieval posture",
  );
  if (requestedVector && !hasKey) {
    logger.warn(
      "VECTOR_SEARCH_ENABLED=true but no embedding API key loaded — falling back to hash-64; " +
        "shared-corpus ranking will be INCONSISTENT with teammates who have a key.",
    );
  }
}

/**
 * B-PIN-5: a SET company pin (`COMBYNE_CONTEXT_COMPANY_ID`) is only useful if some
 * LOCAL company row actually carries that id — otherwise every memory/capture
 * request that addresses any OTHER company will 403 and the pinned tenant has no
 * local home. This pure helper decides what boot should surface so it can be unit
 * tested without standing up the server (the boot code does the narrow companies
 * query and passes the ids in). Returns a `warn` string for a soft misconfig, and
 * a `throwMsg` ONLY when strict mode (`contextRequired`) should hard-fail boot.
 */
export function checkPinnedCompanyAdoption(opts: {
  contextCompanyId: string;
  localCompanyIds: string[];
  contextRequired: boolean;
}): { warn?: string; throwMsg?: string } {
  if (!opts.contextCompanyId) return {};
  if (opts.localCompanyIds.includes(opts.contextCompanyId)) return {};
  const warn =
    `COMBYNE_CONTEXT_COMPANY_ID=${opts.contextCompanyId} is set but no local company has that id. ` +
    "Memory/capture requests that address any OTHER company will 403; the pinned tenant itself still " +
    "works once adopted. Run `pnpm db:company-pin --id <uuid> --name <name>` to adopt it locally.";
  if (opts.contextRequired) {
    return {
      warn,
      throwMsg:
        "COMBYNE_CONTEXT_REQUIRED=true but COMBYNE_CONTEXT_COMPANY_ID does not match any local company row",
    };
  }
  return { warn };
}
