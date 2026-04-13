import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { approvals, issuePlans } from "@combyne/db";
import { notFound, unprocessable } from "../errors.js";

export function issuePlanService(db: Db) {
  async function getExistingPlan(planId: string) {
    const existing = await db
      .select()
      .from(issuePlans)
      .where(eq(issuePlans.id, planId))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Plan not found");
    return existing;
  }

  return {
    getPlan: async (issueId: string) => {
      return db
        .select()
        .from(issuePlans)
        .where(eq(issuePlans.issueId, issueId))
        .orderBy(desc(issuePlans.version))
        .then((rows) => rows[0] ?? null);
    },

    createPlan: async (params: {
      issueId: string;
      companyId: string;
      content: string;
      authorAgentId?: string | null;
      authorUserId?: string | null;
    }) => {
      return db
        .insert(issuePlans)
        .values({
          issueId: params.issueId,
          companyId: params.companyId,
          content: params.content,
          authorAgentId: params.authorAgentId ?? null,
          authorUserId: params.authorUserId ?? null,
          status: "draft",
          version: 1,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    updatePlan: async (planId: string, content: string) => {
      const existing = await getExistingPlan(planId);
      if (existing.status !== "draft" && existing.status !== "rejected") {
        throw unprocessable("Only draft or rejected plans can be edited");
      }

      const now = new Date();
      return db
        .update(issuePlans)
        .set({
          content,
          version: existing.version + 1,
          status: "draft",
          updatedAt: now,
        })
        .where(eq(issuePlans.id, planId))
        .returning()
        .then((rows) => rows[0]);
    },

    submitForApproval: async (planId: string) => {
      const existing = await getExistingPlan(planId);
      if (existing.status !== "draft") {
        throw unprocessable("Only draft plans can be submitted for approval");
      }

      const now = new Date();

      // Create an approval record
      const approval = await db
        .insert(approvals)
        .values({
          companyId: existing.companyId,
          type: "plan_review",
          requestedByAgentId: existing.authorAgentId,
          requestedByUserId: existing.authorUserId,
          status: "pending",
          payload: {
            planId: existing.id,
            issueId: existing.issueId,
            content: existing.content,
            version: existing.version,
          },
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      // Link approval back to the plan and set status to submitted
      return db
        .update(issuePlans)
        .set({
          status: "submitted",
          approvalId: approval.id,
          updatedAt: now,
        })
        .where(eq(issuePlans.id, planId))
        .returning()
        .then((rows) => rows[0]);
    },

    approvePlan: async (planId: string, decidedByUserId: string) => {
      const existing = await getExistingPlan(planId);
      if (existing.status !== "submitted") {
        throw unprocessable("Only submitted plans can be approved");
      }

      const now = new Date();

      // Update the linked approval
      if (existing.approvalId) {
        await db
          .update(approvals)
          .set({
            status: "approved",
            decidedByUserId,
            decidedAt: now,
            updatedAt: now,
          })
          .where(eq(approvals.id, existing.approvalId));
      }

      return db
        .update(issuePlans)
        .set({
          status: "approved",
          updatedAt: now,
        })
        .where(eq(issuePlans.id, planId))
        .returning()
        .then((rows) => rows[0]);
    },

    rejectPlan: async (planId: string, decidedByUserId: string, note?: string | null) => {
      const existing = await getExistingPlan(planId);
      if (existing.status !== "submitted") {
        throw unprocessable("Only submitted plans can be rejected");
      }

      const now = new Date();

      // Update the linked approval
      if (existing.approvalId) {
        await db
          .update(approvals)
          .set({
            status: "rejected",
            decidedByUserId,
            decisionNote: note ?? null,
            decidedAt: now,
            updatedAt: now,
          })
          .where(eq(approvals.id, existing.approvalId));
      }

      return db
        .update(issuePlans)
        .set({
          status: "rejected",
          updatedAt: now,
        })
        .where(eq(issuePlans.id, planId))
        .returning()
        .then((rows) => rows[0]);
    },

    listPlans: (companyId: string, filters?: { status?: string }) => {
      const conditions = [eq(issuePlans.companyId, companyId)];
      if (filters?.status) conditions.push(eq(issuePlans.status, filters.status));
      return db
        .select()
        .from(issuePlans)
        .where(and(...conditions))
        .orderBy(desc(issuePlans.updatedAt));
    },
  };
}
