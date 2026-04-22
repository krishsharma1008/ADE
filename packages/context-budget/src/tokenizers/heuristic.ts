// Character-based fallback. Empirically ~3.5 chars per token for English
// prose with markdown; higher for code (~3.0) and lower for dense prose
// (~4.0). Calibration multiplies this to fit the actual per-family ratio.

const CODE_MARKER = "```";

export function heuristicCount(text: string): number {
  if (!text) return 0;
  const hasCode = text.includes(CODE_MARKER);
  const divisor = hasCode ? 3.2 : 3.5;
  // ceil so every non-empty string costs at least 1 token.
  return Math.max(1, Math.ceil(text.length / divisor));
}
