import { z } from "zod";
import {
  MEMORY_LAYERS,
  MEMORY_KINDS,
  MEMORY_OWNER_TYPES,
  MEMORY_STATUSES,
  MEMORY_PROVENANCES,
  MEMORY_VERIFICATION_STATES,
  MEMORY_AUTHOR_TYPES,
  MEMORY_SOURCE_REF_TYPES,
} from "../types/memory.js";

const tagsSchema = z.array(z.string().min(1).max(64)).max(32).optional().default([]);

export const createMemoryEntrySchema = z
  .object({
    layer: z.enum(MEMORY_LAYERS),
    subject: z.string().min(1).max(512),
    body: z.string().min(1).max(20_000),
    kind: z.enum(MEMORY_KINDS).optional().default("fact"),
    tags: tagsSchema,
    serviceScope: z.string().max(128).optional().nullable(),
    source: z.string().max(512).optional().nullable(),
    ownerType: z.enum(MEMORY_OWNER_TYPES).optional().nullable(),
    ownerId: z.string().min(1).max(128).optional().nullable(),
    ttlDays: z.number().int().positive().max(3650).optional().nullable(),
    // Trust spine (0049). These are advisory on the request: the route layer
    // derives authorType from the ACTOR and force-quarantines agent actors,
    // so a caller cannot self-assert 'verified' through the body. Accepting
    // them here only lets trusted callers (board) stamp a verified capture.
    provenance: z.enum(MEMORY_PROVENANCES).optional().nullable(),
    verificationState: z.enum(MEMORY_VERIFICATION_STATES).optional(),
    confidence: z.number().min(0).max(1).optional(),
    authorType: z.enum(MEMORY_AUTHOR_TYPES).optional().nullable(),
    authorId: z.string().min(1).max(128).optional().nullable(),
    sourceRefType: z.enum(MEMORY_SOURCE_REF_TYPES).optional().nullable(),
    sourceRefId: z.string().uuid().optional().nullable(),
  })
  .refine(
    (v) =>
      v.layer === "personal"
        ? Boolean(v.ownerType && v.ownerId)
        : true,
    { message: "personal layer entries require ownerType and ownerId" },
  )
  .refine(
    (v) => (v.layer === "shared" ? false : true),
    {
      message:
        "shared layer entries cannot be created directly; promote a workspace/personal entry instead",
    },
  );

export type CreateMemoryEntry = z.infer<typeof createMemoryEntrySchema>;

export const updateMemoryEntrySchema = z.object({
  subject: z.string().min(1).max(512).optional(),
  body: z.string().min(1).max(20_000).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  serviceScope: z.string().max(128).optional().nullable(),
  source: z.string().max(512).optional().nullable(),
  status: z.enum(MEMORY_STATUSES).optional(),
  ttlDays: z.number().int().positive().max(3650).optional().nullable(),
});
export type UpdateMemoryEntry = z.infer<typeof updateMemoryEntrySchema>;

export const memoryQuerySchema = z.object({
  query: z.string().min(1).max(2048),
  layers: z.array(z.enum(MEMORY_LAYERS)).optional(),
  serviceScope: z.string().max(128).optional(),
  ownerId: z.string().min(1).max(128).optional(),
  ownerType: z.enum(MEMORY_OWNER_TYPES).optional(),
  limit: z.number().int().positive().max(50).optional().default(10),
  includeSnippets: z.boolean().optional().default(true),
});
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;

export const memoryManifestQuerySchema = z.object({
  taskId: z.string().uuid().optional(),
  ownerId: z.string().min(1).max(128).optional(),
  ownerType: z.enum(MEMORY_OWNER_TYPES).optional(),
  serviceScope: z.string().max(128).optional(),
  limit: z.number().int().positive().max(50).optional().default(15),
});
export type MemoryManifestQuery = z.infer<typeof memoryManifestQuerySchema>;

export const memoryCoreBuildSchema = z.object({
  taskId: z.string().uuid(),
});
export type MemoryCoreBuild = z.infer<typeof memoryCoreBuildSchema>;

export const memoryRecordUsageSchema = z.object({
  issueId: z.string().uuid().optional().nullable(),
  score: z.number().optional(),
});
export type MemoryRecordUsage = z.infer<typeof memoryRecordUsageSchema>;

export const memoryProposePromotionSchema = z.object({
  sourceEntryId: z.string().uuid(),
  proposedSubject: z.string().min(1).max(512).optional(),
  proposedBody: z.string().min(1).max(20_000).optional(),
  proposedTags: z.array(z.string().min(1).max(64)).max(32).optional(),
  proposedKind: z.enum(MEMORY_KINDS).optional(),
});
export type MemoryProposePromotion = z.infer<typeof memoryProposePromotionSchema>;

export const memoryDecidePromotionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reviewNotes: z.string().max(2048).optional().nullable(),
});
export type MemoryDecidePromotion = z.infer<typeof memoryDecidePromotionSchema>;

/**
 * PR-14 conflict resolution (the first-class merge/override ask, decision #5).
 *  - override: `canonicalEntryId` wins, every other entry in the group is
 *    superseded to it.
 *  - merge: a NEW canonical entry is written from `body`; ALL originals in the
 *    group are superseded to it (losers preserved for audit).
 *  - edit: `canonicalEntryId`'s body is rewritten to `body` and the rest are
 *    superseded to it.
 * canonicalEntryId is required for override/edit; body is required for
 * merge/edit. The service re-validates this cross-field shape.
 */
export const memoryResolveConflictSchema = z.object({
  action: z.enum(["override", "merge", "edit"]),
  canonicalEntryId: z.string().uuid().optional(),
  body: z.string().min(1).max(20_000).optional(),
});
export type MemoryResolveConflict = z.infer<typeof memoryResolveConflictSchema>;

/**
 * PR-15 redaction-queue resolution (§3.6 — the blocking redact-before-embed
 * gate). Board-only at the route.
 *  - approve (approve-as-clean): clear the `needs_review` quarantine → verified,
 *    so the entry re-enters retrieval.
 *  - reject (keep-redacted): archive the entry so it never re-surfaces.
 */
export const memoryResolveRedactionSchema = z.object({
  action: z.enum(["approve", "reject"]),
});
export type MemoryResolveRedaction = z.infer<typeof memoryResolveRedactionSchema>;
