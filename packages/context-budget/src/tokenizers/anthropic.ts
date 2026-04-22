import { heuristicCount } from "./heuristic.js";

// Anthropic's official tokenizer (@anthropic-ai/tokenizer) is WASM-backed
// and licensed for client-side use; bundling it adds ~1MB. We prefer it
// when available via runtime require, otherwise fall back to a calibrated
// heuristic (~3.5 chars/token for English + markdown).
//
// Round 3 Phase 3 ships heuristic-only — we can swap in the official
// tokenizer later without touching call sites.

export function anthropicCount(text: string): number {
  // Anthropic models tokenize at roughly 3.5 chars/token for mixed content;
  // calibration will tune this via the tokenizer_calibration table.
  return heuristicCount(text);
}
