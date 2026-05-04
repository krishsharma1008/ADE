import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { integrationsApi } from "../api/integrations";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Loader2,
  Check,
  X,
  Trash2,
  ChevronDown,
  ChevronRight,
  Plug,
  ExternalLink,
  Zap,
  ShieldCheck,
  HelpCircle,
  GitBranch,
  Bug,
  MessageSquare,
  BarChart3,
} from "lucide-react";
import { cn } from "../lib/utils";
import type {
  IntegrationRecord,
  IntegrationProvider,
  JiraConfig,
  ConfluentConfig,
  GitHubConfig,
  SonarQubeConfig,
} from "@combyne/shared";

/* ── Blank configs ──────────────────────────────────────────────────── */

const BLANK_JIRA: JiraConfig = {
  baseUrl: "",
  email: "",
  apiToken: "",
  projectKey: "",
};

const BLANK_CONFLUENT: ConfluentConfig = {
  bootstrapServer: "",
  apiKey: "",
  apiSecret: "",
  cluster: "",
  environment: "",
};

const BLANK_GITHUB: GitHubConfig = {
  baseUrl: "https://api.github.com",
  token: "",
  owner: "",
  defaultRepo: "",
};

const BLANK_SONARQUBE: SonarQubeConfig = {
  baseUrl: "",
  token: "",
  projectKey: "",
  organization: "",
};

/* ── Provider metadata ──────────────────────────────────────────────── */

interface ProviderMeta {
  key: IntegrationProvider;
  name: string;
  description: string;
  iconBg: string;
  iconLetter: string;
  capabilities: string[];
  helpUrl?: string;
  helpLabel?: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    key: "github",
    name: "GitHub",
    description: "Source control, pull requests, code reviews, and CI checks",
    iconBg: "bg-[#24292f] dark:bg-[#f0f0f0]",
    iconLetter: "G",
    capabilities: ["Create branches & PRs", "Dashboard-gated merge", "Code reviews", "CI status checks"],
    helpUrl: "https://github.com/settings/tokens",
    helpLabel: "Create a token",
  },
  {
    key: "jira",
    name: "Jira",
    description: "Issue tracking, project management, and sprint planning",
    iconBg: "bg-blue-600",
    iconLetter: "J",
    capabilities: ["Sync issues", "Create & update tickets", "Track sprints"],
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    helpLabel: "Get an API token",
  },
  {
    key: "sonarqube",
    name: "SonarQube",
    description: "Code quality analysis, security scanning, and quality gates",
    iconBg: "bg-[#549dd0]",
    iconLetter: "S",
    capabilities: ["Quality gate checks", "Issue detection", "Metrics & coverage"],
    helpUrl: "https://docs.sonarsource.com/sonarqube/latest/user-guide/user-account/generating-and-using-tokens/",
    helpLabel: "Generate a token",
  },
  {
    key: "confluent",
    name: "Confluent Cloud",
    description: "Event streaming with Apache Kafka for real-time data pipelines",
    iconBg: "bg-sky-600",
    iconLetter: "C",
    capabilities: ["Produce events", "Create topics", "Stream management"],
  },
];

/* ── Shared field component ─────────────────────────────────────────── */

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs">{label}</Label>
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex text-muted-foreground/40 hover:text-muted-foreground transition-colors"
              >
                <HelpCircle className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs">
              {hint}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
}

/* ── Page component ─────────────────────────────────────────────────── */

export function Integrations() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [jiraForm, setJiraForm] = useState<JiraConfig>({ ...BLANK_JIRA });
  const [confluentForm, setConfluentForm] = useState<ConfluentConfig>({ ...BLANK_CONFLUENT });
  const [githubForm, setGitHubForm] = useState<GitHubConfig>({ ...BLANK_GITHUB });
  const [sonarqubeForm, setSonarQubeForm] = useState<SonarQubeConfig>({ ...BLANK_SONARQUBE });
  const [formError, setFormError] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<IntegrationProvider | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Integrations" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const { data: integrations, isLoading } = useQuery({
    queryKey: queryKeys.integrations(selectedCompanyId!),
    queryFn: () => integrationsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const configured = new Map<IntegrationProvider, IntegrationRecord>();
  for (const row of integrations ?? []) {
    configured.set(row.provider, row);
  }

  const jiraRecord = configured.get("jira");
  const confluentRecord = configured.get("confluent");
  const githubRecord = configured.get("github");
  const sonarqubeRecord = configured.get("sonarqube");
  const jiraConnected = !!jiraRecord;
  const confluentConnected = !!confluentRecord;
  const githubConnected = !!githubRecord;
  const sonarqubeConnected = !!sonarqubeRecord;

  const isConnected = (provider: IntegrationProvider) =>
    configured.has(provider);

  useEffect(() => {
    if (jiraRecord) {
      const cfg = jiraRecord.config as JiraConfig;
      setJiraForm({ baseUrl: cfg.baseUrl ?? "", email: cfg.email ?? "", apiToken: "", projectKey: cfg.projectKey ?? "" });
    }
  }, [jiraRecord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (confluentRecord) {
      const cfg = confluentRecord.config as ConfluentConfig;
      setConfluentForm({ bootstrapServer: cfg.bootstrapServer ?? "", apiKey: cfg.apiKey ?? "", apiSecret: "", cluster: cfg.cluster ?? "", environment: cfg.environment ?? "" });
    }
  }, [confluentRecord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (githubRecord) {
      const cfg = githubRecord.config as GitHubConfig;
      setGitHubForm({ baseUrl: cfg.baseUrl ?? "https://api.github.com", token: "", owner: cfg.owner ?? "", defaultRepo: cfg.defaultRepo ?? "" });
    }
  }, [githubRecord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sonarqubeRecord) {
      const cfg = sonarqubeRecord.config as SonarQubeConfig;
      setSonarQubeForm({ baseUrl: cfg.baseUrl ?? "", token: "", projectKey: cfg.projectKey ?? "", organization: cfg.organization ?? "" });
    }
  }, [sonarqubeRecord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.integrations(selectedCompanyId!) });

  const saveMutation = useMutation({
    mutationFn: ({ provider, config, isUpdate }: { provider: IntegrationProvider; config: Record<string, unknown>; isUpdate: boolean }) =>
      isUpdate
        ? integrationsApi.update(selectedCompanyId!, provider, { config })
        : integrationsApi.create(selectedCompanyId!, provider, config),
    onSuccess: () => { invalidate(); setFormError(null); },
    onError: (err) => { setFormError(err instanceof Error ? err.message : "Failed to save"); },
  });

  const deleteMutation = useMutation({
    mutationFn: (provider: IntegrationProvider) => integrationsApi.delete(selectedCompanyId!, provider),
    onSuccess: () => {
      invalidate();
      if (deleteMutation.variables === "jira") setJiraForm({ ...BLANK_JIRA });
      if (deleteMutation.variables === "confluent") setConfluentForm({ ...BLANK_CONFLUENT });
      if (deleteMutation.variables === "github") setGitHubForm({ ...BLANK_GITHUB });
      if (deleteMutation.variables === "sonarqube") setSonarQubeForm({ ...BLANK_SONARQUBE });
      setExpandedProvider(null);
    },
  });

  const testMutation = useMutation({
    mutationFn: (provider: IntegrationProvider) => integrationsApi.test(selectedCompanyId!, provider),
  });

  function handleSave(provider: IntegrationProvider) {
    let config: Record<string, unknown>;
    let connected: boolean;
    switch (provider) {
      case "jira":
        config = { ...jiraForm };
        connected = jiraConnected;
        if (connected && !config.apiToken) delete config.apiToken;
        break;
      case "confluent":
        config = { ...confluentForm };
        connected = confluentConnected;
        if (connected && !config.apiSecret) delete config.apiSecret;
        break;
      case "github":
        config = { ...githubForm };
        connected = githubConnected;
        if (connected && !config.token) delete config.token;
        break;
      case "sonarqube":
        config = { ...sonarqubeForm };
        connected = sonarqubeConnected;
        if (connected && !config.token) delete config.token;
        break;
      default:
        return;
    }
    saveMutation.mutate({ provider, config, isUpdate: connected });
  }

  function handleDisconnect(provider: IntegrationProvider) {
    const label = PROVIDERS.find((p) => p.key === provider)?.name ?? provider;
    if (window.confirm(`Disconnect ${label}? This will remove all stored credentials.`)) {
      deleteMutation.mutate(provider);
    }
  }

  function toggleExpand(provider: IntegrationProvider) {
    setExpandedProvider((prev) => (prev === provider ? null : provider));
    setFormError(null);
    testMutation.reset();
  }

  if (!selectedCompany) {
    return <div className="text-sm text-muted-foreground">No company selected.</div>;
  }

  const saving = saveMutation.isPending;
  const connectedCount = PROVIDERS.filter((p) => isConnected(p.key)).length;

  return (
    <div className="max-w-3xl space-y-6">
      {/* ── Page header ──────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <Plug className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Integrations</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Connect external services so your agents can interact with code, tickets, quality gates, and event streams.
          </p>
        </div>
        {!isLoading && (
          <Badge variant="secondary" className="shrink-0 mt-1">
            {connectedCount}/{PROVIDERS.length} connected
          </Badge>
        )}
      </div>

      {/* ── Loading ──────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading integrations...
        </div>
      )}

      {/* ── Error banner ─────────────────────────────────────────── */}
      {formError && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <X className="h-4 w-4 shrink-0" />
          {formError}
          <button className="ml-auto text-destructive/60 hover:text-destructive" onClick={() => setFormError(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Provider cards ───────────────────────────────────────── */}
      {!isLoading && (
        <div className="space-y-3">
          {PROVIDERS.map((meta) => {
            const connected = isConnected(meta.key);
            const expanded = expandedProvider === meta.key;
            const isSaving = saving && saveMutation.variables?.provider === meta.key;
            const isDeleting = deleteMutation.isPending && deleteMutation.variables === meta.key;
            const testSuccess = testMutation.isSuccess && testMutation.variables === meta.key;
            const testError = testMutation.isError && testMutation.variables === meta.key;
            const isTesting = testMutation.isPending && testMutation.variables === meta.key;

            return (
              <div
                key={meta.key}
                className={cn(
                  "rounded-lg border transition-colors",
                  expanded ? "border-border bg-card shadow-sm" : "border-border/60 hover:border-border",
                )}
              >
                {/* ── Card header (always visible) ───────── */}
                <button
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
                  onClick={() => toggleExpand(meta.key)}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold shrink-0",
                      meta.iconBg,
                      meta.key === "github" ? "text-white dark:text-[#24292f]" : "text-white",
                    )}
                  >
                    {meta.iconLetter}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{meta.name}</span>
                      {connected && (
                        <span className="flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                          Connected
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{meta.description}</p>
                  </div>

                  <div className="shrink-0 text-muted-foreground/50">
                    {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </div>
                </button>

                {/* ── Capabilities summary (collapsed) ───── */}
                {!expanded && (
                  <div className="flex items-center gap-1.5 px-4 pb-3 -mt-1 flex-wrap">
                    {meta.capabilities.map((cap) => (
                      <span
                        key={cap}
                        className="inline-flex items-center rounded-md bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {cap}
                      </span>
                    ))}
                  </div>
                )}

                {/* ── Expanded form ──────────────────────── */}
                {expanded && (
                  <div className="border-t border-border/60 px-4 py-4 space-y-5">
                    {/* Connected actions bar */}
                    {connected && (
                      <div className="flex items-center justify-between rounded-md bg-green-500/5 border border-green-500/10 px-3 py-2">
                        <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Credentials stored and encrypted
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => testMutation.mutate(meta.key)}
                            disabled={isTesting}
                            className="text-xs"
                          >
                            {isTesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                            Test
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={(e) => { e.stopPropagation(); handleDisconnect(meta.key); }}
                            disabled={isDeleting}
                          >
                            <Trash2 className="h-3 w-3" />
                            Disconnect
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Test result feedback */}
                    {testSuccess && (
                      <div className="flex items-center gap-2 rounded-md bg-green-500/10 border border-green-500/20 px-3 py-2 text-xs text-green-700 dark:text-green-400">
                        <Check className="h-3.5 w-3.5" />
                        Connection verified successfully
                      </div>
                    )}
                    {testError && (
                      <div className="flex items-center gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
                        <X className="h-3.5 w-3.5" />
                        {testMutation.error instanceof Error ? testMutation.error.message : "Connection test failed"}
                      </div>
                    )}

                    {/* Provider-specific form */}
                    {meta.key === "jira" && (
                      <JiraForm form={jiraForm} setForm={setJiraForm} connected={jiraConnected} />
                    )}
                    {meta.key === "confluent" && (
                      <ConfluentForm form={confluentForm} setForm={setConfluentForm} connected={confluentConnected} />
                    )}
                    {meta.key === "github" && (
                      <GitHubForm form={githubForm} setForm={setGitHubForm} connected={githubConnected} />
                    )}
                    {meta.key === "sonarqube" && (
                      <SonarQubeForm form={sonarqubeForm} setForm={setSonarQubeForm} connected={sonarqubeConnected} />
                    )}

                    {/* Actions footer */}
                    <div className="flex items-center justify-between pt-1">
                      <div>
                        {meta.helpUrl && (
                          <a
                            href={meta.helpUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {meta.helpLabel ?? "Documentation"}
                          </a>
                        )}
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleSave(meta.key)}
                        disabled={isSaving}
                      >
                        {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {connected ? `Update ${meta.name}` : `Connect ${meta.name}`}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Agent capabilities info ──────────────────────────────── */}
      {!isLoading && connectedCount > 0 && (
        <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">What agents can do with these integrations</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
            {githubConnected && (
              <>
                <AgentCapability icon={GitBranch} text="Create branches and pull requests" />
                <AgentCapability icon={Check} text="Approve, review, and merge PRs" />
              </>
            )}
            {jiraConnected && (
              <>
                <AgentCapability icon={MessageSquare} text="Sync and create Jira tickets" />
              </>
            )}
            {sonarqubeConnected && (
              <>
                <AgentCapability icon={Bug} text="Check quality gates before merging" />
                <AgentCapability icon={BarChart3} text="Pull coverage and code metrics" />
              </>
            )}
            {confluentConnected && (
              <>
                <AgentCapability icon={Zap} text="Produce events to Kafka topics" />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Agent capability row ───────────────────────────────────────────── */

function AgentCapability({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <Icon className="h-3 w-3 text-muted-foreground/60 shrink-0" />
      <span className="text-xs text-muted-foreground">{text}</span>
    </div>
  );
}

/* ── Provider form components ───────────────────────────────────────── */

function GitHubForm({
  form,
  setForm,
  connected,
}: {
  form: GitHubConfig;
  setForm: (f: GitHubConfig) => void;
  connected: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <FormField label="API Base URL" hint="Use default for github.com, or your GitHub Enterprise URL">
        <Input
          type="url"
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          placeholder="https://api.github.com"
        />
      </FormField>
      <FormField label="Owner" hint="Organization or user that owns the repositories">
        <Input
          value={form.owner}
          onChange={(e) => setForm({ ...form, owner: e.target.value })}
          placeholder="my-org"
        />
      </FormField>
      <FormField label="Personal Access Token" hint="Fine-grained or classic token with repo access">
        <Input
          type="password"
          value={form.token}
          onChange={(e) => setForm({ ...form, token: e.target.value })}
          placeholder={connected ? "Leave blank to keep current" : "ghp_xxxxxxxxxxxx"}
        />
      </FormField>
      <FormField label="Default Repository" hint="Optional. Agents will use this repo unless they specify one">
        <Input
          value={form.defaultRepo ?? ""}
          onChange={(e) => setForm({ ...form, defaultRepo: e.target.value })}
          placeholder="my-repo (optional)"
        />
      </FormField>
    </div>
  );
}

function JiraForm({
  form,
  setForm,
  connected,
}: {
  form: JiraConfig;
  setForm: (f: JiraConfig) => void;
  connected: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <FormField label="Jira Cloud URL" hint="Your Atlassian Cloud instance URL">
        <Input
          type="url"
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          placeholder="https://yourteam.atlassian.net"
        />
      </FormField>
      <FormField label="Email" hint="Email associated with your Jira API token">
        <Input
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="you@company.com"
        />
      </FormField>
      <FormField label="API Token" hint="Generate from your Atlassian account settings">
        <Input
          type="password"
          value={form.apiToken}
          onChange={(e) => setForm({ ...form, apiToken: e.target.value })}
          placeholder={connected ? "Leave blank to keep current" : "Paste your Jira API token"}
        />
      </FormField>
      <FormField label="Project Key" hint="Default Jira project key (e.g. PROJ)">
        <Input
          value={form.projectKey}
          onChange={(e) => setForm({ ...form, projectKey: e.target.value })}
          placeholder="PROJ"
          maxLength={10}
        />
      </FormField>
    </div>
  );
}

function SonarQubeForm({
  form,
  setForm,
  connected,
}: {
  form: SonarQubeConfig;
  setForm: (f: SonarQubeConfig) => void;
  connected: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <FormField label="Server URL" hint="Your SonarQube or SonarCloud URL">
        <Input
          type="url"
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          placeholder="https://sonarqube.example.com"
        />
      </FormField>
      <FormField label="Token" hint="User or project analysis token">
        <Input
          type="password"
          value={form.token}
          onChange={(e) => setForm({ ...form, token: e.target.value })}
          placeholder={connected ? "Leave blank to keep current" : "Paste your SonarQube token"}
        />
      </FormField>
      <FormField label="Project Key" hint="Default project key for analysis">
        <Input
          value={form.projectKey}
          onChange={(e) => setForm({ ...form, projectKey: e.target.value })}
          placeholder="my-project-key"
        />
      </FormField>
      <FormField label="Organization" hint="Required for SonarCloud. Leave blank for self-hosted">
        <Input
          value={form.organization ?? ""}
          onChange={(e) => setForm({ ...form, organization: e.target.value })}
          placeholder="my-org (optional)"
        />
      </FormField>
    </div>
  );
}

function ConfluentForm({
  form,
  setForm,
  connected,
}: {
  form: ConfluentConfig;
  setForm: (f: ConfluentConfig) => void;
  connected: boolean;
}) {
  return (
    <div className="space-y-4">
      <FormField label="Bootstrap Server" hint="Confluent Cloud bootstrap server address">
        <Input
          value={form.bootstrapServer}
          onChange={(e) => setForm({ ...form, bootstrapServer: e.target.value })}
          placeholder="pkc-xxxxx.us-east-1.aws.confluent.cloud:9092"
        />
      </FormField>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Cluster ID" hint="Confluent cluster identifier">
          <Input
            value={form.cluster}
            onChange={(e) => setForm({ ...form, cluster: e.target.value })}
            placeholder="lkc-xxxxx"
          />
        </FormField>
        <FormField label="Environment ID" hint="Confluent environment identifier">
          <Input
            value={form.environment}
            onChange={(e) => setForm({ ...form, environment: e.target.value })}
            placeholder="env-xxxxx"
          />
        </FormField>
        <FormField label="API Key" hint="Confluent Cloud API key">
          <Input
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder="API key"
          />
        </FormField>
        <FormField label="API Secret" hint="Confluent Cloud API secret">
          <Input
            type="password"
            value={form.apiSecret}
            onChange={(e) => setForm({ ...form, apiSecret: e.target.value })}
            placeholder={connected ? "Leave blank to keep current" : "Enter API secret"}
          />
        </FormField>
      </div>
    </div>
  );
}
