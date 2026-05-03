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

  continueSession: (
    companyId: string,
    agentId: string,
    body: { issueId: string; cols?: number; rows?: number },
  ) =>
    api.post<{ session: TerminalSessionInfo; resumed: boolean }>(
      `/companies/${companyId}/agents/${agentId}/terminal/continue`,
      body,
    ),

  closeSession: (companyId: string, agentId: string, sessionId?: string | null) =>
    fetch(
      `/api/companies/${companyId}/agents/${agentId}/terminal/session${
        sessionId ? `/${encodeURIComponent(sessionId)}` : ""
      }`,
      {
      method: "DELETE",
      credentials: "include",
      },
    ).then(async (res) => {
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        throw new Error((errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`);
      }
    }),
};
