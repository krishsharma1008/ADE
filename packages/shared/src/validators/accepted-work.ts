import { z } from "zod";
import {
  ACCEPTED_WORK_DETECTION_SOURCES,
  ACCEPTED_WORK_MEMORY_STATUSES,
} from "../types/accepted-work.js";
import { MEMORY_KINDS } from "../types/memory.js";

export const acceptedWorkSimulateMergeSchema = z.object({
  issueId: z.string().uuid().optional().nullable(),
  repo: z.string().min(1).max(256),
  pullNumber: z.number().int().positive(),
  pullUrl: z.string().url().optional().nullable(),
  title: z.string().min(1).max(512),
  body: z.string().max(20_000).optional().nullable(),
  headBranch: z.string().max(256).optional().nullable(),
  mergedSha: z.string().max(128).optional().nullable(),
  mergedAt: z.string().datetime().optional().nullable(),
  detectionSource: z.enum(ACCEPTED_WORK_DETECTION_SOURCES).optional().default("simulation"),
  metadata: z.record(z.unknown()).optional(),
});
export type AcceptedWorkSimulateMerge = z.infer<typeof acceptedWorkSimulateMergeSchema>;

export const acceptedWorkResolveSchema = z.object({
  status: z.enum(ACCEPTED_WORK_MEMORY_STATUSES),
  memoryEntryId: z.string().uuid().optional().nullable(),
});
export type AcceptedWorkResolve = z.infer<typeof acceptedWorkResolveSchema>;

export const acceptedWorkCreateMemorySchema = z.object({
  subject: z.string().min(1).max(512),
  body: z.string().min(1).max(20_000),
  kind: z.enum(MEMORY_KINDS).optional().default("convention"),
  tags: z.array(z.string().min(1).max(64)).max(32).optional().default([]),
  serviceScope: z.string().max(128).optional().nullable(),
});
export type AcceptedWorkCreateMemory = z.infer<typeof acceptedWorkCreateMemorySchema>;
