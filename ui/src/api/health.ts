export type HealthDatabaseInfo = {
  mode: "embedded-postgres" | "external-postgres";
  host: string;
  port: number | null;
  database: string;
};

export type AdapterProbeInfo = {
  available: boolean;
  binary: string;
  resolvedPath: string | null;
  installHint: string;
  docsUrl: string | null;
  requiresCli: boolean;
};

export type HealthStatus = {
  status: "ok";
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: "private" | "public";
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending" | "needs_onboarding";
  licenseEnabled?: boolean;
  licenseStatus?: string;
  database?: HealthDatabaseInfo | null;
  adapters?: Record<string, AdapterProbeInfo> | null;
  features?: {
    companyDeletionEnabled?: boolean;
  };
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetch("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load health (${res.status})`);
    }
    return res.json();
  },
};
