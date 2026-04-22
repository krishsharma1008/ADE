import { heuristicCount } from "./heuristic.js";

// Gemini does not publish a public tokenizer library. Google recommends
// calling their SDK's countTokens() API, which is a network round-trip —
// not appropriate for the hot preamble-composition path. We use the shared
// heuristic and lean on calibration (observed usage.inputTokens vs our
// estimate) to close the gap family-wide.

export function geminiCount(text: string): number {
  return heuristicCount(text);
}
