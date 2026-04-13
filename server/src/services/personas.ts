/**
 * Combyne AI — Agent Personas Service
 *
 * Fetches agent persona files from Supabase, gated by license.
 * Caches locally at ~/.combyne-ai/personas/
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getMachineFingerprint, readLicenseCache } from "./license.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PersonaFile {
  persona_key: string;
  file_name: string;
  content: string;
  version: number;
  updated_at: string;
}

export interface PersonaFetchResult {
  plan_tier: string;
  personas: PersonaFile[];
}

export interface PersonaCacheManifest {
  fetchedAt: string;
  planTier: string;
  personas: Array<{
    persona_key: string;
    file_name: string;
    version: number;
    updated_at: string;
  }>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PERSONAS_CACHE_DIR = join(homedir(), ".combyne-ai", "personas");
const PERSONAS_MANIFEST_PATH = join(PERSONAS_CACHE_DIR, "manifest.json");
const SUPABASE_PERSONAS_FUNCTION_PATH = "/functions/v1/get-agent-personas";

// Cache validity: 24 hours
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Cache Management ─────────────────────────────────────────────────────────

function ensureCacheDir(): void {
  mkdirSync(PERSONAS_CACHE_DIR, { recursive: true });
}

function personaFilePath(personaKey: string, fileName: string): string {
  const dir = join(PERSONAS_CACHE_DIR, personaKey);
  mkdirSync(dir, { recursive: true });
  return join(dir, fileName);
}

export function readCacheManifest(): PersonaCacheManifest | null {
  try {
    if (!existsSync(PERSONAS_MANIFEST_PATH)) return null;
    return JSON.parse(readFileSync(PERSONAS_MANIFEST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeCacheManifest(manifest: PersonaCacheManifest): void {
  ensureCacheDir();
  writeFileSync(PERSONAS_MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
}

function isCacheValid(manifest: PersonaCacheManifest | null): boolean {
  if (!manifest) return false;
  const fetchedAt = new Date(manifest.fetchedAt).getTime();
  return Date.now() - fetchedAt < CACHE_TTL_MS;
}

// ── Remote Fetch ─────────────────────────────────────────────────────────────

export async function fetchPersonasFromSupabase(opts: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  personaKey?: string;
  fileName?: string;
}): Promise<PersonaFetchResult | null> {
  const cache = readLicenseCache();
  if (!cache) return null;

  const fingerprint = await getMachineFingerprint();
  const url = `${opts.supabaseUrl}${SUPABASE_PERSONAS_FUNCTION_PATH}`;

  const body: Record<string, string> = {
    license_key: cache.licenseKey,
    machine_fingerprint: fingerprint,
  };
  if (opts.personaKey) body.persona_key = opts.personaKey;
  if (opts.fileName) body.file_name = opts.fileName;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.supabaseAnonKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`Personas fetch failed: HTTP ${response.status} ${text.slice(0, 200)}`);
      return null;
    }

    return (await response.json()) as PersonaFetchResult;
  } catch (err) {
    console.error("Personas fetch error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── High-Level Operations ────────────────────────────────────────────────────

/**
 * Sync personas from Supabase and cache locally.
 * Returns cached data if still valid, or fetches fresh.
 */
export async function syncPersonas(opts: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  force?: boolean;
}): Promise<PersonaFile[]> {
  const manifest = readCacheManifest();

  // Return cached if valid and not forced
  if (!opts.force && isCacheValid(manifest)) {
    return readCachedPersonas(manifest!);
  }

  // Fetch fresh from Supabase
  const result = await fetchPersonasFromSupabase({
    supabaseUrl: opts.supabaseUrl,
    supabaseAnonKey: opts.supabaseAnonKey,
  });

  if (!result) {
    // Fallback to cache if fetch fails
    if (manifest) {
      return readCachedPersonas(manifest);
    }
    return [];
  }

  // Write to cache
  ensureCacheDir();
  for (const persona of result.personas) {
    const filePath = personaFilePath(persona.persona_key, persona.file_name);
    writeFileSync(filePath, persona.content, "utf-8");
  }

  const newManifest: PersonaCacheManifest = {
    fetchedAt: new Date().toISOString(),
    planTier: result.plan_tier,
    personas: result.personas.map((p) => ({
      persona_key: p.persona_key,
      file_name: p.file_name,
      version: p.version,
      updated_at: p.updated_at,
    })),
  };
  writeCacheManifest(newManifest);

  return result.personas;
}

function readCachedPersonas(manifest: PersonaCacheManifest): PersonaFile[] {
  const personas: PersonaFile[] = [];
  for (const entry of manifest.personas) {
    const filePath = personaFilePath(entry.persona_key, entry.file_name);
    try {
      const content = readFileSync(filePath, "utf-8");
      personas.push({
        persona_key: entry.persona_key,
        file_name: entry.file_name,
        content,
        version: entry.version,
        updated_at: entry.updated_at,
      });
    } catch {
      // Skip missing files
    }
  }
  return personas;
}

/**
 * Get a specific persona file (from cache or fresh fetch).
 */
export async function getPersonaFile(opts: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  personaKey: string;
  fileName: string;
}): Promise<string | null> {
  // Check cache first
  const filePath = personaFilePath(opts.personaKey, opts.fileName);
  const manifest = readCacheManifest();

  if (isCacheValid(manifest) && existsSync(filePath)) {
    return readFileSync(filePath, "utf-8");
  }

  // Fetch specific file
  const result = await fetchPersonasFromSupabase({
    supabaseUrl: opts.supabaseUrl,
    supabaseAnonKey: opts.supabaseAnonKey,
    personaKey: opts.personaKey,
    fileName: opts.fileName,
  });

  if (!result || result.personas.length === 0) return null;

  const persona = result.personas[0];
  writeFileSync(filePath, persona.content, "utf-8");
  return persona.content;
}

/**
 * List available persona keys (from cache).
 */
export function listCachedPersonaKeys(): string[] {
  const manifest = readCacheManifest();
  if (!manifest) return [];
  return [...new Set(manifest.personas.map((p) => p.persona_key))];
}

/**
 * Clear the personas cache.
 */
export function clearPersonasCache(): void {
  try {
    if (existsSync(PERSONAS_CACHE_DIR)) {
      rmSync(PERSONAS_CACHE_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
}
