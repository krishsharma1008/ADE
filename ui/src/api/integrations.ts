import type {
  IntegrationRecord,
  IntegrationProvider,
} from "@combyne/shared";
import { api } from "./client";

const BASE = "/api";

export const integrationsApi = {
  list: (companyId: string) =>
    api.get<IntegrationRecord[]>(`/companies/${companyId}/integrations`),

  get: (companyId: string, provider: IntegrationProvider) =>
    api.get<IntegrationRecord>(`/companies/${companyId}/integrations/${provider}`),

  create: (
    companyId: string,
    provider: IntegrationProvider,
    config: Record<string, unknown>,
  ) =>
    api.post<IntegrationRecord>(`/companies/${companyId}/integrations`, {
      provider,
      config,
    }),

  update: (
    companyId: string,
    provider: IntegrationProvider,
    data: { enabled?: boolean; config?: Record<string, unknown> },
  ) =>
    api.patch<IntegrationRecord>(
      `/companies/${companyId}/integrations/${provider}`,
      data,
    ),

  /** DELETE returns 204 – avoid parsing empty body. */
  delete: async (companyId: string, provider: IntegrationProvider) => {
    const res = await fetch(`${BASE}/companies/${companyId}/integrations/${provider}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(
        (body as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      );
    }
  },

  test: (companyId: string, provider: IntegrationProvider) =>
    api.post<{ ok: boolean; error?: string }>(
      `/companies/${companyId}/integrations/${provider}/test`,
      {},
    ),
};
