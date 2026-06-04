// PR-11 — Managed-API embedding HTTP driver (MEMORY_UI_AND_QUALITY_PLAN §1.3).
//
// A direct clone of the summarizer driver template (summarizer-driver-anthropic.ts):
// a bounded, stateless HTTP call (model + input texts → vectors), no CLI fork,
// no session state, per-request model override. The OpenAI embeddings endpoint
// natively batches an array of inputs, so the driver embeds N texts in one call.
//
// API key resolution order: explicit (per-call override) →
// COMBYNE_EMBEDDING_API_KEY → OPENAI_API_KEY. Fails loud if none is set; the
// ONLY caller (memory-embedder.ts) absorbs that error into a hash-64 fallback,
// so a write/query never throws because the embedder is unconfigured or down.
//
// IMPORTANT — redact-before-embed boundary: this module performs NO redaction.
// Its single caller (memory-embedder.ts) runs scanBody() on every text BEFORE
// invoking embed(). A no-restricted-imports / grep gate keeps embed() reachable
// only through that caller (MEMORY_UI_AND_QUALITY_PLAN §1.4.2 fact #1).
//
// The key is NEVER logged. Any structured log line is passed through
// sanitizeRecord (redaction.ts), consistent with the summarizer.

import { logger } from "../middleware/logger.js";
import { sanitizeRecord } from "../redaction.js";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export interface EmbeddingDriverOptions {
  apiKey?: string | null;
  provider?: string;
  model: string;
  dim: number;
  endpoint?: string;
  timeoutMs?: number;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dim: number;
  /** `${provider}:${model}:${dim}` — the value persisted as embedding_version. */
  version: string;
  inputTokens: number;
}

export interface EmbeddingDriver {
  embed(texts: string[]): Promise<EmbeddingResult>;
  /** The embedding_version this driver writes — exposed for the version-guard. */
  readonly version: string;
}

function resolveApiKey(explicit?: string | null): string | null {
  const candidates = [
    explicit,
    process.env.COMBYNE_EMBEDDING_API_KEY,
    process.env.OPENAI_API_KEY,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export function makeEmbeddingDriver(options: EmbeddingDriverOptions): EmbeddingDriver {
  const provider = options.provider ?? "openai";
  const endpoint = options.endpoint ?? OPENAI_EMBEDDINGS_URL;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const version = `${provider}:${options.model}:${options.dim}`;

  return {
    version,
    async embed(texts: string[]): Promise<EmbeddingResult> {
      const apiKey = resolveApiKey(options.apiKey);
      if (!apiKey) {
        throw new Error(
          "embedding driver requires an API key (COMBYNE_EMBEDDING_API_KEY or OPENAI_API_KEY)",
        );
      }
      if (texts.length === 0) {
        return { vectors: [], model: options.model, dim: options.dim, version, inputTokens: 0 };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model: options.model, input: texts }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(`embedding_fetch_failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`embedding_http_${response.status}: ${body.slice(0, 500)}`);
      }

      let json: OpenAIEmbeddingResponse;
      try {
        json = (await response.json()) as OpenAIEmbeddingResponse;
      } catch (err) {
        throw new Error(`embedding_json_parse_failed: ${(err as Error).message}`);
      }

      const data = Array.isArray(json.data) ? json.data : [];
      // Preserve request order; OpenAI returns an `index` per row.
      const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vectors: number[][] = [];
      for (const row of ordered) {
        const vec = row.embedding;
        if (!Array.isArray(vec)) {
          // Never log the key; sanitize the structured context defensively.
          logger.debug(sanitizeRecord({ provider, model: options.model }), "embedding_driver.empty_vector");
          throw new Error("embedding_empty_vector_response");
        }
        // A misconfigured dim must NOT write a wrong-width vector into a vector(N)
        // column — THROW so the caller falls back to the hash oracle instead.
        if (vec.length !== options.dim) {
          throw new Error(
            `embedding_dim_mismatch: expected ${options.dim}, got ${vec.length}`,
          );
        }
        vectors.push(vec);
      }
      if (vectors.length !== texts.length) {
        throw new Error(
          `embedding_count_mismatch: expected ${texts.length}, got ${vectors.length}`,
        );
      }

      return {
        vectors,
        model: options.model,
        dim: options.dim,
        version,
        inputTokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0,
      };
    },
  };
}
