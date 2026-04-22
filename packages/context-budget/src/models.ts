// Map adapter-declared model strings to a canonical family + encoding.
// New models can be added without changing call sites — if the string is
// unknown we fall through to the heuristic tokenizer, which is safe but
// less accurate. Calibration loop closes the gap over time.

export type ModelFamily = "anthropic" | "openai" | "gemini" | "heuristic";

export interface ModelDescriptor {
  family: ModelFamily;
  // js-tiktoken encoding name. Only meaningful for OpenAI family.
  encoding?: "cl100k_base" | "o200k_base";
  // Indicates whether the tokenizer produces exact counts or an estimate.
  isExact: boolean;
  // Human-friendly label for logs.
  label: string;
}

const OPENAI_O200K_PREFIXES = ["gpt-4o", "gpt-4.1", "o1", "o3", "o4", "gpt-5", "codex"];
const OPENAI_CL100K_PREFIXES = ["gpt-3.5", "gpt-4", "gpt-4-", "gpt-4-32k", "gpt-4-turbo"];

export function resolveModel(model: string): ModelDescriptor {
  const raw = (model ?? "").trim().toLowerCase();
  if (raw.length === 0) {
    return { family: "heuristic", isExact: false, label: "heuristic/empty" };
  }
  if (raw.startsWith("claude-") || raw.includes("anthropic")) {
    return { family: "anthropic", isExact: false, label: `anthropic/${raw}` };
  }
  if (raw.startsWith("gemini") || raw.includes("gemini")) {
    return { family: "gemini", isExact: false, label: `gemini/${raw}` };
  }
  if (OPENAI_O200K_PREFIXES.some((p) => raw.startsWith(p))) {
    return { family: "openai", encoding: "o200k_base", isExact: true, label: `openai/${raw}` };
  }
  if (OPENAI_CL100K_PREFIXES.some((p) => raw.startsWith(p))) {
    return { family: "openai", encoding: "cl100k_base", isExact: true, label: `openai/${raw}` };
  }
  // Inflection (pi), Cursor, generic.
  return { family: "heuristic", isExact: false, label: `heuristic/${raw || "unknown"}` };
}

// Family → adapter label, used for calibration ratio lookups so different
// variants (claude-opus, claude-sonnet) share a ratio bucket.
export function familyKey(descriptor: ModelDescriptor): string {
  return descriptor.family;
}
