import { z } from "zod";

export const INTEGRATION_PROVIDERS = ["jira", "confluent", "github", "sonarqube"] as const;
export type IntegrationProviderConst = (typeof INTEGRATION_PROVIDERS)[number];

// ── Agent capability controls ────────────────────────────────────────
// Fine-grained per-company switches for what AGENTS may do with each provider.
// Board users are never restricted by these. All fields optional: an absent
// field means "use the default", so existing configs keep today's behavior.

export const githubAgentCapabilitiesSchema = z
  .object({
    canRead: z.boolean().optional(),
    canPush: z.boolean().optional(),
    canRaisePr: z.boolean().optional(),
    canMergePr: z.boolean().optional(),
  })
  .strict();
export type GithubAgentCapabilitiesInput = z.infer<typeof githubAgentCapabilitiesSchema>;

export const jiraAgentCapabilitiesSchema = z
  .object({
    canRead: z.boolean().optional(),
    canComment: z.boolean().optional(),
    canTransition: z.boolean().optional(),
    canCreateIssue: z.boolean().optional(),
  })
  .strict();
export type JiraAgentCapabilitiesInput = z.infer<typeof jiraAgentCapabilitiesSchema>;

export interface GithubAgentCapabilities {
  canRead: boolean;
  canPush: boolean;
  canRaisePr: boolean;
  canMergePr: boolean;
}

export interface JiraAgentCapabilities {
  canRead: boolean;
  canComment: boolean;
  canTransition: boolean;
  canCreateIssue: boolean;
}

/** Defaults preserve current policy: agents read/push/raise PRs but never merge. */
export function resolveGithubAgentCapabilities(
  config: Record<string, unknown> | null | undefined,
): GithubAgentCapabilities {
  const caps = (config?.agentCapabilities ?? {}) as Partial<GithubAgentCapabilities>;
  return {
    canRead: caps.canRead ?? true,
    canPush: caps.canPush ?? true,
    canRaisePr: caps.canRaisePr ?? true,
    canMergePr: caps.canMergePr ?? false,
  };
}

/**
 * Jira write defaults follow the operator's env read-only policy
 * (COMBYNE_JIRA_AGENT_READONLY): when read-only is on, writes default OFF.
 * An explicit config value overrides the env default in either direction.
 */
export function resolveJiraAgentCapabilities(
  config: Record<string, unknown> | null | undefined,
  opts: { envReadOnly: boolean },
): JiraAgentCapabilities {
  const caps = (config?.agentCapabilities ?? {}) as Partial<JiraAgentCapabilities>;
  const writeDefault = !opts.envReadOnly;
  return {
    canRead: caps.canRead ?? true,
    canComment: caps.canComment ?? writeDefault,
    canTransition: caps.canTransition ?? writeDefault,
    canCreateIssue: caps.canCreateIssue ?? writeDefault,
  };
}

export const jiraConfigSchema = z.object({
  baseUrl: z
    .string()
    .url("Must be a valid URL")
    .refine((url) => !url.endsWith("/"), "URL must not end with a trailing slash"),
  email: z.string().email("Must be a valid email"),
  apiToken: z.string().min(1, "API token is required"),
  projectKey: z.string().min(1, "Project key is required").max(10),
  agentCapabilities: jiraAgentCapabilitiesSchema.optional(),
});
export type JiraConfigInput = z.infer<typeof jiraConfigSchema>;

export const confluentConfigSchema = z.object({
  bootstrapServer: z.string().min(1, "Bootstrap server is required"),
  apiKey: z.string().min(1, "API key is required"),
  apiSecret: z.string().min(1, "API secret is required"),
  cluster: z.string().min(1, "Cluster ID is required"),
  environment: z.string().min(1, "Environment ID is required"),
});
export type ConfluentConfigInput = z.infer<typeof confluentConfigSchema>;

export const githubConfigSchema = z.object({
  baseUrl: z
    .string()
    .url("Must be a valid URL")
    .refine((url) => !url.endsWith("/"), "URL must not end with a trailing slash"),
  token: z.string().min(1, "Token is required"),
  owner: z.string().min(1, "Owner (org or user) is required"),
  defaultRepo: z.string().optional(),
  agentCapabilities: githubAgentCapabilitiesSchema.optional(),
});
export type GitHubConfigInput = z.infer<typeof githubConfigSchema>;

export const sonarqubeConfigSchema = z.object({
  baseUrl: z
    .string()
    .url("Must be a valid URL")
    .refine((url) => !url.endsWith("/"), "URL must not end with a trailing slash"),
  token: z.string().min(1, "Token is required"),
  projectKey: z.string().min(1, "Project key is required"),
  organization: z.string().optional(),
});
export type SonarQubeConfigInput = z.infer<typeof sonarqubeConfigSchema>;

export const createIntegrationSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("jira"), config: jiraConfigSchema }),
  z.object({ provider: z.literal("confluent"), config: confluentConfigSchema }),
  z.object({ provider: z.literal("github"), config: githubConfigSchema }),
  z.object({ provider: z.literal("sonarqube"), config: sonarqubeConfigSchema }),
]);
export type CreateIntegration = z.infer<typeof createIntegrationSchema>;

export const updateIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: z
      .union([jiraConfigSchema, confluentConfigSchema, githubConfigSchema, sonarqubeConfigSchema])
      .optional(),
    // Capability toggles ride a separate top-level field: the full-config path
    // requires secrets, and we must not force re-entering a token (or wipe it)
    // just to flip an agent capability. The route merges this into the stored
    // config server-side.
    agentCapabilities: z
      .union([githubAgentCapabilitiesSchema, jiraAgentCapabilitiesSchema])
      .optional(),
  })
  .refine(
    (data) =>
      data.enabled !== undefined || data.config !== undefined || data.agentCapabilities !== undefined,
    {
      message: "At least one of enabled, config, or agentCapabilities must be provided",
    },
  );
export type UpdateIntegration = z.infer<typeof updateIntegrationSchema>;

export const jiraSyncIssuesSchema = z.object({
  jql: z.string().optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
});
export type JiraSyncIssues = z.infer<typeof jiraSyncIssuesSchema>;

export const confluentProduceSchema = z.object({
  topic: z.string().min(1),
  key: z.string().optional(),
  value: z.record(z.unknown()),
});
export type ConfluentProduce = z.infer<typeof confluentProduceSchema>;

export const confluentCreateTopicSchema = z.object({
  name: z.string().min(1).max(249),
  partitions: z.number().int().min(1).max(100).default(1),
  replicationFactor: z.number().int().min(1).max(3).default(3),
});
export type ConfluentCreateTopic = z.infer<typeof confluentCreateTopicSchema>;

// ── GitHub operation schemas ─────────────────────────────────────────

export const githubCreatePRSchema = z.object({
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  head: z.string().min(1),
  base: z.string().min(1),
  draft: z.boolean().optional(),
  issueId: z.string().uuid().optional().nullable(),
});
export type GitHubCreatePR = z.infer<typeof githubCreatePRSchema>;

export const githubCreateBranchSchema = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1),
  fromBranch: z.string().optional(),
});
export type GitHubCreateBranch = z.infer<typeof githubCreateBranchSchema>;

export const githubMergePRSchema = z.object({
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  commitMessage: z.string().optional(),
  issueId: z.string().uuid().optional().nullable(),
  approvalId: z.string().uuid().optional().nullable(),
  expectedHeadSha: z.string().optional().nullable(),
});
export type GitHubMergePR = z.infer<typeof githubMergePRSchema>;

export const githubCreateReviewSchema = z.object({
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  body: z.string().optional(),
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
});
export type GitHubCreateReview = z.infer<typeof githubCreateReviewSchema>;

export const githubCreateCommentSchema = z.object({
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  body: z.string().min(1),
});
export type GitHubCreateComment = z.infer<typeof githubCreateCommentSchema>;

// ── SonarQube operation schemas ──────────────────────────────────────

export const sonarqubeListIssuesSchema = z.object({
  projectKey: z.string().optional(),
  types: z.string().optional(),
  severities: z.string().optional(),
  statuses: z.string().optional(),
  maxResults: z.number().int().min(1).max(500).optional(),
});
export type SonarQubeListIssues = z.infer<typeof sonarqubeListIssuesSchema>;

export const sonarqubeGetMetricsSchema = z.object({
  projectKey: z.string().optional(),
  metricKeys: z.string().min(1),
});
export type SonarQubeGetMetrics = z.infer<typeof sonarqubeGetMetricsSchema>;
