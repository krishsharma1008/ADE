import type { MemoryEntry } from "@combyne/shared";

/**
 * Build a fully-populated MemoryEntry for showcases and tests. Defaults to a
 * verified human-answer workspace entry; pass overrides to render other trust
 * states (unverified agent-claim, needs_review, superseded, etc.).
 */
export function makeMemoryEntryFixture(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    layer: "workspace",
    ownerType: null,
    ownerId: null,
    subject: "Kafka topics use the <service>.<entity>.<event> naming convention",
    body: "Q: How should we name Kafka topics?\nA: Use <service>.<entity>.<event>, lowercase, dot-delimited.",
    kind: "convention",
    tags: ["kafka", "naming"],
    serviceScope: "platform",
    source: "human-answer:issue-42:comment-9",
    embedding: null,
    provenance: "human-answer",
    verificationState: "verified",
    confidence: 0.95,
    authorType: "user",
    authorId: "user-1",
    sourceRefType: "comment",
    sourceRefId: "comment-9",
    subjectKey: "kafka topics naming convention",
    supersededById: null,
    verifiedBy: "user-1",
    verifiedAt: "2026-06-01T12:00:00.000Z",
    embeddingVersion: "hash-64:64",
    status: "active",
    usageCount: 4,
    lastUsedAt: "2026-06-02T09:00:00.000Z",
    ttlDays: null,
    createdBy: "user-1",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}
