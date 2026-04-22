import type {
  Approval,
  DocumentRevision,
  Issue,
  IssueAttachment,
  IssueComment,
  IssueDocument,
  IssueDocumentSummary,
  IssueLabel,
} from "@combyne/shared";
import { api } from "./client";

export const issuesApi = {
  list: (
    companyId: string,
    filters?: {
      status?: string;
      projectId?: string;
      assigneeAgentId?: string;
      assigneeUserId?: string;
      touchedByUserId?: string;
      unreadForUserId?: string;
      labelId?: string;
      q?: string;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters?.assigneeUserId) params.set("assigneeUserId", filters.assigneeUserId);
    if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
    if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
    if (filters?.labelId) params.set("labelId", filters.labelId);
    if (filters?.q) params.set("q", filters.q);
    const qs = params.toString();
    return api.get<Issue[]>(`/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
  },
  listLabels: (companyId: string) => api.get<IssueLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) =>
    api.post<IssueLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<IssueLabel>(`/labels/${id}`),
  get: (id: string) => api.get<Issue>(`/issues/${id}`),
  markRead: (id: string) => api.post<{ id: string; lastReadAt: Date }>(`/issues/${id}/read`, {}),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Issue>(`/companies/${companyId}/issues`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Issue>(`/issues/${id}`, data),
  remove: (id: string) => api.delete<Issue>(`/issues/${id}`),
  checkout: (id: string, agentId: string) =>
    api.post<Issue>(`/issues/${id}/checkout`, {
      agentId,
      expectedStatuses: ["todo", "backlog", "blocked"],
    }),
  release: (id: string) => api.post<Issue>(`/issues/${id}/release`, {}),
  forceUnlock: (id: string) =>
    api.post<{
      cleared: boolean;
      previousRunId: string | null;
      previousRunStatus: string | null;
    }>(`/issues/${id}/force-unlock`, {}),
  listComments: (id: string) => api.get<IssueComment[]>(`/issues/${id}/comments`),
  addComment: (id: string, body: string, reopen?: boolean, interrupt?: boolean) =>
    api.post<IssueComment>(
      `/issues/${id}/comments`,
      {
        body,
        ...(reopen === undefined ? {} : { reopen }),
        ...(interrupt === undefined ? {} : { interrupt }),
      },
    ),
  listAttachments: (id: string) => api.get<IssueAttachment[]>(`/issues/${id}/attachments`),
  uploadAttachment: (
    companyId: string,
    issueId: string,
    file: File,
    issueCommentId?: string | null,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (issueCommentId) {
      form.append("issueCommentId", issueCommentId);
    }
    return api.postForm<IssueAttachment>(`/companies/${companyId}/issues/${issueId}/attachments`, form);
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  delegate: (
    id: string,
    data: {
      toAgentId: string;
      title: string;
      description?: string;
      priority?: string;
      labelIds?: string[];
    },
  ) => api.post<{ issue: Issue }>(`/issues/${id}/delegate`, data),
  answerQuestion: (
    id: string,
    data: { questionCommentId: string; answer: string },
  ) => api.post<{ issue: Issue; answerComment: IssueComment }>(`/issues/${id}/answer-question`, data),
  listApprovals: (id: string) => api.get<Approval[]>(`/issues/${id}/approvals`),
  linkApproval: (id: string, approvalId: string) =>
    api.post<Approval[]>(`/issues/${id}/approvals`, { approvalId }),
  unlinkApproval: (id: string, approvalId: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/approvals/${approvalId}`),
  listByExecutionWorkspace: (companyId: string, executionWorkspaceId: string) =>
    api.get<Issue[]>(
      `/companies/${companyId}/issues?executionWorkspaceId=${encodeURIComponent(executionWorkspaceId)}`,
    ),

  // Issue-scoped documents (PR-revisions-like doc thread). Backed by the
  // issue_documents + document_revisions tables; UI thunks are below so
  // pages can call them without each one rewiring fetch logic.
  listDocuments: (issueId: string) =>
    api.get<IssueDocumentSummary[]>(`/issues/${issueId}/documents`),
  getDocument: (issueId: string, documentId: string) =>
    api.get<IssueDocument>(`/issues/${issueId}/documents/${documentId}`),
  upsertDocument: (
    issueId: string,
    key: string,
    data: {
      title?: string | null;
      format?: "markdown";
      body: string;
      baseRevisionId?: string | null;
    },
  ) => api.post<IssueDocument>(`/issues/${issueId}/documents/${encodeURIComponent(key)}`, data),
  deleteDocument: (issueId: string, documentIdOrKey: string) =>
    api.delete<{ ok: true }>(`/issues/${issueId}/documents/${encodeURIComponent(documentIdOrKey)}`),
  listDocumentRevisions: (issueId: string, documentIdOrKey: string) =>
    api.get<DocumentRevision[]>(
      `/issues/${issueId}/documents/${encodeURIComponent(documentIdOrKey)}/revisions`,
    ),
  restoreDocumentRevision: (
    issueId: string,
    documentIdOrKey: string,
    revisionId: string,
  ) =>
    api.post<IssueDocument>(
      `/issues/${issueId}/documents/${encodeURIComponent(documentIdOrKey)}/revisions/${revisionId}/restore`,
      {},
    ),
};
