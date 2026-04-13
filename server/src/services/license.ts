/**
 * Combyne AI — License Validation Service
 *
 * Validates license keys against Supabase, manages local cache,
 * and provides heartbeat functionality.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

export interface LicenseCache {
  licenseKey: string;
  machineFingerprint: string;
  lastValidated: string;
  validUntil: string;
  activationId: string;
  planTier: string;
  status: "active" | "expired" | "revoked";
}

export interface LicenseValidationResult {
  valid: boolean;
  error?: string;
  message?: string;
  license?: {
    status: string;
    plan_tier: string;
    valid_until: string;
  };
  activation?: {
    id: string;
    activated_at: string;
  };
  details?: Record<string, unknown>;
}

export interface LicenseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  gracePeriodHours: number;
}

type CacheValidResult =
  | { valid: true }
  | { valid: false; reason: "revoked" | "expired_license" | "expired_beyond_grace" | "cache_too_old" };

// ── Constants ────────────────────────────────────────────────────────────────

const LICENSE_CACHE_PATH = join(homedir(), ".combyne-ai", "license.json");

const SUPABASE_EDGE_FUNCTION_PATH = "/functions/v1/validate-license";

// ── Machine Fingerprint ──────────────────────────────────────────────────────

let cachedFingerprint: string | null = null;

export async function getMachineFingerprint(): Promise<string> {
  const envFingerprint = process.env.COMBYNE_MACHINE_FINGERPRINT;
  if (envFingerprint) return envFingerprint;

  if (cachedFingerprint) return cachedFingerprint;

  try {
    const output = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (!match?.[1]) throw new Error("IOPlatformUUID not found");
    cachedFingerprint = createHash("sha256").update(match[1]).digest("hex");
    return cachedFingerprint;
  } catch {
    // Fallback for non-macOS or permission issues
    const os = await import("node:os");
    const fallback = `${os.hostname()}-${os.arch()}-${os.platform()}-${os.cpus()[0]?.model ?? "unknown"}`;
    cachedFingerprint = createHash("sha256").update(fallback).digest("hex");
    return cachedFingerprint;
  }
}

// ── Cache Management ─────────────────────────────────────────────────────────

export function readLicenseCache(): LicenseCache | null {
  try {
    if (!existsSync(LICENSE_CACHE_PATH)) return null;
    const raw = readFileSync(LICENSE_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.licenseKey || !parsed.machineFingerprint || !parsed.lastValidated) {
      return null;
    }
    return parsed as LicenseCache;
  } catch {
    return null;
  }
}

export function writeLicenseCache(cache: LicenseCache): void {
  const dir = dirname(LICENSE_CACHE_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(LICENSE_CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

export function clearLicenseCache(): void {
  try {
    if (existsSync(LICENSE_CACHE_PATH)) {
      unlinkSync(LICENSE_CACHE_PATH);
    }
  } catch {
    // Ignore
  }
}

// ── Cache Validation ─────────────────────────────────────────────────────────

export function isLicenseCacheValid(
  cache: LicenseCache,
  gracePeriodHours: number,
): CacheValidResult {
  if (cache.status === "revoked") return { valid: false, reason: "revoked" };

  const now = Date.now();
  const validUntil = new Date(cache.validUntil).getTime();
  if (validUntil < now) return { valid: false, reason: "expired_license" };

  const lastValidated = new Date(cache.lastValidated).getTime();
  const gracePeriodMs = gracePeriodHours * 60 * 60 * 1000;
  if (now - lastValidated > gracePeriodMs) {
    return { valid: false, reason: "expired_beyond_grace" };
  }

  return { valid: true };
}

// ── Remote Validation ────────────────────────────────────────────────────────

export async function validateLicenseRemote(opts: {
  licenseKey: string;
  machineFingerprint: string;
  action: "activate" | "heartbeat" | "deactivate";
  appVersion: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  machineLabel?: string;
  osInfo?: string;
}): Promise<LicenseValidationResult> {
  const url = `${opts.supabaseUrl}${SUPABASE_EDGE_FUNCTION_PATH}`;

  const body: Record<string, string> = {
    license_key: opts.licenseKey,
    machine_fingerprint: opts.machineFingerprint,
    action: opts.action,
    app_version: opts.appVersion,
  };
  if (opts.machineLabel) body.machine_label = opts.machineLabel;
  if (opts.osInfo) body.os_info = opts.osInfo;

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
    try {
      const json = JSON.parse(text);
      return {
        valid: false,
        error: json.error ?? "request_failed",
        message: json.message ?? `HTTP ${response.status}`,
      };
    } catch {
      return {
        valid: false,
        error: "request_failed",
        message: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }
  }

  return (await response.json()) as LicenseValidationResult;
}

// ── High-Level Operations ────────────────────────────────────────────────────

export async function activateLicense(
  licenseKey: string,
  config: LicenseConfig,
): Promise<LicenseValidationResult> {
  const fingerprint = await getMachineFingerprint();
  const os = await import("node:os");
  const osInfo = `${os.type()} ${os.release()} ${os.arch()}`;
  const machineLabel = os.hostname();

  const result = await validateLicenseRemote({
    licenseKey,
    machineFingerprint: fingerprint,
    action: "activate",
    appVersion: process.env.npm_package_version ?? "0.2.7",
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    machineLabel,
    osInfo,
  });

  if (result.valid && result.license && result.activation) {
    writeLicenseCache({
      licenseKey,
      machineFingerprint: fingerprint,
      lastValidated: new Date().toISOString(),
      validUntil: result.license.valid_until,
      activationId: result.activation.id,
      planTier: result.license.plan_tier,
      status: "active",
    });
  }

  return result;
}

export async function performLicenseHeartbeat(config: LicenseConfig): Promise<LicenseValidationResult> {
  const cache = readLicenseCache();
  if (!cache) {
    return { valid: false, error: "no_cache", message: "No license activation found" };
  }

  const fingerprint = await getMachineFingerprint();

  try {
    const result = await validateLicenseRemote({
      licenseKey: cache.licenseKey,
      machineFingerprint: fingerprint,
      action: "heartbeat",
      appVersion: process.env.npm_package_version ?? "0.2.7",
      supabaseUrl: config.supabaseUrl,
      supabaseAnonKey: config.supabaseAnonKey,
    });

    if (result.valid && result.license) {
      writeLicenseCache({
        ...cache,
        lastValidated: new Date().toISOString(),
        validUntil: result.license.valid_until,
        status: "active",
      });
    } else if (result.error === "license_revoked") {
      writeLicenseCache({ ...cache, status: "revoked" });
    } else if (result.error === "license_expired") {
      writeLicenseCache({ ...cache, status: "expired" });
    }

    return result;
  } catch (err) {
    // Network error — grace period applies, don't update cache status
    return {
      valid: false,
      error: "network_error",
      message: err instanceof Error ? err.message : "Failed to reach license server",
    };
  }
}

export async function deactivateLicense(config: LicenseConfig): Promise<LicenseValidationResult> {
  const cache = readLicenseCache();
  if (!cache) {
    return { valid: false, error: "no_cache", message: "No license activation found" };
  }

  const fingerprint = await getMachineFingerprint();

  try {
    const result = await validateLicenseRemote({
      licenseKey: cache.licenseKey,
      machineFingerprint: fingerprint,
      action: "deactivate",
      appVersion: process.env.npm_package_version ?? "0.2.7",
      supabaseUrl: config.supabaseUrl,
      supabaseAnonKey: config.supabaseAnonKey,
    });

    clearLicenseCache();
    return result;
  } catch {
    clearLicenseCache();
    return { valid: true, message: "License deactivated locally" };
  }
}
