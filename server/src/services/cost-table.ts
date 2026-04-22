// Round 3 Phase 6 PR 6.2 — pricing lookup for the summarizer cost-gate.
//
// Values are USD per million tokens. Kept as a flat table so prices can be
// overridden via env or updated in-code without a schema change. Unknown
// models fall back to a pessimistic default so the gate still bites.
//
// Prices sampled from published vendor pricing as of 2026-04. Update when
// vendors change them.

export interface ModelPrice {
  input: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-7": { input: 15.0, output: 75.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.5-pro": { input: 1.25, output: 5.0 },
};

const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 0.5, output: 2.5 };

export function priceFor(model: string): ModelPrice {
  if (!model) return UNKNOWN_MODEL_PRICE;
  const exact = PRICES[model];
  if (exact) return exact;
  // Very light prefix match so aliases like `claude-haiku-4-5@latest` resolve.
  for (const [key, price] of Object.entries(PRICES)) {
    if (model.startsWith(key)) return price;
  }
  return UNKNOWN_MODEL_PRICE;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  expectedOutputTokens: number,
): number {
  const p = priceFor(model);
  return (inputTokens * p.input + expectedOutputTokens * p.output) / 1_000_000;
}

export function isKnownModel(model: string): boolean {
  if (!model) return false;
  if (model in PRICES) return true;
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key)) return true;
  }
  return false;
}
