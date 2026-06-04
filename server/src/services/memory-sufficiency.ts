import type {
  IssueComplexity,
  MemoryProvenance,
  MemoryVerificationState,
} from "@combyne/shared";

/**
 * The ask-don't-hallucinate sufficiency gate — the PURE verdict function
 * (MEMORY_UI_AND_QUALITY_PLAN §2.3). DB-free so it unit-tests without a DB,
 * mirroring `rankEntries` (memory.ts). The heartbeat / EM-passdown call sites
 * wire the side effects (H1 withhold, H2 ask); this module only decides.
 *
 * The whole point of the gate: when retrieval returns nothing trustworthy the
 * agent today proceeds and fabricates. The verdict here is the missing decision
 * point — `insufficient` ⇒ withhold the sub-threshold context (H1) AND post a
 * gate-authored question (H2). `thin` ⇒ label-only, never ask. It stays a
 * NO-OP behind COMBYNE_SUFFICIENCY_GATE_ENABLED until 0049 + HOOK 1 populate the
 * per-item trust fields (§2.8) — until then the wiring only emits telemetry.
 */

/** A single ranked retrieval item with its (0049) trust fields. */
export interface SufficiencyItem {
  /** queryRanked score (Number-rounded; memory.ts). */
  score: number;
  /** 0049 trust fields. Optional so the gate is computable pre-0049 (all undefined). */
  verificationState?: MemoryVerificationState | null;
  provenance?: MemoryProvenance | null;
  confidence?: number | null;
  /** §2.3 entity coverage: the verified entry's serviceScope / subject. */
  serviceScope?: string | null;
  subject?: string | null;
}

export interface SufficiencyInput {
  /** Ranked items from queryRanked (highest score first is NOT required). */
  items: SufficiencyItem[];
  /** Ticket serviceScope (0051) — one of the key entities to cover. */
  serviceScope?: string | null;
  /**
   * Extracted requirement tokens from the ticket (title/description). The
   * requirementCoverage is the fraction of these that appear in some surviving
   * item's subject/serviceScope. Caller tokenizes; this stays pure.
   */
  requirementTokens: string[];
  /** Issue complexity (small tickets are not made chatty — §2.7). */
  complexity?: IssueComplexity | null;
  /**
   * Active embedding version. Thresholds are embedder-scoped (§2.3): the score
   * distribution shifts when real embeddings land, invalidating the hash-64
   * constants. `null` is treated as the legacy hash embedder ("hash-64:64").
   */
  embeddingVersion?: string | null;
  /**
   * Optional threshold map override (test seam). Defaults to
   * SUFFICIENCY_THRESHOLDS_BY_VERSION resolved with the env-tunable hash-64 set.
   */
  thresholds?: Record<string, SufficiencyThresholds>;
}

export interface SufficiencyThresholds {
  minScore: number;
  reqCover: number;
}

export type SufficiencyVerdict = "sufficient" | "insufficient" | "thin";

export interface SufficiencyResult {
  verdict: SufficiencyVerdict;
  reasons: string[];
  topScore: number;
  verifiedCovered: boolean;
  entityCoverage: number;
  requirementCoverage: number;
  missingEntities: string[];
  /** The embedding version the thresholds were resolved against. */
  embeddingVersion: string;
  /**
   * True when NO calibrated threshold set exists for the active embedding
   * version. §2.3: a missing set is FLAGGED, never silently defaulted — the
   * gate must not ask on an un-calibrated embedder. The caller (gate wiring)
   * treats a flagged verdict as non-actionable (telemetry only).
   */
  thresholdsMissing: boolean;
  /** The resolved thresholds (the conservative fallback when flagged). */
  thresholds: SufficiencyThresholds;
}

/** The legacy hash embedder's version label (PR-11 stamps real entries). */
export const LEGACY_HASH_EMBEDDING_VERSION = "hash-64:64";

export const DEFAULT_SUFFICIENCY_MIN_SCORE = 0.22;
export const DEFAULT_REQ_COVER_MIN = 0.34;

/**
 * Conservative fallback used ONLY to populate the result shape when the active
 * embedding version has no calibrated set. `thresholdsMissing` is the real
 * signal; these numbers are never authoritative (the caller must not ask).
 */
const FALLBACK_THRESHOLDS: SufficiencyThresholds = {
  minScore: DEFAULT_SUFFICIENCY_MIN_SCORE,
  reqCover: DEFAULT_REQ_COVER_MIN,
};

/** Verified provenances that count toward the "trustworthy hit" test (§2.3.1). */
const VERIFIED_TRUST_PROVENANCES: ReadonlySet<MemoryProvenance> = new Set([
  "human-answer",
  "pr-approval",
  "verified-summary",
]);

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The embedder-scoped threshold map (§2.3). Keyed by `embedding_version`. The
 * hash-64 set is env-tunable (COMBYNE_SUFFICIENCY_MIN_SCORE / COMBYNE_REQ_COVER_MIN)
 * so it can be calibrated without a code change. Real-embedder versions
 * (PR-11) MUST be added here before the gate is flipped to ask-mode on them —
 * a missing version is flagged, never silently defaulted.
 */
export function sufficiencyThresholdsByVersion(): Record<string, SufficiencyThresholds> {
  return {
    [LEGACY_HASH_EMBEDDING_VERSION]: {
      minScore: envNumber("COMBYNE_SUFFICIENCY_MIN_SCORE", DEFAULT_SUFFICIENCY_MIN_SCORE),
      reqCover: envNumber("COMBYNE_REQ_COVER_MIN", DEFAULT_REQ_COVER_MIN),
    },
  };
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/**
 * Tokenize text into a set of requirement-ish tokens. Conservative + lexical
 * (mirrors memory.ts tokenize) — keeps the function pure and deterministic.
 */
export function extractRequirementTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    const tok = normalizeToken(raw);
    if (tok.length < 3 || tok.length > 32) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function tokenSet(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(extractRequirementTokens(text));
}

/**
 * PURE verdict function (§2.3).
 *
 * `insufficient` ⇔ ALL of:
 *   1. topScore < minScore OR no verified+(human-answer|pr-approval|verified-summary) item;
 *   2. entityCoverage === 0 (no verified entry covers a ticket key entity);
 *   3. requirementCoverage < reqCover.
 * `thin`        ⇔ exactly ONE of the three conditions holds (borderline; label-only).
 * `sufficient`  ⇔ none hold.
 *
 * When the active embedding version has no calibrated threshold set, the result
 * is FLAGGED (`thresholdsMissing: true`) and the verdict is forced non-actionable
 * (`sufficient`) so the gate never asks on an un-calibrated embedder (§2.3).
 */
export function evaluateSufficiency(input: SufficiencyInput): SufficiencyResult {
  const embeddingVersion = input.embeddingVersion ?? LEGACY_HASH_EMBEDDING_VERSION;
  const map = input.thresholds ?? sufficiencyThresholdsByVersion();
  const calibrated = map[embeddingVersion];
  const thresholdsMissing = calibrated === undefined;
  const thresholds = calibrated ?? FALLBACK_THRESHOLDS;

  const items = input.items ?? [];
  const topScore = items.reduce((max, it) => (it.score > max ? it.score : max), 0);

  // A "trustworthy hit": verified verification state AND a human/pr/summary
  // provenance. Pre-0049 every item is unverified, so this is false and the
  // gate would fire on everything — which is exactly why the wiring stays DARK
  // until HOOK 1 populates these fields (§2.8).
  const verifiedItems = items.filter(
    (it) =>
      it.verificationState === "verified" &&
      it.provenance != null &&
      VERIFIED_TRUST_PROVENANCES.has(it.provenance),
  );
  const verifiedCovered = verifiedItems.length > 0;

  // Entity coverage (§2.3.2): does a VERIFIED entry's serviceScope/subject cover
  // the ticket's key entities? We treat the ticket serviceScope as the primary
  // key entity. 1 when a verified item matches it (or, absent a ticket scope,
  // when any verified item exists); 0 otherwise.
  const ticketScopeTokens = tokenSet(input.serviceScope);
  const missingEntities: string[] = [];
  let entityCoverage = 0;
  if (verifiedItems.length === 0) {
    entityCoverage = 0;
    for (const t of ticketScopeTokens) missingEntities.push(t);
  } else if (ticketScopeTokens.size === 0) {
    // No declared ticket scope — a verified item is coverage enough.
    entityCoverage = 1;
  } else {
    const coveredScopeTokens = new Set<string>();
    for (const it of verifiedItems) {
      for (const t of tokenSet(it.serviceScope)) coveredScopeTokens.add(t);
      for (const t of tokenSet(it.subject)) coveredScopeTokens.add(t);
    }
    let hit = 0;
    for (const t of ticketScopeTokens) {
      if (coveredScopeTokens.has(t)) hit++;
      else missingEntities.push(t);
    }
    entityCoverage = hit / ticketScopeTokens.size;
  }

  // Requirement coverage (§2.3.3): fraction of the ticket's requirement tokens
  // that appear in SOME surviving item's subject/serviceScope. Uses all items
  // (verified or not) — this measures retrieval recall, not trust.
  const reqTokens = Array.from(new Set(input.requirementTokens.map(normalizeToken).filter(Boolean)));
  let requirementCoverage = 1;
  if (reqTokens.length > 0) {
    const itemTokens = new Set<string>();
    for (const it of items) {
      for (const t of tokenSet(it.subject)) itemTokens.add(t);
      for (const t of tokenSet(it.serviceScope)) itemTokens.add(t);
    }
    let covered = 0;
    for (const t of reqTokens) if (itemTokens.has(t)) covered++;
    requirementCoverage = covered / reqTokens.length;
  }

  // The three insufficiency conditions (§2.3).
  const condScoreOrTrust = topScore < thresholds.minScore || !verifiedCovered;
  const condEntity = entityCoverage === 0;
  const condRequirement = requirementCoverage < thresholds.reqCover;

  const reasons: string[] = [];
  if (topScore < thresholds.minScore) {
    reasons.push(`top_score_below_min(${topScore.toFixed(4)}<${thresholds.minScore})`);
  }
  if (!verifiedCovered) reasons.push("no_verified_trusted_item");
  if (condEntity) reasons.push("entity_coverage_zero");
  if (condRequirement) {
    reasons.push(
      `requirement_coverage_below_min(${requirementCoverage.toFixed(4)}<${thresholds.reqCover})`,
    );
  }

  const conditionCount = [condScoreOrTrust, condEntity, condRequirement].filter(Boolean).length;

  let verdict: SufficiencyVerdict;
  if (thresholdsMissing) {
    // §2.3: never ask on an un-calibrated embedder. Force non-actionable.
    verdict = "sufficient";
    reasons.push(`thresholds_missing_for_version(${embeddingVersion})`);
  } else if (conditionCount === 3) {
    verdict = "insufficient";
  } else if (conditionCount === 0) {
    verdict = "sufficient";
  } else {
    verdict = "thin";
  }

  return {
    verdict,
    reasons,
    topScore: Number(topScore.toFixed(4)),
    verifiedCovered,
    entityCoverage: Number(entityCoverage.toFixed(4)),
    requirementCoverage: Number(requirementCoverage.toFixed(4)),
    missingEntities,
    embeddingVersion,
    thresholdsMissing,
    thresholds,
  };
}
