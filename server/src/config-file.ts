import fs from "node:fs";
import path from "node:path";
import { combyneConfigSchema, type CombyneConfig } from "@combyne/shared";
import { resolveCombyneConfigPath } from "./paths.js";

export function readConfigFile(): CombyneConfig | null {
  const configPath = resolveCombyneConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return combyneConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read the raw `contextDatabaseUrl` from the config file (bypassing the strict
 * schema, which strips the field). Returns `null` when absent/unreadable.
 * NEVER logs the value.
 */
export function readConfigFileContextDatabaseUrl(): string | null {
  const configPath = resolveCombyneConfigPath();
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const value = raw.contextDatabaseUrl;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Minimal, surgical writer for the instance config.json. Merges a single field
 * into the existing raw JSON (preserving every other key, including fields the
 * strict schema would strip such as `contextDatabaseUrl`) and re-writes the file
 * with 0600 perms. Mirrors the CLI `writeConfig` pattern (mkdir + 0600 + JSON).
 *
 * Intentionally does NOT re-validate through `combyneConfigSchema` so the
 * separate-context-DB URL — which lives outside the strict schema — survives the
 * round-trip. The live pool is never touched; the value takes effect on restart.
 */
export function writeConfigFile(patch: Record<string, unknown>): void {
  const configPath = resolveCombyneConfigPath();
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        existing = raw as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }
  const merged = { ...existing, ...patch };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  // `mode` only applies on file creation; chmod ensures an EXISTING file is also
  // locked to 0600 so a saved connection string is never world-readable.
  fs.chmodSync(configPath, 0o600);
}
