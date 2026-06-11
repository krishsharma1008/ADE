import { Router } from "express";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@combyne/db";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";
import { writeConfigFile, readConfigFileContextDatabaseUrl } from "../config-file.js";
import { loadConfig } from "../config.js";
import { getContextDbHealth, resolveContextDb, resolveContextDbUrl } from "../services/context-db.js";
import { accessService, logActivity } from "../services/index.js";
import { adoptPinnedCompany } from "../services/company-pin-adopt.js";

const REDACTED = "****";

/**
 * Mask the password in a Postgres connection URL. Returns the URL with the
 * password replaced by `****`. On any parse failure returns a safe placeholder
 * so a malformed URL can NEVER leak its credential into a response.
 *
 * The raw url/password is NEVER logged anywhere in this module.
 */
export function redactDbUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.password) u.password = REDACTED;
    return u.toString();
  } catch {
    return "(invalid url)";
  }
}

/** True for postgres:// or postgresql:// URLs with a host. */
function isPostgresUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const proto = u.protocol.toLowerCase();
    if (proto !== "postgres:" && proto !== "postgresql:") return false;
    return u.hostname.length > 0;
  } catch {
    return false;
  }
}

interface ProbeResult {
  ok: boolean;
  serverVersion: string | null;
  memorySchemaPresent: boolean;
  memoryEntryCount: number | null;
  error?: string;
}

async function readServerVersion(db: Db): Promise<string | null> {
  const rows = (await db.execute(sql`SELECT version() AS version`)) as unknown as Array<{
    version?: string;
  }>;
  return rows[0]?.version ?? null;
}

async function readMemorySchemaPresent(db: Db): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT to_regclass('public.memory_entries') IS NOT NULL AS present`,
  )) as unknown as Array<{ present?: boolean }>;
  return Boolean(rows[0]?.present);
}

async function readMemoryEntryCount(db: Db): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS count FROM public.memory_entries`,
  )) as unknown as Array<{ count?: number }>;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Open a THROWAWAY connection to `url`, probe version + memory schema, then
 * ALWAYS close the connection. NEVER persists. An unreachable/invalid url
 * resolves to `{ ok: false, error }` — it never throws, so the caller returns
 * 200 with ok:false rather than a 500.
 */
async function probeContextDb(
  url: string,
  opts?: { connectTimeout?: number; attempts?: number },
): Promise<ProbeResult> {
  // INTERACTIVE default (the /test + /teams + /join routes a user drives): fail FAST
  // so a bad URL never hangs onboarding ~60s. connect_timeout 15 still tolerates the
  // slow Cloud SQL TLS handshake (~14s observed) on a VALID rail, while an unreachable
  // host fails in ~15s. The BOOT probe (index.ts) passes the tolerant 30s x 2 instead —
  // boot can afford to wait and prefers an accurate reading over speed.
  const connectTimeout = opts?.connectTimeout ?? 15;
  const PROBE_ATTEMPTS = opts?.attempts ?? 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    const probe = createDb(url, { connect_timeout: connectTimeout });
    try {
      const serverVersion = await readServerVersion(probe);
      const memorySchemaPresent = await readMemorySchemaPresent(probe);
      const memoryEntryCount = memorySchemaPresent ? await readMemoryEntryCount(probe) : 0;
      return { ok: true, serverVersion, memorySchemaPresent, memoryEntryCount };
    } catch (err) {
      lastErr = err;
    } finally {
      // postgres-js client lives under the drizzle session; end it to release the
      // throwaway pool. Best-effort: never let cleanup mask the probe outcome.
      try {
        const client = (probe as unknown as { $client?: { end?: (opts?: unknown) => Promise<void> } }).$client;
        if (client?.end) await client.end({ timeout: 5 });
      } catch {
        /* ignore */
      }
    }
    if (attempt < PROBE_ATTEMPTS) await new Promise((r) => setTimeout(r, 600));
  }
  return {
    ok: false,
    serverVersion: null,
    memorySchemaPresent: false,
    memoryEntryCount: null,
    // Message only — never echo the url/credential.
    error: lastErr instanceof Error ? lastErr.message : "Connection failed",
  };
}

interface ListCompaniesResult {
  ok: boolean;
  companies: Array<{ id: string; name: string }>;
  error?: string;
}

/**
 * Open a THROWAWAY connection to `url`, list the `public.companies` registry (the
 * joinable TEAMS on a shared context DB), then ALWAYS close the connection. NEVER
 * persists. Mirrors {@link probeContextDb}: an unreachable/invalid url resolves to
 * `{ ok: false, companies: [], error }` — it never throws, so the caller returns
 * 200 with ok:false rather than a 500. The credential is NEVER echoed in `error`.
 */
async function listContextCompanies(url: string): Promise<ListCompaniesResult> {
  // Interactive (onboarding "list teams"): fail FAST on a bad URL (see probeContextDb).
  const ATTEMPTS = 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const probe = createDb(url, { connect_timeout: 15 });
    try {
      const rows = (await probe.execute(
        sql`SELECT id, name FROM public.companies ORDER BY name`,
      )) as unknown as Array<{ id?: string; name?: string }>;
      const companies = rows
        .filter((r) => typeof r.id === "string" && typeof r.name === "string")
        .map((r) => ({ id: r.id as string, name: r.name as string }));
      return { ok: true, companies };
    } catch (err) {
      lastErr = err;
    } finally {
      try {
        const client = (probe as unknown as { $client?: { end?: (opts?: unknown) => Promise<void> } }).$client;
        if (client?.end) await client.end({ timeout: 5 });
      } catch {
        /* ignore */
      }
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 600));
  }
  return {
    ok: false,
    companies: [],
    // Message only — never echo the url/credential.
    error: lastErr instanceof Error ? lastErr.message : "Connection failed",
  };
}

const urlBodySchema = z.object({ url: z.string().min(1) });

// Body for POST /instance/context-database/join. `url` is optional: when present
// it must be a postgres:// url and is persisted (restart-gated); when omitted the
// route honors the already-configured rail. teamId is the canonical shared team id
// adopted locally; teamName is used only on a fresh adopt INSERT.
const joinBodySchema = z.object({
  url: z.string().min(1).optional(),
  teamId: z.string().uuid(),
  teamName: z.string().min(1),
});

// PR-15 §3.7 — embedding-config write. The team-shared key is write-only: it is
// persisted to config.json (0600 via writeConfigFile) and NEVER returned by any
// endpoint. provider/model/dim and the disclosure-ack flag are non-secret and
// may be echoed. disclosureAcked MUST be true — the privacy reconciliation
// acknowledge gate (§1.0/§1.5) is blocking before any key is stored.
const embeddingConfigSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  apiKey: z.string().min(1).max(512),
  disclosureAcked: z.literal(true),
});

export function contextDatabaseRoutes(db: Db) {
  const router = Router();

  // (1) Current context-DB connection status — instance-admin only.
  router.get("/instance/context-database", async (req, res) => {
    assertInstanceAdmin(req);
    const cfg = loadConfig();
    const separateUrl = resolveContextDbUrl();
    const usingSeparateContextDb = separateUrl.length > 0;
    const activeDb = resolveContextDb(db);

    let serverVersion: string | null = null;
    let memorySchemaPresent = false;
    let memoryEntryCount: number | null = null;
    try {
      serverVersion = await readServerVersion(activeDb);
      memorySchemaPresent = await readMemorySchemaPresent(activeDb);
      memoryEntryCount = memorySchemaPresent ? await readMemoryEntryCount(activeDb) : 0;
    } catch {
      // Active DB unreachable: report nulls rather than 500.
    }

    // configuredVia: env wins, then config-file value, else default (single-DB).
    // config.ts loads this via envVar("CONTEXT_DATABASE_URL") which reads the
    // COMBYNE_-prefixed name, so match that exactly (not the bare name).
    const configuredVia: "env" | "config-file" | "default" = process.env.COMBYNE_CONTEXT_DATABASE_URL
      ? "env"
      : readConfigFileContextDatabaseUrl()
        ? "config-file"
        : "default";

    res.json({
      mode: cfg.databaseMode === "postgres" ? "external" : "embedded",
      usingSeparateContextDb,
      redactedEndpoint: redactDbUrl(usingSeparateContextDb ? separateUrl : cfg.databaseUrl ?? ""),
      serverVersion,
      memorySchemaPresent,
      memoryEntryCount,
      configuredVia,
    });
  });

  // (1b) Cached rail health — cheap (NO DB call; reads the in-process health
  // surface stamped by the keepalive / deadline / retry paths). Any
  // authenticated principal may read it: the UI shows a global "shared rail
  // unreachable" banner from this, and it carries no secrets (the lastError is
  // a connectivity message, never a URL/credential).
  router.get("/instance/context-database/health", (req, res) => {
    getActorInfo(req); // 401 for unauthenticated principals; no admin gate.
    const health = getContextDbHealth();
    res.json({
      usingSeparateContextDb: resolveContextDbUrl().length > 0,
      status: health.status,
      at: health.at,
      lastError: health.lastError ? String(health.lastError).slice(0, 200) : null,
    });
  });

  // (2) Test an arbitrary url WITHOUT persisting it — instance-admin only.
  router.post(
    "/instance/context-database/test",
    validate(urlBodySchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const { url } = req.body as { url: string };
      if (!isPostgresUrl(url)) {
        throw badRequest("url must be a postgres:// or postgresql:// connection string");
      }
      const result = await probeContextDb(url);
      res.json(result);
    },
  );

  // (3) Persist the url into config.json — instance-admin only. Restart required.
  router.post(
    "/instance/context-database/save",
    validate(urlBodySchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const { url } = req.body as { url: string };
      if (!isPostgresUrl(url)) {
        throw badRequest("url must be a postgres:// or postgresql:// connection string");
      }
      // Merge-write only — does NOT touch the live pool. Takes effect on restart.
      writeConfigFile({ contextDatabaseUrl: url });
      res.json({
        saved: true,
        restartRequired: true,
        redactedEndpoint: redactDbUrl(url),
      });
    },
  );

  // (3a) List the joinable teams (the companies registry) on a shared context DB
  // WITHOUT persisting anything — instance-admin only. Open join: every team is
  // returned; no key / approval. `url` is optional — when omitted the route honors
  // an already-configured rail (resolveContextDbUrl); in single-DB mode it returns
  // ok:false with an explanatory message (200). The credential is NEVER echoed.
  router.post("/instance/context-database/teams", async (req, res) => {
    assertInstanceAdmin(req);
    const body = (req.body ?? {}) as { url?: unknown };
    let url: string;
    if (body.url !== undefined) {
      if (typeof body.url !== "string" || !isPostgresUrl(body.url)) {
        throw badRequest("url must be a postgres:// or postgresql:// connection string");
      }
      url = body.url;
    } else {
      url = resolveContextDbUrl();
    }
    if (!url) {
      res.json({ ok: false, companies: [], error: "No separate context database is configured" });
      return;
    }
    res.json(await listContextCompanies(url));
  });

  // (3b) Join (adopt) an existing team — instance-admin only. Open join (no key /
  // approval): the only gate is that the team exists in the shared registry. The
  // join persists the context DB URL (restart-gated) when a NEW url is supplied,
  // adopts the local ops companies row at the team's canonical id (idempotent, no
  // clobber via adoptPinnedCompany), grants the board user membership, and returns
  // the local company so the UI can make it active. The credential is NEVER echoed.
  router.post(
    "/instance/context-database/join",
    validate(joinBodySchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const { url: bodyUrl, teamId, teamName } = req.body as {
        url?: string;
        teamId: string;
        teamName: string;
      };

      // Resolve the effective URL: an explicit (validated postgres) url, else the
      // already-configured rail. 400 when neither yields a shared context DB.
      let url: string;
      if (bodyUrl !== undefined) {
        if (!isPostgresUrl(bodyUrl)) {
          throw badRequest("url must be a postgres:// or postgresql:// connection string");
        }
        url = bodyUrl;
      } else {
        url = resolveContextDbUrl();
      }
      if (!url) {
        throw badRequest("No shared context database configured");
      }

      // Open-join membership check: the team must exist in the shared registry.
      const registry = await listContextCompanies(url);
      if (!registry.ok) {
        // Surface the probe failure without ever echoing the credential.
        throw badRequest(registry.error ?? "Could not reach the shared context database");
      }
      if (!registry.companies.some((c) => c.id === teamId)) {
        throw badRequest("Team not found in the shared context database registry");
      }

      // Persist the URL only when a NEW one was supplied — restart-gated, same
      // merge-write POST /save uses. Honoring an already-active rail re-persists
      // nothing (restartRequired:false).
      if (bodyUrl !== undefined) {
        writeConfigFile({ contextDatabaseUrl: url });
      }

      // Adopt the local ops company at id===teamId (idempotent, no-clobber).
      const result = await adoptPinnedCompany(db, { id: teamId, name: teamName });

      // Idempotent membership so a non-admin board actor sees the team in
      // GET /companies (which filters by companyIds).
      const actor = getActorInfo(req);
      await accessService(db).ensureMembership(teamId, "user", actor.actorId, "owner", "active");

      await logActivity(db, {
        companyId: teamId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "company.joined",
        entityType: "company",
        entityId: teamId,
        agentId: actor.agentId,
        runId: actor.runId,
        details: { name: teamName, action: result.action },
      });

      res.json({
        joined: true,
        // Only a NEWLY persisted url requires a restart for the memory rail; an
        // already-active rail changed nothing, so the adoption is fully effective now.
        restartRequired: bodyUrl !== undefined,
        company: { id: result.id, name: result.name, issuePrefix: result.issuePrefix },
        redactedEndpoint: redactDbUrl(url),
        action: result.action,
      });
    },
  );

  // (4) PR-15 §3.7 — persist the team-shared embedding config (provider/model +
  // the write-only API key + the privacy disclosure ack). instance-admin only.
  // The key is merge-written into config.json (0600) and NEVER echoed back in
  // the response. Restart required (mirrors the context-DB save). Validation
  // requires disclosureAcked===true — the acknowledge gate is blocking.
  router.post(
    "/instance/embedding-config",
    validate(embeddingConfigSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const { provider, model, apiKey, disclosureAcked } = req.body as {
        provider: string;
        model: string;
        apiKey: string;
        disclosureAcked: true;
      };
      // 0600 merge-write. The key lands as embeddingApiKey and is activated on the
      // NEXT restart — loadConfig reads it via the config.json bypass reader
      // (readConfigFileEmbedding), where any env var (EMBEDDING_API_KEY /
      // OPENAI_API_KEY) still wins. NEVER returned in any response.
      writeConfigFile({
        embeddingProvider: provider,
        embeddingModel: model,
        embeddingApiKey: apiKey,
        embeddingDisclosureAcked: disclosureAcked,
      });
      res.json({
        saved: true,
        restartRequired: true,
        provider,
        model,
        disclosureAcked,
        // The key is intentionally absent — write-only, never echoed.
      });
    },
  );

  return router;
}
