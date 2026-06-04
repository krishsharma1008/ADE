// PR-11 — The embedding swap layer (MEMORY_UI_AND_QUALITY_PLAN §1.4).
//
// This is the ONLY module that calls the embedding driver. BOTH egress paths —
// storage (embedForStorage) and query (embedQuery) — route through here, and
// BOTH run the body-text secret scanner (scanBody) BEFORE any provider call.
// This is the redact-before-embed boundary; a no-restricted-imports / grep gate
// keeps embedding-driver.ts reachable only from this file.
//
// Invariants (acceptance criteria):
//   - vectorSearchEnabled false OR no key → hash-64 path only, version
//     'hash-64:64', ZERO driver calls, never throws.
//   - scanBody runs before the driver on BOTH paths. A detected secret is
//     redacted out of the egressed text; the storage path also reports findings
//     so the caller can quarantine the entry to needs_review.
//   - ANY driver error → hash-64 fallback, NEVER throws (writes/queries must
//     not fail because the embedder is slow/down).
//   - content-hash cache (post-redaction text) skips re-embedding unchanged
//     bodies and dedupes provider calls.

import { embedText } from "./memory.js";
import { scanBody, type Finding } from "../secret-scan.js";
import { makeEmbeddingDriver, type EmbeddingDriver } from "./embedding-driver.js";
import { EmbedCache, contentHash, defaultEmbedCache } from "./memory-embed-cache.js";
import { loadConfig } from "../config.js";

/** The version string written when the hash-64 oracle is used (no/failed embed). */
export const HASH_EMBEDDING_VERSION = "hash-64:64";

/**
 * Long-body truncation guard (retrieval-strategy critique — silent worst-tier
 * fallback). text-embedding-3-* accept ~8192 tokens; an over-limit input makes
 * the provider return HTTP 400, which the catch below demotes to the hash-64
 * oracle (MRR 0.375) PERMANENTLY (the version-guard then makes that entry
 * lexical-only forever) with no signal. Rather than let a long RFC/design doc —
 * the highest-value long-form memory — silently fall into the worst tier, we
 * HEAD-truncate the egressed text to a safe char budget (subject always kept).
 * Estimate ~4 chars/token; cap at ~7800 tokens of headroom => 31200 chars.
 * Truncation is a degradation (tail of a long doc is dropped), so we surface it
 * via the truncation counter for the /memory/embedding-status surface; the
 * stored `body` is never altered, only the text that egresses to the provider.
 */
export const MAX_EMBED_CHARS = 31_200;

/** Module-level telemetry counters (process-local) for the embedding-status surface. */
const telemetry = {
  /** Times a storage/query embed text was head-truncated before egress. */
  truncations: 0,
  /** Times an embed (storage or query) fell back to the hash-64 oracle. */
  hashFallbacks: 0,
};

/** Snapshot of the process-local embedder telemetry (read-only). */
export function getEmbedderTelemetry(): { truncations: number; hashFallbacks: number } {
  return { ...telemetry };
}

/** Test seam: zero the telemetry counters. */
export function resetEmbedderTelemetry(): void {
  telemetry.truncations = 0;
  telemetry.hashFallbacks = 0;
}

/**
 * Head-truncate `text` to MAX_EMBED_CHARS, incrementing the truncation counter
 * when it actually cuts. Keeps the head (subject + the start of the body) since
 * the subject leads the string and is the highest-signal span.
 */
function truncateForEmbed(text: string): string {
  if (text.length <= MAX_EMBED_CHARS) return text;
  telemetry.truncations++;
  return text.slice(0, MAX_EMBED_CHARS);
}

export interface EmbedForStorageResult {
  vector: number[];
  version: string;
  /**
   * The BARE model (e.g. 'text-embedding-3-small'), distinct from the composite
   * `version` ('provider:model:dim'). Persisted to the embedding_model column so
   * per-model analytics / HNSW-build gating have a clean key. On the hash-64
   * fallback this is HASH_EMBEDDING_VERSION (no bare model exists).
   */
  model: string;
  /** Findings from the body scan; non-empty → caller marks the entry needs_review. */
  redactedFindings: Finding[];
  /** sha256 of the redacted text — persisted as content_hash for cache/change-detect. */
  contentHash: string;
}

export interface EmbedQueryResult {
  vector: number[];
  version: string;
  redactedFindings: Finding[];
}

export interface EmbedderConfig {
  vectorSearchEnabled: boolean;
  embeddingApiKey: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDim: number;
}

export interface MemoryEmbedder {
  /** True only when a real embedder will be called (flag on AND key present). */
  readonly enabled: boolean;
  /** The embedding_version a successful embed writes (driver version when enabled). */
  readonly version: string;
  embedForStorage(subject: string, body: string): Promise<EmbedForStorageResult>;
  embedQuery(text: string): Promise<EmbedQueryResult>;
}

export interface MakeEmbedderDeps {
  config?: Partial<EmbedderConfig>;
  /** Inject a driver (tests). When omitted, a real driver is built from config. */
  driver?: EmbeddingDriver;
  cache?: EmbedCache;
}

function resolveConfig(override?: Partial<EmbedderConfig>): EmbedderConfig {
  if (
    override &&
    override.vectorSearchEnabled !== undefined &&
    override.embeddingApiKey !== undefined &&
    override.embeddingModel !== undefined &&
    override.embeddingDim !== undefined &&
    override.embeddingProvider !== undefined
  ) {
    return override as EmbedderConfig;
  }
  const cfg = loadConfig();
  return {
    vectorSearchEnabled: override?.vectorSearchEnabled ?? cfg.vectorSearchEnabled,
    embeddingApiKey: override?.embeddingApiKey ?? cfg.embeddingApiKey,
    embeddingProvider: override?.embeddingProvider ?? cfg.embeddingProvider,
    embeddingModel: override?.embeddingModel ?? cfg.embeddingModel,
    embeddingDim: override?.embeddingDim ?? cfg.embeddingDim,
  };
}

export function makeMemoryEmbedder(deps: MakeEmbedderDeps = {}): MemoryEmbedder {
  const cfg = resolveConfig(deps.config);
  const cache = deps.cache ?? defaultEmbedCache;
  // Enabled only when the flag is on AND a key is present. config.ts already
  // coerces vectorSearchEnabled false on an empty key, but we re-check here so a
  // hand-built config can never egress with no key.
  const enabled = cfg.vectorSearchEnabled && cfg.embeddingApiKey.length > 0;

  // Build the driver lazily/once. When disabled we never construct one, so a
  // test or a no-key deployment makes ZERO provider calls.
  const driver: EmbeddingDriver | null = enabled
    ? deps.driver ??
      makeEmbeddingDriver({
        apiKey: cfg.embeddingApiKey,
        provider: cfg.embeddingProvider,
        model: cfg.embeddingModel,
        dim: cfg.embeddingDim,
      })
    : deps.driver ?? null;

  const version = enabled && driver ? driver.version : HASH_EMBEDDING_VERSION;

  function hashVector(text: string): number[] {
    return embedText(text);
  }

  return {
    enabled,
    version,

    async embedForStorage(subject: string, body: string): Promise<EmbedForStorageResult> {
      const raw = `${subject}\n${body}`;
      if (!enabled || !driver) {
        telemetry.hashFallbacks++;
        return {
          vector: hashVector(raw),
          version: HASH_EMBEDDING_VERSION,
          model: HASH_EMBEDDING_VERSION,
          redactedFindings: [],
          contentHash: contentHash(raw),
        };
      }
      // REDACT-BEFORE-EMBED — runs before any provider call. Then head-truncate
      // so an over-limit body never throws into the silent hash-64 worst tier.
      const scan = scanBody(raw);
      const text = truncateForEmbed(scan.clean);
      const hash = contentHash(text);
      const cached = cache.get(hash, driver.version);
      if (cached) {
        return {
          vector: cached.vector,
          version: cached.version,
          model: cached.model ?? cfg.embeddingModel,
          redactedFindings: scan.findings,
          contentHash: hash,
        };
      }
      try {
        const r = await driver.embed([text]);
        const vector = r.vectors[0];
        cache.set(hash, { vector, version: r.version, model: r.model });
        return {
          vector,
          version: r.version,
          model: r.model,
          redactedFindings: scan.findings,
          contentHash: hash,
        };
      } catch {
        // ANY error → hash fallback, NEVER throw. Capture hooks must not fail.
        telemetry.hashFallbacks++;
        return {
          vector: hashVector(raw),
          version: HASH_EMBEDDING_VERSION,
          model: HASH_EMBEDDING_VERSION,
          redactedFindings: scan.findings,
          contentHash: hash,
        };
      }
    },

    async embedQuery(text: string): Promise<EmbedQueryResult> {
      if (!enabled || !driver) {
        telemetry.hashFallbacks++;
        return { vector: hashVector(text), version: HASH_EMBEDDING_VERSION, redactedFindings: [] };
      }
      // The QUERY text is egressed too (issue identifier+title+description),
      // which can also carry secrets — scan it on this path as well (§1.4.2).
      const scan = scanBody(text);
      try {
        const r = await driver.embed([truncateForEmbed(scan.clean)]);
        return { vector: r.vectors[0], version: r.version, redactedFindings: scan.findings };
      } catch {
        telemetry.hashFallbacks++;
        return { vector: hashVector(text), version: HASH_EMBEDDING_VERSION, redactedFindings: scan.findings };
      }
    },
  };
}

/** Process-wide default embedder, built from loadConfig() on first access. */
let singleton: MemoryEmbedder | null = null;
export function getMemoryEmbedder(): MemoryEmbedder {
  if (!singleton) singleton = makeMemoryEmbedder();
  return singleton;
}

/** Test seam: reset the singleton so a new config/env is picked up. */
export function resetMemoryEmbedder(): void {
  singleton = null;
}
