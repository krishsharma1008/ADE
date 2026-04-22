import { getEncoding, type Tiktoken, type TiktokenEncoding } from "js-tiktoken";
import { heuristicCount } from "./heuristic.js";

// Cache the encoder per-encoding — construction is expensive (BPE merge
// table load) and we call countTokens on hot paths.
const cache = new Map<TiktokenEncoding, Tiktoken>();

export function openaiCount(text: string, encoding: TiktokenEncoding): number {
  if (!text) return 0;
  try {
    let enc = cache.get(encoding);
    if (!enc) {
      enc = getEncoding(encoding);
      cache.set(encoding, enc);
    }
    return enc.encode(text).length;
  } catch {
    // Malformed input or encoder load failure — fall back to heuristic so
    // the caller never throws on token counting.
    return heuristicCount(text);
  }
}
