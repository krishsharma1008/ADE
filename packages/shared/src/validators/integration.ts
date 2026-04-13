import { z } from "zod";

export const INTEGRATION_PROVIDERS = ["jira", "confluent", "github", "sonarqube"] as const;
export type IntegrationProviderConst = (typeof INTEGRATION_PROVIDERS)[number];

export const jiraConfigSchema = z.object({
  baseUrl: z
    .string()
    .url("Must be a valid URL")
    .refine((url) => !url.endsWith("/"), "URL must not end with a trailing slash"),
  email: z.string().email("Must be a valid email"),
  apiToken: z.string().min(1, "API token is required"),
  projectKey: z.string().min(1, "Project key is required").max(10),
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
  })
  .refine((data) => data.enabled !== undefined || data.config !== undefined, {
    message: "At least one of enabled or config must be provided",
  });
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
