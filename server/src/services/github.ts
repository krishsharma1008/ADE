import type {
  GitHubConfig,
  GitHubRepo,
  GitHubBranch,
  GitHubPullRequest,
  GitHubPRReview,
  GitHubCheckRun,
} from "@combyne/shared";

/**
 * GitHub REST API client.
 * Authenticates via Bearer token (PAT or GitHub App installation token).
 */
export function createGitHubClient(config: GitHubConfig) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${config.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API error ${res.status}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as T;
  }

  function mapRepo(r: Record<string, unknown>): GitHubRepo {
    return {
      id: r.id as number,
      name: r.name as string,
      fullName: r.full_name as string,
      private: r.private as boolean,
      defaultBranch: r.default_branch as string,
      cloneUrl: r.clone_url as string,
    };
  }

  function mapPullRequest(p: Record<string, unknown>): GitHubPullRequest {
    const head = p.head as Record<string, unknown>;
    const base = p.base as Record<string, unknown>;
    const user = p.user as Record<string, unknown>;
    return {
      id: p.id as number,
      number: p.number as number,
      title: p.title as string,
      body: (p.body as string) ?? null,
      state: p.state as string,
      draft: (p.draft as boolean) ?? false,
      user: (user?.login as string) ?? "",
      headBranch: head?.ref as string,
      baseBranch: base?.ref as string,
      merged: (p.merged as boolean) ?? false,
      mergeable: (p.mergeable as boolean | null) ?? null,
      createdAt: p.created_at as string,
      updatedAt: p.updated_at as string,
      htmlUrl: p.html_url as string,
    };
  }

  return {
    /** Test connectivity by fetching the authenticated user. */
    async testConnection(): Promise<{ ok: boolean; login?: string; error?: string }> {
      try {
        const user = await request<{ login: string }>("/user");
        return { ok: true, login: user.login };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    /** List repositories for the configured owner (org or user). */
    async listRepos(): Promise<GitHubRepo[]> {
      let data: Array<Record<string, unknown>>;
      try {
        data = await request<Array<Record<string, unknown>>>(
          `/orgs/${encodeURIComponent(config.owner)}/repos?per_page=100`,
        );
      } catch (err) {
        if ((err as Error).message.includes("404")) {
          data = await request<Array<Record<string, unknown>>>(
            `/users/${encodeURIComponent(config.owner)}/repos?per_page=100`,
          );
        } else {
          throw err;
        }
      }
      return data.map(mapRepo);
    },

    /** Get a single repository by name. */
    async getRepo(repo: string): Promise<GitHubRepo> {
      const r = await request<Record<string, unknown>>(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}`,
      );
      return mapRepo(r);
    },

    /** List branches for a repository. */
    async listBranches(repo: string): Promise<GitHubBranch[]> {
      const data = await request<
        Array<{ name: string; commit: { sha: string }; protected: boolean }>
      >(`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}/branches?per_page=100`);
      return data.map((b) => ({
        name: b.name,
        sha: b.commit.sha,
        protected: b.protected,
      }));
    },

    /** Create a new branch from an existing branch (defaults to the repo's default branch). */
    async createBranch(
      repo: string,
      branch: string,
      fromBranch?: string,
    ): Promise<{ ref: string; sha: string }> {
      const owner = encodeURIComponent(config.owner);
      const repoEnc = encodeURIComponent(repo);

      let sourceBranch = fromBranch;
      if (!sourceBranch) {
        const repoData = await request<{ default_branch: string }>(
          `/repos/${owner}/${repoEnc}`,
        );
        sourceBranch = repoData.default_branch;
      }

      const refData = await request<{ object: { sha: string } }>(
        `/repos/${owner}/${repoEnc}/git/ref/heads/${encodeURIComponent(sourceBranch)}`,
      );
      const sha = refData.object.sha;

      const result = await request<{ ref: string; object: { sha: string } }>(
        `/repos/${owner}/${repoEnc}/git/refs`,
        {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
        },
      );
      return { ref: result.ref, sha: result.object.sha };
    },

    /** List pull requests for a repository. */
    async listPullRequests(
      repo: string,
      state?: "open" | "closed" | "all",
    ): Promise<GitHubPullRequest[]> {
      const data = await request<Array<Record<string, unknown>>>(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}/pulls?state=${state || "open"}&per_page=100`,
      );
      return data.map(mapPullRequest);
    },

    /** Get a single pull request by number. */
    async getPullRequest(repo: string, number: number): Promise<GitHubPullRequest> {
      const p = await request<Record<string, unknown>>(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      );
      return mapPullRequest(p);
    },

    /** Create a new pull request. */
    async createPullRequest(
      repo: string,
      title: string,
      head: string,
      base: string,
      body?: string,
      draft?: boolean,
    ): Promise<GitHubPullRequest> {
      const p = await request<Record<string, unknown>>(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}/pulls`,
        {
          method: "POST",
          body: JSON.stringify({ title, head, base, body: body ?? "", draft: draft ?? false }),
        },
      );
      return mapPullRequest(p);
    },

    /** Merge a pull request. */
    async mergePullRequest(
      repo: string,
      number: number,
      method?: "merge" | "squash" | "rebase",
      commitMessage?: string,
    ): Promise<{ merged: boolean; message: string }> {
      return request<{ merged: boolean; message: string }>(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`,
        {
          method: "PUT",
          body: JSON.stringify({
            merge_method: method ?? "merge",
            commit_message: commitMessage,
          }),
        },
      );
    },

    /** List reviews on a pull request. */
    async listPRReviews(repo: string, number: number): Promise<GitHubPRReview[]> {
      const data = await request<
        Array<{
          id: number;
          user: { login: string };
          state: string;
          body: string | null;
          submitted_at: string;
        }>
      >(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
      );
      return data.map((r) => ({
        id: r.id,
        user: r.user.login,
        state: r.state,
        body: r.body ?? null,
        submittedAt: r.submitted_at,
      }));
    },

    /** Create a review on a pull request. */
    async createPRReview(
      repo: string,
      number: number,
      body: string | undefined,
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    ): Promise<GitHubPRReview> {
      const r = await request<{
        id: number;
        user: { login: string };
        state: string;
        body: string | null;
        submitted_at: string;
      }>(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
        {
          method: "POST",
          body: JSON.stringify({ body, event }),
        },
      );
      return {
        id: r.id,
        user: r.user.login,
        state: r.state,
        body: r.body ?? null,
        submittedAt: r.submitted_at,
      };
    },

    /** Create a comment on a pull request (via the issues API). */
    async createPRComment(
      repo: string,
      number: number,
      body: string,
    ): Promise<{ id: number }> {
      return request<{ id: number }>(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
    },

    /** List check runs for a given ref (branch, tag, or commit SHA). */
    async listCheckRuns(repo: string, ref: string): Promise<GitHubCheckRun[]> {
      const data = await request<{
        check_runs: Array<{
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
          started_at: string;
          completed_at: string | null;
        }>;
      }>(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs`,
      );
      return data.check_runs.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        startedAt: c.started_at,
        completedAt: c.completed_at,
      }));
    },

    /** Get the authenticated clone URL for a repository. */
    getCloneUrl(repo: string): string {
      const host = config.baseUrl.replace(/^https?:\/\//, "").replace(/\/api\/v3\/?$/, "");
      const effectiveHost = host === "api.github.com" ? "github.com" : host;
      return `https://x-access-token:${config.token}@${effectiveHost}/${config.owner}/${repo}.git`;
    },
  };
}
