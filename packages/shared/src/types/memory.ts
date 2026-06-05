export const MEMORY_LAYERS = ["workspace", "personal", "shared", "global"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export const MEMORY_KINDS = ["fact", "runbook", "convention", "pointer", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ["active", "archived", "deprecated"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_OWNER_TYPES = ["user", "agent"] as const;
export type MemoryOwnerType = (typeof MEMORY_OWNER_TYPES)[number];

export const MEMORY_PROVENANCES = [
  "human-answer",
  "pr-approval",
  "verified-summary",
  "agent-claim",
  "system",
] as const;
export type MemoryProvenance = (typeof MEMORY_PROVENANCES)[number];

export const MEMORY_VERIFICATION_STATES = ["verified", "unverified", "needs_review"] as const;
export type MemoryVerificationState = (typeof MEMORY_VERIFICATION_STATES)[number];

export const MEMORY_AUTHOR_TYPES = ["user", "agent", "system"] as const;
export type MemoryAuthorType = (typeof MEMORY_AUTHOR_TYPES)[number];

export const MEMORY_SOURCE_REF_TYPES = [
  "issue",
  "pr",
  "comment",
  "approval",
  "run",
  "promotion",
] as const;
export type MemorySourceRefType = (typeof MEMORY_SOURCE_REF_TYPES)[number];

export const MEMORY_PROMOTION_STATES = ["pending", "approved", "rejected"] as const;
export type MemoryPromotionState = (typeof MEMORY_PROMOTION_STATES)[number];

export interface MemoryEntry {
  id: string;
  /**
   * Owning company. NULL only for instance-wide GLOBAL-layer entries (0054),
   * which are company-agnostic. Every other layer carries a real company id.
   */
  companyId: string | null;
  layer: MemoryLayer;
  ownerType: MemoryOwnerType | null;
  ownerId: string | null;
  subject: string;
  body: string;
  kind: MemoryKind;
  tags: string[];
  serviceScope: string | null;
  source: string | null;
  embedding: number[] | null;
  provenance: MemoryProvenance | null;
  verificationState: MemoryVerificationState;
  confidence: number;
  authorType: MemoryAuthorType | null;
  authorId: string | null;
  sourceRefType: MemorySourceRefType | null;
  sourceRefId: string | null;
  subjectKey: string | null;
  supersededById: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  embeddingVersion: string | null;
  status: MemoryStatus;
  usageCount: number;
  lastUsedAt: string | null;
  ttlDays: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Compact ranked snippet returned by /memory/query and inside the manifest.
 * Body is omitted in manifests to keep them tiny; clients pull the full body
 * via /memory/entries/:id when they actually need it.
 */
export interface MemoryManifestItem {
  id: string;
  layer: MemoryLayer;
  subject: string;
  kind: MemoryKind;
  tags: string[];
  serviceScope: string | null;
  score: number;
}

export interface MemoryQueryResult {
  items: Array<MemoryManifestItem & { snippet: string }>;
  layerCounts: Record<MemoryLayer, number>;
}

export interface MemoryManifest {
  taskId: string | null;
  generatedAt: string;
  items: MemoryManifestItem[];
  layerCounts: Record<MemoryLayer, number>;
}

export interface MemoryCoreContext {
  taskId: string;
  generatedAt: string;
  ticket: {
    id: string;
    title: string;
    status: string;
    priority: string | null;
    assigneeAgentId: string | null;
  } | null;
  ownership: {
    agentId: string | null;
    agentName: string | null;
    role: string | null;
  } | null;
  recentRuns: Array<{
    id: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  branch: string | null;
}

export interface MemoryPromotion {
  id: string;
  companyId: string;
  sourceEntryId: string;
  proposedSubject: string;
  proposedBody: string;
  proposedTags: string[];
  proposedKind: MemoryKind;
  proposerType: "system" | "agent" | "user";
  proposerId: string | null;
  state: MemoryPromotionState;
  reviewerId: string | null;
  reviewNotes: string | null;
  promotedEntryId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * PR-14 — a single capture-inbox row: a freshly-captured human-answer /
 * pr-approval entry awaiting human Confirm/Edit/Dismiss. `citation` is the
 * source-ref the capture hook stamped (issue#/PR#/comment#) so the reviewer can
 * trace it back to where the answer was given.
 */
export interface MemoryCaptureItem {
  entry: MemoryEntry;
  /** Human-readable source citation, e.g. "issue #ABC-12" / "PR #42" / "comment-9". */
  citation: string | null;
}

/**
 * PR-14 — a single verify-queue row. Either an agent-claim entry (with its
 * distinct-issue reuse count — the §3 hybrid-SLA signal) or a pending promotion
 * proposal. The discriminant is `kind`.
 */
export type MemoryVerifyItem =
  | {
      kind: "agent-claim";
      entry: MemoryEntry;
      /** Number of DISTINCT issues this entry has been reused across (reuse evidence). */
      distinctIssueReuse: number;
    }
  | {
      kind: "promotion";
      promotion: MemoryPromotion;
    };

/**
 * PR-14 — the first-class conflict surface (decision #5). A group of >1 distinct
 * human-answer entries that share a `subjectKey`. `entries` are the conflicting
 * (non-superseded) rows; `newestByThatUserId` is the id the resolver
 * pre-highlights (the user's exact ask: default-surface the newest entry that
 * user pushed, NOT silent newest-wins).
 */
export interface MemoryConflictGroup {
  subjectKey: string;
  subject: string;
  entries: MemoryEntry[];
  /** Id of the entry pre-highlighted in the resolver (newest, broken by recency). */
  newestByThatUserId: string;
}

export const MEMORY_CONFLICT_ACTIONS = ["override", "merge", "edit"] as const;
export type MemoryConflictAction = (typeof MEMORY_CONFLICT_ACTIONS)[number];

/**
 * PR-16 — Questions tab (the ask-don't-hallucinate loop, made visible). A single
 * captured human-answer entry shown as: the question that was asked → the answer
 * that was captured → the reusable entry it became. Backed by all `human-answer`
 * provenance entries (acknowledged or not), with the source citation the capture
 * hook stamped and the time the answer was captured (`answeredAt`).
 */
export interface MemoryQuestionItem {
  entry: MemoryEntry;
  /** The original question text recovered from the captured `Q:/A:` body, when present. */
  question: string | null;
  /** The captured answer text recovered from the body, when present. */
  answer: string | null;
  /** Human-readable source citation, e.g. "issue #ABC-12" / "comment #9". */
  citation: string | null;
  /** When the answer was captured (the entry's createdAt). */
  answeredAt: string;
  /** True once a human has acknowledged the captured entry (verifiedBy stamped). */
  acknowledged: boolean;
}

/**
 * PR-16 — Passdown tab (read-only audit of EM passdown packets). One row per
 * recent handoff carrying a non-empty passdown manifest in
 * `agent_handoffs.artifactRefs`. Surfaces the child issue, complexity tier,
 * entry/token budget, and the cited entries, parsed via `isPassdownPacket`.
 */
export interface MemoryPassdownPacketItem {
  entryId: string;
  layer: MemoryLayer;
  subject: string;
  kind: string;
  serviceScope: string | null;
  provenance: MemoryProvenance | null;
  confidence: number;
  /** True when the entry came from the EM-pinned `curatedMemoryEntryIds` union. */
  curated: boolean;
}

export interface MemoryPassdownPacket {
  handoffId: string;
  childIssueId: string;
  childIssueTitle: string | null;
  childIssueIdentifier: string | null;
  complexity: string;
  serviceScope: string | null;
  /** Number of vetted entries carried in the packet. */
  entryCount: number;
  /** Estimated token budget of the rendered packet body. */
  estimatedTokens: number;
  items: MemoryPassdownPacketItem[];
  generatedAt: string;
  createdAt: string;
}
