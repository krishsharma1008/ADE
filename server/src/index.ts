import "./types/express.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  applyPendingMigrationsLocked,
  reconcilePendingMigrationHistory,
  probeContextDb,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@combyne/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig, logEmbeddingPosture, checkPinnedCompanyAdoption } from "./config.js";
import { resolveContextDbUrl, pingContextDb } from "./services/context-db.js";
import { drainContextCaptureOutbox } from "./services/memory-capture.js";
import { drainAttachmentExtractionJobs } from "./services/attachment-extract.js";
import { contextTrace } from "./services/context-trace.js"; // CONTEXT-TRACE
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import { setupTerminalWebSocketServer } from "./realtime/terminal-ws.js";
import { heartbeatService, issueService, routineService } from "./services/index.js";
import { SummarizerQueue, setSummarizerQueue } from "./services/summarizer-queue.js";
import { makeAnthropicSummarizerDriver } from "./services/summarizer-driver-anthropic.js";
import { createPersonasRouter } from "./routes/personas.js";
import { syncPersonas } from "./services/personas.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { resolveCombyneInstanceRoot } from "./home-paths.js";

function ensureLocalAgentJwtSecret(): void {
  if (process.env.COMBYNE_AGENT_JWT_SECRET?.trim()) return;
  const secretPath = resolve(resolveCombyneInstanceRoot(), "secrets", "agent-jwt.key");
  let secret: string | null = null;
  if (existsSync(secretPath)) {
    try {
      const content = readFileSync(secretPath, "utf8").trim();
      if (content.length >= 32) secret = content;
    } catch {
      secret = null;
    }
  }
  if (!secret) {
    secret = randomBytes(48).toString("base64url");
    try {
      mkdirSync(resolve(resolveCombyneInstanceRoot(), "secrets"), { recursive: true });
      writeFileSync(secretPath, secret, { encoding: "utf8" });
      try { chmodSync(secretPath, 0o600); } catch {}
      logger.info({ secretPath }, "Generated local agent JWT secret for first run");
    } catch (err) {
      logger.warn({ err, secretPath }, "Failed to persist generated agent JWT secret; using in-memory value");
    }
  }
  process.env.COMBYNE_AGENT_JWT_SECRET = secret;
}

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
  const config = loadConfig();
  if (process.env.COMBYNE_SECRETS_PROVIDER === undefined) {
    process.env.COMBYNE_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.COMBYNE_SECRETS_STRICT_MODE === undefined) {
    process.env.COMBYNE_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.COMBYNE_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.COMBYNE_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)"
    | "pending migrations skipped";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    // "never" means never prompt — auto-apply silently (safe for dev watch mode
    // where stdin is not available). Previously this returned false which caused
    // pending migrations to be silently skipped, breaking fresh clones that pull
    // schema updates with new columns.
    if (process.env.COMBYNE_MIGRATION_PROMPT === "never") return true;
    if (process.env.COMBYNE_MIGRATION_AUTO_APPLY === "true") return true;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };
  
  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        logger.warn(
          { pendingMigrations: state.pendingMigrations },
          `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
        );
        return "pending migrations skipped";
      }
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      logger.warn(
        { pendingMigrations: state.pendingMigrations },
        `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
      );
      return "pending migrations skipped";
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@combyne.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: companies.id }).from(companies);
    for (const company of companyRows) {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);
      if (membership) continue;
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  }
  
  let db;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  if (config.databaseUrl) {
    migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const embeddedPostgresLogBuffer: string[] = [];
    const EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT = 120;
    const verboseEmbeddedPostgresLogs = process.env.COMBYNE_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      const text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message ?? "");
      for (const lineRaw of text.split(/\r?\n/)) {
        const line = lineRaw.trim();
        if (!line) continue;
        embeddedPostgresLogBuffer.push(line);
        if (embeddedPostgresLogBuffer.length > EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT) {
          embeddedPostgresLogBuffer.splice(0, embeddedPostgresLogBuffer.length - EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT);
        }
        if (verboseEmbeddedPostgresLogs) {
          logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
        }
      }
    };
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      if (embeddedPostgresLogBuffer.length > 0) {
        logger.error(
          {
            phase,
            recentLogs: embeddedPostgresLogBuffer,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  
    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
      } catch {
        return null;
      }
    };
  
    const runningPid = getRunningPid();
    if (runningPid) {
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      const detectedPort = await detectPort(configuredPort);
      if (detectedPort !== configuredPort) {
        throw new Error(
          `Embedded PostgreSQL port ${configuredPort} is already in use by another process. ` +
            `Either stop that process or override the port with COMBYNE_EMBEDDED_POSTGRES_PORT ` +
            `(e.g. COMBYNE_EMBEDDED_POSTGRES_PORT=${detectedPort} pnpm dev).`,
        );
      }
      port = configuredPort;
      logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
      embeddedPostgres = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "combyne",
        password: "combyne",
        port,
        persistent: true,
        onLog: appendEmbeddedPostgresLog,
        onError: appendEmbeddedPostgresLog,
      });
  
      if (!clusterAlreadyInitialized) {
        try {
          await embeddedPostgres.initialise();
        } catch (err) {
          logEmbeddedPostgresFailure("initialise", err);
          throw err;
        }
      } else {
        logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
      }
  
      if (existsSync(postmasterPidFile)) {
        logger.warn("Removing stale embedded PostgreSQL lock file");
        rmSync(postmasterPidFile, { force: true });
      }
      try {
        await embeddedPostgres.start();
      } catch (err) {
        logEmbeddedPostgresFailure("start", err);
        throw err;
      }
      embeddedPostgresStartedByThisProcess = true;
    }
  
    const embeddedAdminConnectionString = `postgres://combyne:combyne@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "combyne");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: combyne");
    }
  
    const embeddedConnectionString = `postgres://combyne:combyne@127.0.0.1:${port}/combyne`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });
  
    db = createDb(embeddedConnectionString);
    logger.info("Embedded PostgreSQL ready");
    logger.info(
      `Postgres ready at ${embeddedConnectionString} ` +
        `(pgAdmin: host=127.0.0.1 port=${port} user=combyne password=combyne database=combyne)`,
    );
    activeDatabaseConnectionString = embeddedConnectionString;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }

  // ---- Separate dedicated context DB (CONTEXT_DATABASE_URL) ----
  // When a distinct context DB is configured the memory layer physically lives
  // there, so its tables must exist. Migrate it too. Guarded so single-DB mode
  // (unset, or equal to the main URL) is entirely unchanged.
  // NOTE: the context DB receives the FULL migration set today; the extra
  // operational tables go unused. A context-only migration subset is a future
  // optimization.
  if (config.contextDatabaseUrl && config.contextDatabaseUrl !== activeDatabaseConnectionString) {
    // The context DB is REMOTE (Cloud SQL over the public internet) and is the
    // ONE DB that N teammate boots contend over. So:
    //  - default teammate boot is INSPECT-ONLY (never auto-applies to the shared
    //    remote → no concurrent-apply race; MIGPROV-1/2);
    //  - the explicit operator one-shot (COMBYNE_CONTEXT_DB_MIGRATE=true) applies
    //    under a pg_advisory_lock so even concurrent operators serialize;
    //  - a transient outage / collision must NOT crash boot and take the fully
    //    local, healthy heartbeat down with it (I4) — unless the operator asked
    //    to migrate, where failing loudly is correct.
    const isDesignatedMigrator = process.env.COMBYNE_CONTEXT_DB_MIGRATE === "true";
    try {
      if (isDesignatedMigrator) {
        logger.info("Designated context-DB migrator; ensuring shared memory-layer schema (advisory-lock gated)");
        await applyPendingMigrationsLocked(config.contextDatabaseUrl);
      } else {
        const state = await inspectMigrations(config.contextDatabaseUrl);
        if (state.status !== "upToDate") {
          const pending = state.status === "needsMigrations" ? state.pendingMigrations : [];
          logger.warn(
            { pendingMigrations: pending, count: pending.length },
            "Shared context DB has pending migrations but this machine is NOT the designated migrator. " +
              "Run the one-shot provisioning step (COMBYNE_CONTEXT_DB_MIGRATE=true pnpm db:migrate:context) " +
              "before relying on new context schema. Continuing WITHOUT applying.",
          );
        } else {
          logger.info("Shared context DB schema verified up-to-date.");
        }
      }
    } catch (err) {
      if (isDesignatedMigrator) {
        throw err; // explicit operator one-shot: fail loudly
      }
      logger.error(
        { err },
        "Context DB schema check failed at boot; continuing without it. The memory/context layer " +
          "degrades gracefully until the remote DB is reachable and migrated. Run " +
          "`COMBYNE_CONTEXT_DB_MIGRATE=true pnpm db:migrate:context` once to provision the schema.",
      );
    }

    // Fail-loud posture check: surface whether the shared rail is actually
    // separate + reachable + schema-present, so a silent fail-open to the local
    // ops DB (or a mis-wired/unreachable URL) is visible instead of mysterious.
    const resolvedContextUrl = resolveContextDbUrl();
    if (!resolvedContextUrl) {
      logger.warn(
        { contextDbConfigured: false },
        "CONTEXT DB NOT SEPARATE: memory/context writes will use the LOCAL ops DB and will NOT be " +
          "visible to teammates. Set COMBYNE_CONTEXT_DATABASE_URL to a separate Postgres.",
      );
      if (config.contextRequired) {
        throw new Error("COMBYNE_CONTEXT_REQUIRED=true but no separate context DB is configured");
      }
    } else {
      const probe = await probeContextDb(resolvedContextUrl);
      let redactedHost = "<unparseable>";
      try {
        redactedHost = new URL(resolvedContextUrl).host;
      } catch {
        /* keep placeholder */
      }
      if (!probe.ok || !probe.memorySchemaPresent) {
        logger.warn(
          { contextDbConfigured: true, host: redactedHost, reachable: probe.ok, schemaPresent: probe.memorySchemaPresent },
          "CONTEXT DB configured but unreachable or missing memory_entries schema; shared context may silently fail.",
        );
        if (config.contextRequired) {
          throw new Error("COMBYNE_CONTEXT_REQUIRED=true but the context DB probe failed (unreachable or no schema)");
        }
      } else {
        logger.info({ host: redactedHost }, "Shared context DB reachable; memory layer routing to the shared rail.");
      }
      // CONTEXT-TRACE: confirm the memory layer is routing to a SEPARATE rail (not ops).
      contextTrace("context_db_route", {
        contextHost: redactedHost,
        sameAsOperational: false,
        reachable: probe.ok,
        schemaPresent: probe.memorySchemaPresent,
        vectorSearchEnabled: config.vectorSearchEnabled,
      });
      // B-PIN-5: when a company pin is set, surface whether any LOCAL company row
      // actually carries that id. Without adoption, only the pinned tenant works and
      // every other companyId 403s. Narrow probe query; a transient read failure must
      // not convert a soft misconfig into a boot crash, so .catch → null (no rows).
      if (config.contextCompanyId) {
        const localCompanyIds = await db
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.id, config.contextCompanyId))
          .then((rows: Array<{ id: string }>) => rows.map((r) => r.id))
          .catch(() => [] as string[]);
        const adoption = checkPinnedCompanyAdoption({
          contextCompanyId: config.contextCompanyId,
          localCompanyIds,
          contextRequired: config.contextRequired,
        });
        if (adoption.warn) {
          logger.warn({ pinnedCompanyId: config.contextCompanyId }, adoption.warn);
        }
        if (adoption.throwMsg) {
          throw new Error(adoption.throwMsg);
        }
      }
    }
  } else {
    logger.warn(
      { contextDbConfigured: false },
      "CONTEXT DB NOT SEPARATE: memory/context writes use the LOCAL ops DB (single-DB mode) and are NOT " +
        "shared with teammates. Set COMBYNE_CONTEXT_DATABASE_URL to enable the shared context rail.",
    );
    if (config.contextRequired) {
      throw new Error("COMBYNE_CONTEXT_REQUIRED=true but no separate context DB is configured");
    }
  }

  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    logger.warn(
      `local_trusted mode is binding to ${config.host} (non-loopback). ` +
        "Consider using authenticated mode for production deployments.",
    );
  }
  
  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (config.deploymentMode === "local_trusted") {
    ensureLocalAgentJwtSecret();
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const betterAuthSecret =
      process.env.BETTER_AUTH_SECRET?.trim() ??
      process.env.COMBYNE_AGENT_JWT_SECRET?.trim();
    if (!betterAuthSecret) {
      throw new Error(
        "authenticated mode requires BETTER_AUTH_SECRET (or COMBYNE_AGENT_JWT_SECRET) to be set",
      );
    }
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    authReady = true;
  }
  
  // ── License validation gate ──────────────────────────────────────────────
  let licenseConfig: import("./services/license.js").LicenseConfig | undefined;
  let startupLicenseInfo: {
    status: string;
    planTier?: string;
    validUntil?: string;
  } = { status: "not_activated" };
  if (config.licenseEnabled) {
    const {
      readLicenseCache,
      isLicenseCacheValid,
      validateLicenseRemote,
      writeLicenseCache,
      getMachineFingerprint,
    } = await import("./services/license.js");
    const { setLicenseState } = await import("./middleware/license-gate.js");

    licenseConfig = {
      supabaseUrl: config.licenseSupabaseUrl,
      supabaseAnonKey: config.licenseSupabaseAnonKey,
      gracePeriodHours: config.licenseGracePeriodHours,
    };

    const cache = readLicenseCache();
    if (!cache) {
      logger.warn("No license activation found — license will need to be activated via the UI");
      startupLicenseInfo = { status: "not_activated" };
    } else {
      const cacheCheck = isLicenseCacheValid(cache, config.licenseGracePeriodHours);

      if (!cacheCheck.valid && cacheCheck.reason === "revoked") {
        setLicenseState("revoked");
        startupLicenseInfo = { status: "revoked", planTier: cache.planTier, validUntil: cache.validUntil };
        logger.error("License has been revoked");
      } else if (!cacheCheck.valid) {
        // Try a remote validation before giving up
        try {
          const fingerprint = await getMachineFingerprint();
          const result = await validateLicenseRemote({
            licenseKey: cache.licenseKey,
            machineFingerprint: fingerprint,
            action: "heartbeat",
            appVersion: "0.2.7",
            supabaseUrl: config.licenseSupabaseUrl,
            supabaseAnonKey: config.licenseSupabaseAnonKey,
          });
          if (result.valid) {
            writeLicenseCache({
              ...cache,
              lastValidated: new Date().toISOString(),
              status: "active",
            });
            setLicenseState("valid");
            startupLicenseInfo = { status: "valid", planTier: cache.planTier, validUntil: cache.validUntil };
            logger.info("License validated successfully on startup");
          } else {
            if (result.error === "license_revoked") {
              setLicenseState("revoked");
              startupLicenseInfo = { status: "revoked" };
            } else if (result.error === "license_expired") {
              setLicenseState("expired");
              startupLicenseInfo = { status: "expired" };
            }
            logger.warn({ error: result.error }, "License validation failed on startup");
          }
        } catch (err) {
          // Network failure — check if within grace period
          if (cacheCheck.reason === "expired_beyond_grace") {
            setLicenseState("expired");
            logger.error(
              { lastValidated: cache.lastValidated },
              "License expired and could not be re-validated (beyond grace period)",
            );
          } else {
            logger.warn({ err }, "Could not reach license server on startup, grace period active");
          }
        }
      } else {
        setLicenseState("valid");
        startupLicenseInfo = { status: "valid", planTier: cache.planTier, validUntil: cache.validUntil };
        logger.info(
          { planTier: cache.planTier, validUntil: cache.validUntil },
          "License valid",
        );
      }
    }
  }

  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const healthDatabaseInfo = (() => {
    if (startupDbInfo.mode === "embedded-postgres") {
      return {
        mode: "embedded-postgres" as const,
        host: "127.0.0.1",
        port: startupDbInfo.port,
        database: "combyne",
      };
    }
    try {
      const parsed = new URL(startupDbInfo.connectionString);
      return {
        mode: "external-postgres" as const,
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : null,
        database: parsed.pathname.replace(/^\//, "") || "postgres",
      };
    } catch {
      return {
        mode: "external-postgres" as const,
        host: "unknown",
        port: null,
        database: "unknown",
      };
    }
  })();

  const app = await createApp(db as any, {
    uiMode,
    storageService,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    betterAuthHandler,
    resolveSession,
    licenseConfig,
    database: healthDatabaseInfo,
  });
  app.use("/api/personas", createPersonasRouter({
    supabaseUrl: config.licenseSupabaseUrl,
    supabaseAnonKey: config.licenseSupabaseAnonKey,
  }));

  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);
  const listenPort = await detectPort(config.port);
  
  if (listenPort !== config.port) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiHost =
    runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
      ? "localhost"
      : runtimeListenHost;
  process.env.COMBYNE_LISTEN_HOST = runtimeListenHost;
  process.env.COMBYNE_LISTEN_PORT = String(listenPort);
  process.env.COMBYNE_API_URL = `http://${runtimeApiHost}:${listenPort}`;
  
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });
  setupTerminalWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });
  
  // Round 3 Phase 6 PR 6.3 — wire the summarizer queue + driver singleton
  // before heartbeats start executing. Opt-in via COMBYNE_SUMMARIZER_ENABLED
  // (default off while we finish PR 6.4–6.6). When disabled or when no
  // Anthropic key is available, the post-run hook no-ops silently.
  {
    const flag = process.env.COMBYNE_SUMMARIZER_ENABLED;
    const summarizerEnabled = flag === "1" || flag === "true";
    const hasKey =
      !!(process.env.COMBYNE_SUMMARIZER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
    if (summarizerEnabled && hasKey) {
      setSummarizerQueue(
        new SummarizerQueue({ driver: makeAnthropicSummarizerDriver() }),
      );
      logger.info("summarizer queue enabled (Anthropic driver)");
    } else if (summarizerEnabled && !hasKey) {
      logger.warn(
        "COMBYNE_SUMMARIZER_ENABLED set but no ANTHROPIC_API_KEY available — summarizer disabled",
      );
    }
  }

  // Log the resolved embedding/vector-retrieval posture once at startup so a
  // shared-corpus deployment can tell whether this machine is on the real
  // provider version or the hash-64 lexical fallback (CFG-3).
  logEmbeddingPosture(config, logger);

  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any);
    const routines = routineService(db as any);
    const issuesSvc = issueService(db as any);

    // Awaiting-user backstop sweeper. Closes tickets stuck in
    // awaiting_user past the configured threshold so they never
    // become permanently stale. 0 disables the sweep entirely.
    const AWAITING_USER_AUTOCLOSE_DAYS = Math.max(
      0,
      Number(process.env.AWAITING_USER_AUTOCLOSE_DAYS ?? "7") || 0,
    );
    const AWAITING_USER_AUTOCLOSE_MS =
      AWAITING_USER_AUTOCLOSE_DAYS * 24 * 60 * 60 * 1000;
    const AWAITING_USER_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
    let lastAwaitingUserSweepAt = 0;

    // Stale agent-self-block recovery. An agent can park an issue in `blocked`
    // (blockedSource='agent') from a free-text blocker; if its blockers later clear
    // with no answer/approval event, nothing wakes it. This sweep recovers such an
    // issue once it is older than COMBYNE_SELF_BLOCK_REEVAL_MS (default 30min) and all
    // four auto-close blocker probes are absent. Same 30-min tick gate as awaiting_user.
    const SELF_BLOCK_REEVAL_MS = Math.max(
      0,
      Number(process.env.COMBYNE_SELF_BLOCK_REEVAL_MS ?? `${30 * 60 * 1000}`) || 0,
    );
    const SELF_BLOCK_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
    let lastSelfBlockSweepAt = 0;

    // Issue 4 — usage-pause boot recovery MUST run before reapOrphanedRuns so
    // the reaper sees a clean window set: it deletes windows whose run is gone
    // or no longer paused_usage and leaves valid ones for the resume poller.
    // A window whose reset elapsed while ADE was down is picked up on the first
    // post-boot poll (nextRetryAt/resetsAt <= now). No-ops when the flag is off.
    const usagePauseEnabledFlag = process.env.COMBYNE_USAGE_PAUSE_ENABLED === "true";
    const bootUsagePauseRecovery = usagePauseEnabledFlag
      ? heartbeat.bootRecoverUsagePausedRuns().catch((err) => {
          logger.error({ err }, "startup usage-pause boot recovery failed");
          return null;
        })
      : Promise.resolve(null);

    // Reap orphaned runs at startup (no threshold -- runningProcesses is empty).
    // Chained AFTER usage-pause boot recovery so the ordering invariant holds.
    void bootUsagePauseRecovery
      .then(() => heartbeat.reapOrphanedRuns())
      .catch((err) => {
        logger.error({ err }, "startup reap of orphaned heartbeat runs failed");
      });
    // Also sweep issue-side lock leaks at startup — runs that finalized
    // but whose issue rows never released the executionRunId pointer.
    void heartbeat.reapOrphanedIssueLocks().catch((err) => {
      logger.error({ err }, "startup reap of orphaned issue locks failed");
    });
    void heartbeat
      .reopenIssuesAutoClosedAfterTokenPause()
      .then((result) => {
        if (result.reopened > 0) {
          logger.warn(
            { reopened: result.reopened },
            "startup repair reopened issues auto-closed after token pauses",
          );
        }
      })
      .catch((err) => {
        logger.error({ err }, "startup repair of token-pause auto-closed issues failed");
      });

    // Round 3 Phase 12 — run auto-close sweep on a slower cadence. 15-min
    // tick is enough: thresholds are user-configured in hours/days.
    let lastRoutineAutoCloseAt = 0;
    const ROUTINE_AUTO_CLOSE_INTERVAL_MS = 15 * 60 * 1000;

    // In-flight guards (F3): the heartbeat tick (every ~30s) fires the context-capture
    // outbox drain and the attachment-extraction drain. A drain slower than the tick
    // (a sluggish remote context DB, or a model call) would otherwise overlap itself
    // and re-select the SAME due rows — double-charging the Claude vision/document
    // call. These non-tick-local flags (mirroring the usage/backup/license pollers
    // below) let each tick skip its own drain while a prior one is still running.
    let contextOutboxDrainInFlight = false;
    let attachmentDrainInFlight = false;

    // Context-rail keepalive: when a SEPARATE context DB is configured, ping it on a
    // short cadence to keep at least one pooled connection WARM. A Cloud SQL public
    // IP across a high-latency/lossy link can take many seconds to TLS-handshake, so
    // without this a user request that lands on a cold/idle-dropped socket pays that
    // cost (or times out). The ping also refreshes the rail-health surface. No-op in
    // single-DB mode (pingContextDb returns immediately). 45s < typical NAT idle TTL.
    if (resolveContextDbUrl()) {
      let contextPingInFlight = false;
      const runContextPing = () => {
        if (contextPingInFlight) return;
        contextPingInFlight = true;
        void pingContextDb(db as any).finally(() => {
          contextPingInFlight = false;
        });
      };
      runContextPing(); // warm immediately at boot so the first UI request is fast
      setInterval(runContextPing, 45 * 1000);
    }

    setInterval(() => {
      void heartbeat
        .tickTimers(new Date())
        .then((result) => {
          if (result.enqueued > 0) {
            logger.info({ ...result }, "heartbeat timer tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "heartbeat timer tick failed");
        });

      // Periodically reap orphaned runs (5-min staleness threshold)
      void heartbeat
        .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
        .catch((err) => {
          logger.error({ err }, "periodic reap of orphaned heartbeat runs failed");
        });

      // Drain the durable context-capture outbox: replay any human-answer /
      // PR-approval memory writes that failed when the remote context DB was
      // unreachable, so an irreplaceable human-sourced answer is never lost (I4).
      if (!contextOutboxDrainInFlight) {
        contextOutboxDrainInFlight = true;
        void drainContextCaptureOutbox(db as any)
          .catch((err) => {
            logger.error({ err }, "context capture outbox drain failed");
          })
          .finally(() => {
            contextOutboxDrainInFlight = false;
          });
      }

      // Phase F (INFRA_FIXES_PLAN): drain the multi-modal Q&A attachment-extraction
      // queue. For each due job, fetch the PDF/image bytes and run the Claude
      // vision/document pass OUT OF BAND (kept off the answer route so it stays
      // fast), then capture the extracted content into the central DB. Best-effort
      // and self-contained (never throws); a no-key deploy skips gracefully. Guarded
      // so a drain slower than the 30s tick never overlaps itself and double-charges
      // the model on the same job (F3).
      if (!attachmentDrainInFlight) {
        attachmentDrainInFlight = true;
        void drainAttachmentExtractionJobs(db as any, { storage: storageService })
          .catch((err) => {
            logger.error({ err }, "attachment extraction drain failed");
          })
          .finally(() => {
            attachmentDrainInFlight = false;
          });
      }

      // Round 3 Phase 8 — companion issue-side sweep. Cheap LEFT JOIN on
      // issues with non-null execution_run_id; catches the lock-leak mode
      // described in docs/plans/round3/07-stuck-locks.md.
      void heartbeat
        .reapOrphanedIssueLocks()
        .catch((err) => {
          logger.error({ err }, "periodic reap of orphaned issue locks failed");
        });

      const now = Date.now();
      if (now - lastRoutineAutoCloseAt >= ROUTINE_AUTO_CLOSE_INTERVAL_MS) {
        lastRoutineAutoCloseAt = now;
        void routines
          .autoCloseExpiredRoutineIssues(new Date(now))
          .then((result) => {
            if (result.closed > 0) {
              logger.info({ closed: result.closed }, "routine auto-close tick closed expired issues");
            }
          })
          .catch((err) => {
            logger.error({ err }, "routine auto-close tick failed");
          });
      }

      if (
        AWAITING_USER_AUTOCLOSE_MS > 0 &&
        now - lastAwaitingUserSweepAt >= AWAITING_USER_SWEEP_INTERVAL_MS
      ) {
        lastAwaitingUserSweepAt = now;
        void issuesSvc
          .autoCloseStaleAwaitingUserIssues(new Date(now), AWAITING_USER_AUTOCLOSE_MS)
          .then((result) => {
            if (result.closed > 0) {
              logger.info(
                { closed: result.closed, thresholdDays: AWAITING_USER_AUTOCLOSE_DAYS },
                "awaiting_user sweeper closed stale issues",
              );
            }
          })
          .catch((err) => {
            logger.error({ err }, "awaiting_user sweeper tick failed");
          });
      }

      if (
        SELF_BLOCK_REEVAL_MS > 0 &&
        now - lastSelfBlockSweepAt >= SELF_BLOCK_SWEEP_INTERVAL_MS
      ) {
        lastSelfBlockSweepAt = now;
        void issuesSvc
          .reEvaluateStaleAgentSelfBlocks(new Date(now), SELF_BLOCK_REEVAL_MS)
          .then((result) => {
            if (result.recovered > 0) {
              logger.info(
                { recovered: result.recovered },
                "self-block sweeper recovered stale agent self-blocked issues",
              );
            }
          })
          .catch((err) => {
            logger.error({ err }, "self-block sweeper tick failed");
          });
      }
    }, config.heartbeatSchedulerIntervalMs);

    // Issue 4 — usage-pause resume poller. Independent 60s cadence (the resume
    // decision is reset-time driven, not heartbeat driven). Gated by
    // COMBYNE_USAGE_PAUSE_ENABLED; resumeUsagePausedRuns() itself also no-ops
    // when the flag is off, so this is belt-and-suspenders.
    if (usagePauseEnabledFlag) {
      const USAGE_PAUSE_POLL_INTERVAL_MS = 60 * 1000;
      let usagePausePollInFlight = false;
      setInterval(() => {
        if (usagePausePollInFlight) return;
        usagePausePollInFlight = true;
        void heartbeat
          .resumeUsagePausedRuns(new Date())
          .then((result) => {
            if (result.resumed > 0) {
              logger.info({ ...result }, "usage-pause poll resumed runs");
            }
          })
          .catch((err) => {
            logger.error({ err }, "usage-pause resume poll failed");
          })
          .finally(() => {
            usagePausePollInFlight = false;
          });
      }, USAGE_PAUSE_POLL_INTERVAL_MS);
    }
  }

  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
    let backupInFlight = false;
  
    const runScheduledBackup = async () => {
      if (backupInFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }
  
      backupInFlight = true;
      try {
        const result = await runDatabaseBackup({
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retentionDays: config.databaseBackupRetentionDays,
          filenamePrefix: "combyne",
        });
        logger.info(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: result.prunedCount,
            backupDir: config.databaseBackupDir,
            retentionDays: config.databaseBackupRetentionDays,
          },
          `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
        );
      } catch (err) {
        logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
      } finally {
        backupInFlight = false;
      }
    };
  
    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionDays: config.databaseBackupRetentionDays,
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled (OPS DB only)",
    );
    // BACKUP-1: the automatic backup covers only the LOCAL ops DB (throwaway). The
    // SHARED context DB — the one irreplaceable, durable rail — is NOT covered here
    // on purpose: runDatabaseBackup is a destructive DROP TABLE … CASCADE dumper
    // that must never be pointed at a live shared remote DB. Surface the gap loudly
    // so the operator wires the right DR (managed Cloud SQL automated backups, or a
    // scheduled non-destructive `pnpm db:memory-export` against the context URL).
    if (resolveContextDbUrl()) {
      logger.warn(
        "SHARED CONTEXT DB IS NOT COVERED BY THIS AUTOMATIC BACKUP (it backs up the throwaway ops DB only). " +
          "The context DB holds the irreplaceable shared memory/trust-spine — enable managed backups on the " +
          "context Postgres (e.g. Cloud SQL automated backups + PITR) or schedule `pnpm db:memory-export` " +
          "against COMBYNE_CONTEXT_DATABASE_URL. See doc/CENTRAL_DB_RUNBOOK.md.",
      );
    }
    setInterval(() => {
      void runScheduledBackup();
    }, backupIntervalMs);
  }
  
  // ── License heartbeat (periodic Supabase validation) ─────────────────────
  if (config.licenseEnabled && licenseConfig) {
    const licenseHeartbeatIntervalMs = config.licenseHeartbeatIntervalMinutes * 60 * 1000;
    let licenseHeartbeatInFlight = false;

    const runLicenseHeartbeat = async () => {
      if (licenseHeartbeatInFlight) return;
      licenseHeartbeatInFlight = true;
      try {
        const { performLicenseHeartbeat } = await import("./services/license.js");
        const { setLicenseState } = await import("./middleware/license-gate.js");
        const result = await performLicenseHeartbeat(licenseConfig!);
        if (result.valid) {
          setLicenseState("valid");
          logger.info("License heartbeat: valid");
        } else {
          if (result.error === "license_revoked") {
            setLicenseState("revoked");
            logger.error("License heartbeat: license revoked");
          } else if (result.error === "license_expired") {
            setLicenseState("expired");
            logger.warn("License heartbeat: license expired");
          } else if (result.error === "network_error") {
            // Keep current state — grace period applies
            logger.warn({ error: result.message }, "License heartbeat: Supabase unreachable, grace period active");
          } else {
            logger.warn({ error: result.error }, "License heartbeat: validation failed");
          }
        }
      } catch (err) {
        logger.warn({ err }, "License heartbeat: unexpected error");
      } finally {
        licenseHeartbeatInFlight = false;
      }
    };

    logger.info(
      { intervalMinutes: config.licenseHeartbeatIntervalMinutes },
      "License heartbeat enabled",
    );
    setInterval(() => {
      void runLicenseHeartbeat();
    }, licenseHeartbeatIntervalMs);
    // Run first heartbeat after 5 minutes (don't block startup)
    setTimeout(() => {
      void runLicenseHeartbeat();
    }, 5 * 60 * 1000);
  }

  // Sync agent personas in background (non-blocking)
  if (config.licenseEnabled) {
    syncPersonas({
      supabaseUrl: config.licenseSupabaseUrl,
      supabaseAnonKey: config.licenseSupabaseAnonKey,
    }).then((personas) => {
      if (personas.length > 0) {
        logger.info(`Synced ${personas.length} agent persona file(s)`);
      }
    }).catch((err) => {
      logger.warn({ err }, "Failed to sync agent personas on startup");
    });
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      if (process.env.COMBYNE_OPEN_ON_LISTEN === "true") {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
      printStartupBanner({
        host: config.host,
        deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: config.port,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
        ...(config.licenseEnabled
          ? {
              licenseEnabled: true,
              licenseStatus: startupLicenseInfo.status,
              licensePlanTier: startupLicenseInfo.planTier,
              licenseValidUntil: startupLicenseInfo.validUntil,
              licenseHeartbeatIntervalMinutes: config.licenseHeartbeatIntervalMinutes,
            }
          : {}),
      });

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

      resolveListen();
    });
  });
  
  if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      logger.info({ signal }, "Stopping embedded PostgreSQL");
      try {
        await embeddedPostgres?.stop();
      } catch (err) {
        logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
      } finally {
        process.exit(0);
      }
    };
  
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: process.env.COMBYNE_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Combyne server failed to start");
    process.exit(1);
  });
}
