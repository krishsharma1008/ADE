export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

export interface ConfluentConfig {
  bootstrapServer: string;
  apiKey: string;
  apiSecret: string;
  cluster: string;
  environment: string;
}

export interface GitHubConfig {
  baseUrl: string;
  token: string;
  owner: string;
  defaultRepo?: string;
}

export interface SonarQubeConfig {
  baseUrl: string;
  token: string;
  projectKey: string;
  organization?: string;
}

export type IntegrationProvider = "jira" | "confluent" | "github" | "sonarqube";

export interface IntegrationRecord {
  id: string;
  companyId: string;
  provider: IntegrationProvider;
  enabled: boolean;
  config: JiraConfig | ConfluentConfig | GitHubConfig | SonarQubeConfig;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description: string | null;
  status: string;
  priority: string | null;
  assignee: string | null;
  created: string;
  updated: string;
}

export interface JiraIssueSyncResult {
  created: number;
  updated: number;
  errors: string[];
}

export interface ConfluentTopic {
  name: string;
  partitions: number;
  replicationFactor: number;
}

export interface ConfluentProduceResult {
  topic: string;
  partition: number;
  offset: number;
}

// ── GitHub response types ────────────────────────────────────────────

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

export interface GitHubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  user: string;
  headBranch: string;
  baseBranch: string;
  merged: boolean;
  mergeable: boolean | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface GitHubPRReview {
  id: number;
  user: string;
  state: string;
  body: string | null;
  submittedAt: string;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ── SonarQube response types ─────────────────────────────────────────

export interface SonarQubeQualityGate {
  status: string;
  conditions: Array<{
    metric: string;
    status: string;
    value: string;
    errorThreshold: string;
  }>;
}

export interface SonarQubeIssue {
  key: string;
  rule: string;
  severity: string;
  component: string;
  message: string;
  line: number | null;
  type: string;
  status: string;
  createdAt: string;
}

export interface SonarQubeMetric {
  metric: string;
  value: string;
}
