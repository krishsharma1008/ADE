import { Router } from "express";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@combyne/db";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertInstanceAdmin } from "./authz.js";
import { writeConfigFile, readConfigFileContextDatabaseUrl } from "../config-file.js";
import { loadConfig } from "../config.js";
import { resolveContextDb, resolveContextDbUrl } from "../services/context-db.js";

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
async function probeContextDb(url: string): Promise<ProbeResult> {
  const probe = createDb(url);
  try {
    const serverVersion = await readServerVersion(probe);
    const memorySchemaPresent = await readMemorySchemaPresent(probe);
    const memoryEntryCount = memorySchemaPresent ? await readMemoryEntryCount(probe) : 0;
    return { ok: true, serverVersion, memorySchemaPresent, memoryEntryCount };
  } catch (err) {
    return {
      ok: false,
      serverVersion: null,
      memorySchemaPresent: false,
      memoryEntryCount: null,
      // Message only — never echo the url/credential.
      error: err instanceof Error ? err.message : "Connection failed",
    };
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
}

const urlBodySchema = z.object({ url: z.string().min(1) });

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
