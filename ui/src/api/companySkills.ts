import type {
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillListItem,
  CompanySkillProjectScanResult,
  CompanySkillUpdateStatus,
} from "@combyne/shared";
import { api } from "./client";

export const companySkillsApi = {
  list: (companyId: string) =>
    api.get<CompanySkillListItem[]>(`/companies/${companyId}/skills`),

  detail: (companyId: string, skillId: string) =>
    api.get<CompanySkillDetail>(`/companies/${companyId}/skills/${skillId}`),

  updateStatus: (companyId: string, skillId: string) =>
    api.get<CompanySkillUpdateStatus>(
      `/companies/${companyId}/skills/${skillId}/update-status`,
    ),

  file: (companyId: string, skillId: string, relativePath: string) =>
    api.get<CompanySkillFileDetail>(
      `/companies/${companyId}/skills/${skillId}/files?path=${encodeURIComponent(relativePath)}`,
    ),

  create: (companyId: string, payload: CompanySkillCreateRequest) =>
    api.post<CompanySkillDetail>(`/companies/${companyId}/skills`, payload),

  updateFile: (
    companyId: string,
    skillId: string,
    path: string,
    content: string,
  ) =>
    api.patch<CompanySkillFileDetail>(
      `/companies/${companyId}/skills/${skillId}/files`,
      { path, content },
    ),

  importFromSource: (companyId: string, source: string) =>
    api.post<{ imported: CompanySkillDetail[]; warnings: string[] }>(
      `/companies/${companyId}/skills/import`,
      { source },
    ),

  scanProjects: (companyId: string) =>
    api.post<CompanySkillProjectScanResult>(
      `/companies/${companyId}/skills/scan-projects`,
      {},
    ),

  deleteSkill: (companyId: string, skillId: string) =>
    api.delete<CompanySkillDetail>(`/companies/${companyId}/skills/${skillId}`),

  installUpdate: (companyId: string, skillId: string) =>
    api.post<CompanySkillDetail>(
      `/companies/${companyId}/skills/${skillId}/install-update`,
      {},
    ),

  getScopes: (companyId: string, skillId: string) =>
    api.get<{ projectIds: string[]; agentIds: string[] }>(
      `/companies/${companyId}/skills/${skillId}/scopes`,
    ),

  setScopes: (
    companyId: string,
    skillId: string,
    scopes: { projectIds?: string[]; agentIds?: string[] },
  ) =>
    api.put<{ projectIds: string[]; agentIds: string[] }>(
      `/companies/${companyId}/skills/${skillId}/scopes`,
      scopes,
    ),
};
