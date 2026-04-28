export const MEMORY_LAYERS = ["workspace", "personal", "shared"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export const MEMORY_KINDS = ["fact", "runbook", "convention", "pointer", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ["active", "archived", "deprecated"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_OWNER_TYPES = ["user", "agent"] as const;
export type MemoryOwnerType = (typeof MEMORY_OWNER_TYPES)[number];

export const MEMORY_PROMOTION_STATES = ["pending", "approved", "rejected"] as const;
export type MemoryPromotionState = (typeof MEMORY_PROMOTION_STATES)[number];

export interface MemoryEntry {
  id: string;
  companyId: string;
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
