import { resolveModel, familyKey, type ModelDescriptor, type ModelFamily } from "./models.js";
import { anthropicCount } from "./tokenizers/anthropic.js";
import { geminiCount } from "./tokenizers/gemini.js";
import { heuristicCount } from "./tokenizers/heuristic.js";
import { openaiCount } from "./tokenizers/openai.js";
import {
  clampRatio,
  DEFAULT_WINDOW_DAYS,
  InMemoryCalibrationStore,
  MIN_SAMPLES,
  type CalibrationSample,
  type CalibrationStore,
} from "./calibration.js";

export { resolveModel, familyKey };
export type { ModelDescriptor, ModelFamily };
export {
  clampRatio,
  DEFAULT_WINDOW_DAYS,
  InMemoryCalibrationStore,
  MIN_SAMPLES,
  type CalibrationSample,
  type CalibrationStore,
};

export interface CountOptions {
  calibrationRatio?: number | null;
}

// Cheap token counter. Never throws — tokenizer-level failures fall back
// to the heuristic. The caller owns whether to apply calibration (usually
// yes in production, no in tests for determinism).
export function countTokens(text: string, model: string, opts: CountOptions = {}): number {
  if (!text) return 0;
  const descriptor = resolveModel(model);
  let raw: number;
  switch (descriptor.family) {
    case "openai":
      raw = openaiCount(text, descriptor.encoding ?? "cl100k_base");
      break;
    case "anthropic":
      raw = anthropicCount(text);
      break;
    case "gemini":
      raw = geminiCount(text);
      break;
    default:
      raw = heuristicCount(text);
      break;
  }
  if (opts.calibrationRatio && Number.isFinite(opts.calibrationRatio)) {
    return Math.max(1, Math.round(raw * clampRatio(opts.calibrationRatio)));
  }
  return raw;
}

export interface TokenizerInfo extends ModelDescriptor {
  family: ModelFamily;
}

export function tokenizerInfo(model: string): TokenizerInfo {
  return resolveModel(model);
}
