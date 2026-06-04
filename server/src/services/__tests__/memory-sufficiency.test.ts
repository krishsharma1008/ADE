import { describe, it, expect } from "vitest";
import {
  evaluateSufficiency,
  extractRequirementTokens,
  sufficiencyThresholdsByVersion,
  LEGACY_HASH_EMBEDDING_VERSION,
  type SufficiencyItem,
} from "../memory-sufficiency.js";

/**
 * PR-10 acceptance — evaluateSufficiency is PURE/DB-free (mirrors rankEntries):
 * insufficient only when ALL three conditions hold; thin on a single condition;
 * thresholds resolve per embedding_version; a missing set is FLAGGED, never
 * silently defaulted.
 */

const HASH = LEGACY_HASH_EMBEDDING_VERSION;

function verifiedItem(over: Partial<SufficiencyItem> = {}): SufficiencyItem {
  return {
    score: 0.9,
    verificationState: "verified",
    provenance: "human-answer",
    confidence: 0.9,
    serviceScope: "auth-service",
    subject: "auth middleware token storage",
    ...over,
  };
}

describe("evaluateSufficiency (pure)", () => {
  it("is deterministic and DB-free — same input ⇒ same verdict", () => {
    const input = {
      items: [verifiedItem()],
      serviceScope: "auth-service",
      requirementTokens: ["auth", "middleware", "token"],
    };
    const a = evaluateSufficiency(input);
    const b = evaluateSufficiency(input);
    expect(a).toEqual(b);
  });

  it("returns sufficient when a verified item covers the scope + requirements", () => {
    const r = evaluateSufficiency({
      items: [verifiedItem()],
      serviceScope: "auth-service",
      requirementTokens: ["auth", "middleware"],
    });
    expect(r.verdict).toBe("sufficient");
    expect(r.verifiedCovered).toBe(true);
    expect(r.entityCoverage).toBeGreaterThan(0);
    expect(r.embeddingVersion).toBe(HASH);
    expect(r.thresholdsMissing).toBe(false);
  });

  it("returns INSUFFICIENT only when ALL THREE conditions hold", () => {
    // No verified item (cond 1) + entityCoverage 0 (cond 2) + low req coverage (cond 3).
    const r = evaluateSufficiency({
      items: [
        {
          score: 0.05, // below 0.22 min
          verificationState: "unverified",
          provenance: "agent-claim",
          subject: "totally unrelated note",
          serviceScope: "other-service",
        },
      ],
      serviceScope: "payments-service",
      requirementTokens: ["refund", "idempotency", "webhook"],
    });
    expect(r.verdict).toBe("insufficient");
    expect(r.verifiedCovered).toBe(false);
    expect(r.entityCoverage).toBe(0);
    expect(r.requirementCoverage).toBeLessThan(0.34);
    expect(r.reasons).toContain("no_verified_trusted_item");
    expect(r.reasons).toContain("entity_coverage_zero");
  });

  it("returns THIN (not insufficient) when only ONE condition holds", () => {
    // A verified item covers scope + all requirements (cond 1 & 2 satisfied),
    // but topScore is below the min (cond 1's score arm). Because cond1 is
    // (score<min OR no-verified) AND verified IS present, cond1 still trips via
    // score — yet cond2 (entity) and cond3 (requirement) are satisfied. So
    // exactly one of the three condition-buckets holds ⇒ thin.
    const r = evaluateSufficiency({
      items: [verifiedItem({ score: 0.05 })],
      serviceScope: "auth-service",
      requirementTokens: ["auth", "middleware", "token", "storage"],
    });
    expect(r.entityCoverage).toBeGreaterThan(0);
    expect(r.requirementCoverage).toBeGreaterThanOrEqual(0.34);
    expect(r.verdict).toBe("thin");
  });

  it("thin when only requirement coverage is low (scope + verified ok)", () => {
    const r = evaluateSufficiency({
      items: [verifiedItem({ score: 0.9 })],
      serviceScope: "auth-service",
      requirementTokens: ["auth", "rotation", "kms", "rotate", "rekey"],
    });
    expect(r.verifiedCovered).toBe(true);
    expect(r.entityCoverage).toBeGreaterThan(0);
    expect(r.requirementCoverage).toBeLessThan(0.34);
    expect(r.verdict).toBe("thin");
  });

  it("no items ⇒ insufficient (empty retrieval is the canonical gap)", () => {
    const r = evaluateSufficiency({
      items: [],
      serviceScope: "payments-service",
      requirementTokens: ["refund", "webhook"],
    });
    expect(r.topScore).toBe(0);
    expect(r.verifiedCovered).toBe(false);
    expect(r.entityCoverage).toBe(0);
    expect(r.requirementCoverage).toBe(0);
    expect(r.verdict).toBe("insufficient");
    expect(r.missingEntities).toContain("payments-service");
  });

  it("an unverified high-score hit does NOT count as a trustworthy hit", () => {
    const r = evaluateSufficiency({
      items: [
        {
          score: 0.95,
          verificationState: "unverified",
          provenance: "agent-claim",
          serviceScope: "payments-service",
          subject: "refund webhook idempotency",
        },
      ],
      serviceScope: "payments-service",
      requirementTokens: ["refund", "webhook", "idempotency"],
    });
    // High requirement coverage + score, but no verified trusted item.
    expect(r.verifiedCovered).toBe(false);
    expect(r.entityCoverage).toBe(0); // entity coverage requires a VERIFIED entry
    expect(r.requirementCoverage).toBeGreaterThanOrEqual(0.34);
    // cond1 (no-verified) + cond2 (entity 0) hold, cond3 does not ⇒ thin
    expect(r.verdict).toBe("thin");
  });

  it("verified-summary and pr-approval also count as trustworthy provenances", () => {
    for (const provenance of ["pr-approval", "verified-summary"] as const) {
      const r = evaluateSufficiency({
        items: [verifiedItem({ provenance })],
        serviceScope: "auth-service",
        requirementTokens: ["auth", "middleware"],
      });
      expect(r.verifiedCovered).toBe(true);
      expect(r.verdict).toBe("sufficient");
    }
  });
});

describe("evaluateSufficiency thresholds (embedder-scoped, §2.3)", () => {
  it("resolves the hash-64 calibrated set for the legacy embedder", () => {
    const map = sufficiencyThresholdsByVersion();
    expect(map[HASH]).toBeDefined();
    expect(map[HASH].minScore).toBe(0.22);
    expect(map[HASH].reqCover).toBe(0.34);
  });

  it("treats a null embedding version as the legacy hash-64 set", () => {
    const r = evaluateSufficiency({
      items: [verifiedItem()],
      serviceScope: "auth-service",
      requirementTokens: ["auth"],
      embeddingVersion: null,
    });
    expect(r.embeddingVersion).toBe(HASH);
    expect(r.thresholdsMissing).toBe(false);
  });

  it("FLAGS a missing threshold set for an unknown version (never silently defaults)", () => {
    const r = evaluateSufficiency({
      items: [], // would otherwise be insufficient
      serviceScope: "payments-service",
      requirementTokens: ["refund"],
      embeddingVersion: "openai:text-embedding-3-small:1536",
    });
    expect(r.thresholdsMissing).toBe(true);
    expect(r.embeddingVersion).toBe("openai:text-embedding-3-small:1536");
    // Forced non-actionable: the gate must NOT ask on an un-calibrated embedder.
    expect(r.verdict).toBe("sufficient");
    expect(r.reasons.some((x) => x.startsWith("thresholds_missing_for_version"))).toBe(true);
  });

  it("honors an explicit thresholds override (test seam) per version", () => {
    const r = evaluateSufficiency({
      items: [verifiedItem({ score: 0.5 })],
      serviceScope: "auth-service",
      requirementTokens: ["auth", "middleware"],
      embeddingVersion: "custom:v1",
      thresholds: { "custom:v1": { minScore: 0.4, reqCover: 0.34 } },
    });
    expect(r.thresholdsMissing).toBe(false);
    expect(r.thresholds.minScore).toBe(0.4);
  });
});

describe("extractRequirementTokens (pure)", () => {
  it("lowercases, strips punctuation, dedupes, drops short tokens", () => {
    const toks = extractRequirementTokens("Refund webhook IDEMPOTENCY, refund a-b a");
    expect(toks).toContain("refund");
    expect(toks).toContain("webhook");
    expect(toks).toContain("idempotency");
    // "a" is too short; "refund" deduped to one
    expect(toks.filter((t) => t === "refund").length).toBe(1);
    expect(toks).not.toContain("a");
  });
});
