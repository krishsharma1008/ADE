import { api } from "./client";

export type TerminalMode = "cli" | "shell";

export interface TerminalSessionInfo {
  id: string;
  companyId: string;
  agentId: string;
  mode: TerminalMode;
  command: string;
  cwd: string;
  status: "running" | "closed" | "crashed";
  exitCode: number | null;
  startedAt: string;
}

export const terminalApi = {
  getSession: (companyId: string, agentId: string) =>
    api.get<{ session: TerminalSessionInfo | null }>(
      `/companies/${companyId}/agents/${agentId}/terminal/session`,
    ),

  createSession: (
    companyId: string,
    agentId: string,
    body: { mode: TerminalMode; cols?: number; rows?: number },
  ) =>
    api.post<{ session: TerminalSessionInfo; reused: boolean }>(
      `/companies/${companyId}/agents/${agentId}/terminal/session`,
      body,
    ),

  closeSession: (companyId: string, agentId: string) =>
    fetch(`/api/companies/${companyId}/agents/${agentId}/terminal/session`, {
      method: "DELETE",
      credentials: "include",
    }).then(() => undefined),
};
