import type {
  SonarQubeConfig,
  SonarQubeQualityGate,
  SonarQubeIssue,
  SonarQubeMetric,
} from "@combyne/shared";

/**
 * SonarQube REST API client.
 * Authenticates via Bearer token.
 */
export function createSonarQubeClient(config: SonarQubeConfig) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${config.baseUrl}/api${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`SonarQube API error ${res.status}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as T;
  }

  return {
    /** Test connectivity by fetching system status. */
    async testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
      try {
        const info = await request<{ status: string; version?: string }>("/system/status");
        return { ok: true, version: info.version };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    /** Get the quality gate status for a project. */
    async getQualityGateStatus(projectKey?: string): Promise<SonarQubeQualityGate> {
      const key = projectKey || config.projectKey;
      const data = await request<{
        projectStatus: {
          status: string;
          conditions: Array<{
            metricKey: string;
            status: string;
            actualValue: string;
            errorThreshold: string;
          }>;
        };
      }>(`/qualitygates/project_status?projectKey=${encodeURIComponent(key)}`);
      return {
        status: data.projectStatus.status,
        conditions: data.projectStatus.conditions.map((c) => ({
          metric: c.metricKey,
          status: c.status,
          value: c.actualValue,
          errorThreshold: c.errorThreshold,
        })),
      };
    },

    /** List issues for a project with optional filters. */
    async listIssues(opts?: {
      projectKey?: string;
      types?: string[];
      severities?: string[];
      pageSize?: number;
    }): Promise<SonarQubeIssue[]> {
      const key = opts?.projectKey || config.projectKey;
      const params = new URLSearchParams();
      params.set("componentKeys", key);
      if (opts?.types?.length) params.set("types", opts.types.join(","));
      if (opts?.severities?.length) params.set("severities", opts.severities.join(","));
      params.set("ps", String(opts?.pageSize ?? 100));

      const data = await request<{
        issues: Array<{
          key: string;
          rule: string;
          severity: string;
          component: string;
          message: string;
          line?: number;
          type: string;
          status: string;
          creationDate: string;
        }>;
      }>(`/issues/search?${params.toString()}`);
      return data.issues.map((i) => ({
        key: i.key,
        rule: i.rule,
        severity: i.severity,
        component: i.component,
        message: i.message,
        line: i.line ?? null,
        type: i.type,
        status: i.status,
        createdAt: i.creationDate,
      }));
    },

    /** Get project metrics. */
    async getMetrics(
      projectKey: string | undefined,
      metricKeys: string[],
    ): Promise<SonarQubeMetric[]> {
      const key = projectKey || config.projectKey;
      const data = await request<{
        component: {
          measures: Array<{ metric: string; value: string }>;
        };
      }>(
        `/measures/component?component=${encodeURIComponent(key)}&metricKeys=${encodeURIComponent(metricKeys.join(","))}`,
      );
      return data.component.measures.map((m) => ({
        metric: m.metric,
        value: m.value,
      }));
    },

    /** Get the latest analysis task status for a project. */
    async getAnalysisStatus(
      projectKey?: string,
    ): Promise<{ id: string; status: string; submittedAt: string; executedAt?: string } | null> {
      const key = projectKey || config.projectKey;
      const data = await request<{
        tasks: Array<{
          id: string;
          status: string;
          submittedAt: string;
          executedAt?: string;
        }>;
      }>(`/ce/activity?component=${encodeURIComponent(key)}&ps=1`);
      if (!data.tasks.length) return null;
      const t = data.tasks[0];
      return {
        id: t.id,
        status: t.status,
        submittedAt: t.submittedAt,
        executedAt: t.executedAt,
      };
    },
  };
}
