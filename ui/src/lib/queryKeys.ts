export const queryKeys = {
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
    stats: ["companies", "stats"] as const,
  },
  agents: {
    list: (companyId: string) => ["agents", companyId] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runtimeState: (id: string) => ["agents", "runtime-state", id] as const,
    taskSessions: (id: string) => ["agents", "task-sessions", id] as const,
    keys: (agentId: string) => ["agents", "keys", agentId] as const,
    configRevisions: (agentId: string) => ["agents", "config-revisions", agentId] as const,
    adapterModels: (companyId: string, adapterType: string) =>
      ["agents", companyId, "adapter-models", adapterType] as const,
  },
  issues: {
    list: (companyId: string) => ["issues", companyId] as const,
    search: (companyId: string, q: string, projectId?: string) =>
      ["issues", companyId, "search", q, projectId ?? "__all-projects__"] as const,
    listAssignedToMe: (companyId: string) => ["issues", companyId, "assigned-to-me"] as const,
    listTouchedByMe: (companyId: string) => ["issues", companyId, "touched-by-me"] as const,
    listUnreadTouchedByMe: (companyId: string) => ["issues", companyId, "unread-touched-by-me"] as const,
    labels: (companyId: string) => ["issues", companyId, "labels"] as const,
    listByProject: (companyId: string, projectId: string) =>
      ["issues", companyId, "project", projectId] as const,
    detail: (id: string) => ["issues", "detail", id] as const,
    comments: (issueId: string) => ["issues", "comments", issueId] as const,
    attachments: (issueId: string) => ["issues", "attachments", issueId] as const,
    activity: (issueId: string) => ["issues", "activity", issueId] as const,
    runs: (issueId: string) => ["issues", "runs", issueId] as const,
    approvals: (issueId: string) => ["issues", "approvals", issueId] as const,
    liveRuns: (issueId: string) => ["issues", "live-runs", issueId] as const,
    activeRun: (issueId: string) => ["issues", "active-run", issueId] as const,
    documents: (issueId: string) => ["issues", "documents", issueId] as const,
    documentRevisions: (issueId: string, documentId: string) =>
      ["issues", "documents", issueId, documentId, "revisions"] as const,
  },
  projects: {
    list: (companyId: string) => ["projects", companyId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
  },
  goals: {
    list: (companyId: string) => ["goals", companyId] as const,
    detail: (id: string) => ["goals", "detail", id] as const,
  },
  issuePlans: {
    forIssue: (issueId: string) => ["issue-plans", issueId] as const,
    list: (companyId: string, status?: string) =>
      ["issue-plans", "list", companyId, status] as const,
  },
  approvals: {
    list: (companyId: string, status?: string) =>
      ["approvals", companyId, status] as const,
    detail: (approvalId: string) => ["approvals", "detail", approvalId] as const,
    comments: (approvalId: string) => ["approvals", "comments", approvalId] as const,
    issues: (approvalId: string) => ["approvals", "issues", approvalId] as const,
  },
  access: {
    joinRequests: (companyId: string, status: string = "pending_approval") =>
      ["access", "join-requests", companyId, status] as const,
    invite: (token: string) => ["access", "invite", token] as const,
  },
  auth: {
    session: ["auth", "session"] as const,
  },
  health: ["health"] as const,
  secrets: {
    list: (companyId: string) => ["secrets", companyId] as const,
    providers: (companyId: string) => ["secret-providers", companyId] as const,
  },
  dashboard: (companyId: string) => ["dashboard", companyId] as const,
  sidebarBadges: (companyId: string) => ["sidebar-badges", companyId] as const,
  activity: (companyId: string) => ["activity", companyId] as const,
  costs: (companyId: string, from?: string, to?: string) =>
    ["costs", companyId, from, to] as const,
  heartbeats: (companyId: string, agentId?: string) =>
    ["heartbeats", companyId, agentId] as const,
  liveRuns: (companyId: string) => ["live-runs", companyId] as const,
  runIssues: (runId: string) => ["run-issues", runId] as const,
  org: (companyId: string) => ["org", companyId] as const,
  integrations: (companyId: string) => ["integrations", companyId] as const,
  routines: {
    list: (companyId: string) => ["routines", companyId] as const,
    detail: (id: string) => ["routines", "detail", id] as const,
    runs: (id: string) => ["routines", "runs", id] as const,
    activity: (companyId: string, routineId: string) =>
      ["routines", "activity", companyId, routineId] as const,
  },
  executionWorkspaces: {
    list: (
      companyId: string,
      filter?: {
        projectId?: string;
        projectWorkspaceId?: string;
        reuseEligible?: boolean;
      },
    ) =>
      [
        "execution-workspaces",
        companyId,
        filter?.projectId,
        filter?.projectWorkspaceId,
        filter?.reuseEligible ?? false,
      ] as const,
    detail: (id: string) => ["execution-workspaces", "detail", id] as const,
    closeReadiness: (id: string) => ["execution-workspaces", "close-readiness", id] as const,
    workspaceOperations: (id: string) =>
      ["execution-workspaces", "workspace-operations", id] as const,
  },
  plugins: {
    all: ["plugins"] as const,
    examples: ["plugins", "examples"] as const,
    uiContributions: ["plugins", "ui-contributions"] as const,
    detail: (id: string) => ["plugins", "detail", id] as const,
    health: (id: string) => ["plugins", "health", id] as const,
    dashboard: (id: string) => ["plugins", "dashboard", id] as const,
    logs: (id: string) => ["plugins", "logs", id] as const,
    config: (id: string) => ["plugins", "config", id] as const,
  },
  companySkills: {
    list: (companyId: string) => ["company-skills", companyId] as const,
    detail: (companyId: string, skillId: string) =>
      ["company-skills", companyId, skillId] as const,
    file: (companyId: string, skillId: string, path: string) =>
      ["company-skills", companyId, skillId, "file", path] as const,
    updateStatus: (companyId: string, skillId: string) =>
      ["company-skills", companyId, skillId, "update-status"] as const,
  },
  instanceSettings: {
    general: ["instance-settings", "general"] as const,
    experimental: ["instance-settings", "experimental"] as const,
  },
  instance: {
    generalSettings: ["instance-settings", "general"] as const,
    experimentalSettings: ["instance-settings", "experimental"] as const,
    schedulerHeartbeats: ["instance", "scheduler-heartbeats"] as const,
  },
  cliAuth: {
    challenge: (challengeId: string) => ["cli-auth", challengeId] as const,
  },
};
