import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface LocalAgentJwtClaims {
  sub: string;
  company_id: string;
  adapter_type: string;
  run_id: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  jti?: string;
}

const JWT_ALGORITHM = "HS256";

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Resolve the on-disk path that `ensureLocalAgentJwtSecret()` in index.ts
 * writes to. Kept in sync with `resolveCombyneInstanceRoot()`.
 */
function resolveInstanceSecretPath(): string {
  const explicit = process.env.COMBYNE_INSTANCE_ROOT?.trim();
  const instanceName = process.env.COMBYNE_INSTANCE_NAME?.trim() || "default";
  const root = explicit
    ? explicit
    : resolve(homedir(), ".combyne", "instances", instanceName);
  return resolve(root, "secrets", "agent-jwt.key");
}

let cachedDiskSecret: string | null = null;

/**
 * Read the persisted JWT secret from disk if the env var is missing. Caches
 * the result so repeated calls don't touch the filesystem. Fixes the
 * "local agent jwt secret missing or invalid" failure mode where the server
 * was started without the local-trusted bootstrap firing (non-local mode,
 * env-scrubbed child process, etc.).
 */
function readSecretFromDisk(): string | null {
  if (cachedDiskSecret) return cachedDiskSecret;
  const secretPath = resolveInstanceSecretPath();
  if (!existsSync(secretPath)) return null;
  try {
    const content = readFileSync(secretPath, "utf8").trim();
    if (content.length < 32) return null;
    cachedDiskSecret = content;
    return content;
  } catch {
    return null;
  }
}

/**
 * Generate a JWT secret on demand and persist it to the canonical path so
 * the next cold boot reuses it. Used as a last-ditch fallback when both
 * the env var and disk file are missing — keeps local-trusted agents
 * functional instead of silently failing every authenticated endpoint.
 */
function generateAndPersistSecret(): string {
  const secret = randomBytes(48).toString("base64url");
  const secretPath = resolveInstanceSecretPath();
  try {
    mkdirSync(resolve(secretPath, ".."), { recursive: true });
    writeFileSync(secretPath, secret, { encoding: "utf8" });
    try { chmodSync(secretPath, 0o600); } catch {
      // Chmod failing on an exotic FS is not fatal — the secret is usable.
    }
  } catch {
    // Persisting failed; still return the secret so this process keeps
    // working. A later boot will bootstrap again.
  }
  cachedDiskSecret = secret;
  process.env.COMBYNE_AGENT_JWT_SECRET = secret;
  return secret;
}

function resolveJwtSecret(): string | null {
  const fromEnv = process.env.COMBYNE_AGENT_JWT_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const fromDisk = readSecretFromDisk();
  if (fromDisk) {
    // Rehydrate env so downstream code that also reads the var directly
    // (adapters, tests) sees a consistent value without repeating the
    // disk read.
    process.env.COMBYNE_AGENT_JWT_SECRET = fromDisk;
    return fromDisk;
  }
  return null;
}

function jwtConfig() {
  const secret = resolveJwtSecret();
  if (!secret) return null;

  return {
    secret,
    ttlSeconds: parseNumber(process.env.COMBYNE_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48),
    issuer: process.env.COMBYNE_AGENT_JWT_ISSUER ?? "combyne",
    audience: process.env.COMBYNE_AGENT_JWT_AUDIENCE ?? "combyne-api",
  };
}

/**
 * Expose a runtime hook so callers (heartbeat pre-flight, health endpoint)
 * can self-heal a missing JWT secret rather than failing every run. The
 * generated secret is persisted to the same path ensureLocalAgentJwtSecret
 * writes to, so the next boot reuses it.
 */
export function ensureLocalAgentJwtSecretAtRuntime(): string {
  const existing = resolveJwtSecret();
  if (existing) return existing;
  return generateAndPersistSecret();
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createLocalAgentJwt(agentId: string, companyId: string, adapterType: string, runId: string) {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };

  const header = {
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);

  return `${signingInput}.${signature}`;
}

export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(config.secret, signingInput);
  if (!safeCompare(signature, expectedSig)) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !companyId || !adapterType || !runId || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) return null;
  if (audience && audience !== config.audience) return null;

  return {
    sub,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
