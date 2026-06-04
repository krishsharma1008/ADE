import type {
  AcceptedWorkEvent,
  CreateMemoryEntry,
  MemoryEntry,
  MemoryLayer,
  MemoryProvenance,
  MemoryVerificationState,
  UpdateMemoryEntry,
} from "@combyne/shared";
import { api } from "./client";

export interface MemoryEntryFilters {
  layer?: MemoryLayer;
  status?: string;
  provenance?: MemoryProvenance;
  verificationState?: MemoryVerificationState;
  /** Confidence floor in [0,1] — only entries at or above this are returned. */
  minConfidence?: number;
  serviceScope?: string;
  /** Recency window in days — only entries updated within the window. */
  age?: number;
}

export const memoryApi = {
  listEntries: (companyId: string, filters?: MemoryEntryFilters) => {
    const params = new URLSearchParams();
    if (filters?.layer) params.set("layer", filters.layer);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.provenance) params.set("provenance", filters.provenance);
    if (filters?.verificationState) params.set("verificationState", filters.verificationState);
    if (filters?.minConfidence !== undefined) {
      params.set("minConfidence", String(filters.minConfidence));
    }
    if (filters?.serviceScope) params.set("serviceScope", filters.serviceScope);
    if (filters?.age !== undefined) params.set("age", String(filters.age));
    const qs = params.toString();
    return api.get<MemoryEntry[]>(`/companies/${companyId}/memory/entries${qs ? `?${qs}` : ""}`);
  },
  createEntry: (companyId: string, data: CreateMemoryEntry) =>
    api.post<MemoryEntry>(`/companies/${companyId}/memory/entries`, data),
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
