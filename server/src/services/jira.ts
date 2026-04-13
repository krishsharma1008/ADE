import type { JiraConfig, JiraIssue, JiraProject } from "@combyne/shared";

/**
 * Jira REST API v3 client.
 * Authenticates via Basic Auth (email + API token).
 */
export function createJiraClient(config: JiraConfig) {
  const authHeader =
    "Basic " + Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${config.baseUrl}/rest/api/3${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jira API error ${res.status}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as T;
  }

  return {
    /** Test connectivity by fetching server info. */
    async testConnection(): Promise<{ ok: boolean; serverTitle?: string; error?: string }> {
      try {
        const info = await request<{ serverTitle?: string }>("/serverInfo");
        return { ok: true, serverTitle: info.serverTitle };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    /** List projects visible to the authenticated user. */
    async listProjects(): Promise<JiraProject[]> {
      const data = await request<{ values: Array<{ id: string; key: string; name: string }> }>(
        "/project/search?maxResults=50",
      );
      return data.values.map((p) => ({ id: p.id, key: p.key, name: p.name }));
    },

    /** Search issues using JQL. Defaults to the configured project. */
    async searchIssues(jql?: string, maxResults = 50): Promise<JiraIssue[]> {
      const effectiveJql = jql || `project = ${config.projectKey} ORDER BY updated DESC`;
      const data = await request<{
        issues: Array<{
          id: string;
          key: string;
          fields: {
            summary: string;
            description: unknown;
            status: { name: string };
            priority: { name: string } | null;
            assignee: { displayName: string } | null;
            created: string;
            updated: string;
          };
        }>;
      }>(`/search?jql=${encodeURIComponent(effectiveJql)}&maxResults=${maxResults}`);
      return data.issues.map((i) => ({
        id: i.id,
        key: i.key,
        summary: i.fields.summary,
        description: typeof i.fields.description === "string" ? i.fields.description : null,
        status: i.fields.status.name,
        priority: i.fields.priority?.name ?? null,
        assignee: i.fields.assignee?.displayName ?? null,
        created: i.fields.created,
        updated: i.fields.updated,
      }));
    },

    /** Get a single issue by key or id. */
    async getIssue(issueKeyOrId: string): Promise<JiraIssue> {
      const i = await request<{
        id: string;
        key: string;
        fields: {
          summary: string;
          description: unknown;
          status: { name: string };
          priority: { name: string } | null;
          assignee: { displayName: string } | null;
          created: string;
          updated: string;
        };
      }>(`/issue/${encodeURIComponent(issueKeyOrId)}`);
      return {
        id: i.id,
        key: i.key,
        summary: i.fields.summary,
        description: typeof i.fields.description === "string" ? i.fields.description : null,
        status: i.fields.status.name,
        priority: i.fields.priority?.name ?? null,
        assignee: i.fields.assignee?.displayName ?? null,
        created: i.fields.created,
        updated: i.fields.updated,
      };
    },

    /** Create a new issue in the configured project. */
    async createIssue(summary: string, description?: string, issueType = "Task") {
      const payload = {
        fields: {
          project: { key: config.projectKey },
          summary,
          description: description
            ? { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: description }] }] }
            : undefined,
          issuetype: { name: issueType },
        },
      };
      return request<{ id: string; key: string; self: string }>("/issue", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    /** Transition an issue to a new status by name. */
    async transitionIssue(issueKeyOrId: string, statusName: string) {
      const transitions = await request<{
        transitions: Array<{ id: string; name: string; to: { name: string } }>;
      }>(`/issue/${encodeURIComponent(issueKeyOrId)}/transitions`);
      const target = transitions.transitions.find(
        (t) => t.name.toLowerCase() === statusName.toLowerCase() || t.to.name.toLowerCase() === statusName.toLowerCase(),
      );
      if (!target) {
        throw new Error(
          `No transition to "${statusName}" available. Available: ${transitions.transitions.map((t) => t.name).join(", ")}`,
        );
      }
      await request(`/issue/${encodeURIComponent(issueKeyOrId)}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: target.id } }),
      });
    },

    /** Add a comment to an issue. */
    async addComment(issueKeyOrId: string, body: string) {
      return request<{ id: string }>(`/issue/${encodeURIComponent(issueKeyOrId)}/comment`, {
        method: "POST",
        body: JSON.stringify({
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
          },
        }),
      });
    },
  };
}
