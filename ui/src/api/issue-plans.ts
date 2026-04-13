import { api } from "./client";

export interface IssuePlan {
  id: string;
  issueId: string;
  companyId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  content: string;
  status: "draft" | "submitted" | "approved" | "rejected";
  approvalId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const issuePlansApi = {
  getPlan: (issueId: string) => api.get<IssuePlan>(`/issues/${issueId}/plan`),

  createOrUpdatePlan: (issueId: string, content: string) =>
    api.post<IssuePlan>(`/issues/${issueId}/plan`, { content }),

  submitPlanForApproval: (issueId: string) =>
    api.post<IssuePlan>(`/issues/${issueId}/plan/submit`, {}),

  approvePlan: (issueId: string) =>
    api.post<IssuePlan>(`/issues/${issueId}/plan/approve`, {}),

  rejectPlan: (issueId: string, note?: string) =>
    api.post<IssuePlan>(`/issues/${issueId}/plan/reject`, { note }),

  listPlans: (companyId: string, status?: string) =>
    api.get<IssuePlan[]>(
      `/companies/${companyId}/plans${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
};
