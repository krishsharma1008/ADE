// Calibration = rolling comparison of (our estimate) : (adapter-reported
// usage.inputTokens). After each run the server calls recordCalibration.
// countTokens(..., { useCalibration: true }) multiplies the raw estimate
// by the family's current median ratio (bounded to ±25% to avoid drift).

import type { ModelFamily } from "./models.js";

export interface CalibrationSample {
  family: ModelFamily;
  estimatedTokens: number;
  actualTokens: number;
  observedAt: Date;
  runId?: string;
}

export interface CalibrationStore {
  record(sample: CalibrationSample): Promise<void>;
  // Return the rolling-median ratio (actual / estimated) for this family
  // over the last N days. Returns null when insufficient data (<5 samples).
  rollingMedianRatio(family: ModelFamily, windowDays?: number): Promise<number | null>;
}

export const MIN_RATIO = 0.75;
export const MAX_RATIO = 1.25;
export const DEFAULT_WINDOW_DAYS = 7;
export const MIN_SAMPLES = 5;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

// Pure median for in-memory / deterministic use. Server-side CalibrationStore
// runs SQL, but tests mock against this helper.
export function median(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// In-memory store for tests and environments without a DB. Production
// server supplies its own CalibrationStore backed by tokenizer_calibration.
export class InMemoryCalibrationStore implements CalibrationStore {
  private samples: CalibrationSample[] = [];

  async record(sample: CalibrationSample): Promise<void> {
    this.samples.push(sample);
  }

  async rollingMedianRatio(
    family: ModelFamily,
    windowDays: number = DEFAULT_WINDOW_DAYS,
  ): Promise<number | null> {
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const ratios = this.samples
      .filter(
        (s) =>
          s.family === family &&
          s.estimatedTokens > 0 &&
          s.observedAt.getTime() >= cutoff,
      )
      .map((s) => s.actualTokens / s.estimatedTokens);
    if (ratios.length < MIN_SAMPLES) return null;
    const m = median(ratios);
    if (m === null) return null;
    return clampRatio(m);
  }
}
