import { z } from "zod";

export const issuePullRequestUpsertSchema = z.object({
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  pullUrl: z.string().url(),
  title: z.string().min(1),
  baseBranch: z.string().min(1),
  headBranch: z.string().optional().nullable(),
  headSha: z.string().optional().nullable(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  requestedNote: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type IssuePullRequestUpsert = z.infer<typeof issuePullRequestUpsertSchema>;

export const issuePullRequestMergeSchema = z.object({
  approvalId: z.string().uuid().optional().nullable(),
  expectedHeadSha: z.string().min(1).optional().nullable(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  decisionNote: z.string().optional().nullable(),
});
export type IssuePullRequestMerge = z.infer<typeof issuePullRequestMergeSchema>;
