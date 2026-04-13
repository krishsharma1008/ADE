import { api } from "./client";

export interface IDE {
  id: string;
  name: string;
  command: string;
}

export const fileOpsApi = {
  openInIDE: (filePath: string, ide?: string) =>
    api.post<{ ok: boolean; path: string }>("/file-ops/open-in-ide", { filePath, ide }),

  revealInFinder: (filePath: string) =>
    api.post<{ ok: boolean; path: string }>("/file-ops/reveal-in-finder", { filePath }),

  getAvailableIDEs: () =>
    api.get<{ ides: IDE[] }>("/file-ops/available-ides"),
};
