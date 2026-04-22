// Round 3 Phase 6 PR 6.3 — Anthropic Messages API summarizer driver.
//
// Deliberately sidesteps the Claude CLI adapter path. Summarization is a
// bounded, deterministic call (system prompt + single user turn → JSON),
// so we use the raw HTTP API directly. Benefits:
//   - No second CLI process forks during a run.
//   - No session state to maintain across calls.
//   - Per-request model override independent of the agent's own CLI binary.
//
// API key resolution order: adapterConfig.summarizer.apiKey (per-agent
// override, e.g. routed through the secrets resolver upstream) →
// COMBYNE_SUMMARIZER_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY. Fails loud
// if none is set; the queue absorbs driver errors as failures.
//
// We lean on Anthropic's `response_format: { type: "json_object" }` via the
// system prompt (already instructs "Return ONLY a JSON object") — the
// Messages API does not have a dedicated JSON mode yet, so the
// parse-retry-once path in transcript-summarizer.ts is the safety net.

import { logger } from "../middleware/logger.js";
import type {
  SummarizerDriver,
  SummarizerDriverInput,
  SummarizerDriverOutput,
} from "./transcript-summarizer.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicDriverOptions {
  apiKey?: string | null;
  endpoint?: string;
  timeoutMs?: number;
}

function resolveApiKey(explicit?: string | null): string | null {
  const candidates = [
    explicit,
    process.env.COMBYNE_SUMMARIZER_ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

// Extract plain text from Anthropic's content-blocks response. The model
// returns an array of { type: "text", text: string } objects; we concatenate
// the text blocks (ignore tool_use etc. — shouldn't happen for our prompt).
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

export function makeAnthropicSummarizerDriver(
  options: AnthropicDriverOptions = {},
): SummarizerDriver {
  const endpoint = options.endpoint ?? ANTHROPIC_MESSAGES_URL;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    async invoke(input: SummarizerDriverInput): Promise<SummarizerDriverOutput> {
      const apiKey = resolveApiKey(options.apiKey);
      if (!apiKey) {
        throw new Error(
          "summarizer driver requires an Anthropic API key (ANTHROPIC_API_KEY or COMBYNE_SUMMARIZER_ANTHROPIC_API_KEY)",
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: input.model,
            max_tokens: input.maxOutputTokens,
            system: input.systemPrompt,
            messages: [{ role: "user", content: input.userPrompt }],
          }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(`anthropic_fetch_failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `anthropic_http_${response.status}: ${body.slice(0, 500)}`,
        );
      }

      let json: Record<string, unknown>;
      try {
        json = (await response.json()) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`anthropic_json_parse_failed: ${(err as Error).message}`);
      }

      const raw = extractText(json.content);
      if (!raw) {
        logger.debug({ response: json, scope: input.scope }, "summarizer_driver.empty_text");
        throw new Error("anthropic_empty_text_response");
      }

      const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return {
        raw,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      };
    },
  };
}
