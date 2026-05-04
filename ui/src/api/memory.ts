import type { AcceptedWorkEvent, MemoryEntry, UpdateMemoryEntry } from "@combyne/shared";
import { api } from "./client";

export const memoryApi = {
  listEntries: (
    companyId: string,
    filters?: { layer?: "workspace" | "shared"; status?: string },
  ) => {
    const params = new URLSearchParams();
    if (filters?.layer) params.set("layer", filters.layer);
    if (filters?.status) params.set("status", filters.status);
    const qs = params.toString();
    return api.get<MemoryEntry[]>(`/companies/${companyId}/memory/entries${qs ? `?${qs}` : ""}`);
  },
  listAcceptedWorkEvents: (companyId: string, status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return api.get<AcceptedWorkEvent[]>(`/companies/${companyId}/accepted-work/events${qs}`);
  },
  updateEntry: (entryId: string, data: UpdateMemoryEntry) =>
    api.patch<MemoryEntry>(`/memory/entries/${entryId}`, data),
  simulateAcceptedWorkMerge: (
    companyId: string,
    data: {
      issueId?: string | null;
      repo: string;
      pullNumber: number;
      pullUrl?: string | null;
      title: string;
      body?: string | null;
      headBranch?: string | null;
      mergedSha?: string | null;
      mergedAt?: string | null;
    },
  ) => api.post<AcceptedWorkEvent>(`/companies/${companyId}/accepted-work/simulate-merge`, data),
};
