import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { deriveAgentUrlKey, deriveProjectUrlKey } from "@combyne/shared";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relativeTime(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatDate(date);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Build an issue URL using the human-readable identifier when available. */
export function issueUrl(issue: { id: string; identifier?: string | null }): string {
  return `/issues/${issue.identifier ?? issue.id}`;
}

/** Build an agent route URL using the short URL key when available. */
export function agentRouteRef(agent: { id: string; urlKey?: string | null; name?: string | null }): string {
  return agent.urlKey ?? deriveAgentUrlKey(agent.name, agent.id);
}

/** Build an agent URL using the short URL key when available. */
export function agentUrl(agent: { id: string; urlKey?: string | null; name?: string | null }): string {
  return `/agents/${agentRouteRef(agent)}`;
}

/** Build a project route reference using the short URL key when available. */
export function projectRouteRef(project: { id: string; urlKey?: string | null; name?: string | null }): string {
  return project.urlKey ?? deriveProjectUrlKey(project.name, project.id);
}

/** Build a project URL using the short URL key when available. */
export function projectUrl(project: { id: string; urlKey?: string | null; name?: string | null }): string {
  return `/projects/${projectRouteRef(project)}`;
}

/** Build a URL to a specific workspace within a project. */
export function projectWorkspaceUrl(
  project: { id: string; urlKey?: string | null; name?: string | null },
  workspaceId: string,
): string {
  return `/projects/${projectRouteRef(project)}/workspaces/${workspaceId}`;
}

/** Display name for a billing type (e.g. "per_token" → "Per Token"). */
export function billingTypeDisplayName(type: string): string {
  const map: Record<string, string> = {
    per_token: "Per Token",
    per_request: "Per Request",
    per_minute: "Per Minute",
    per_image: "Per Image",
    flat: "Flat Rate",
  };
  return map[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Display name for a finance direction (e.g. "inbound" → "Inbound"). */
export function financeDirectionDisplayName(direction: string): string {
  const map: Record<string, string> = {
    inbound: "Inbound",
    outbound: "Outbound",
    internal: "Internal",
  };
  return map[direction] ?? direction.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Display name for a finance event kind. */
export function financeEventKindDisplayName(kind: string): string {
  const map: Record<string, string> = {
    llm_inference: "LLM Inference",
    tool_call: "Tool Call",
    embedding: "Embedding",
    image_generation: "Image Generation",
    transcription: "Transcription",
    search: "Search",
    storage: "Storage",
    compute: "Compute",
    api_call: "API Call",
  };
  return map[kind] ?? kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Display name for a provider (e.g. "anthropic" → "Anthropic"). */
export function providerDisplayName(provider: string): string {
  const map: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    gemini: "Gemini",
    cohere: "Cohere",
    mistral: "Mistral",
    groq: "Groq",
    fireworks: "Fireworks",
    together: "Together",
    deepseek: "DeepSeek",
    aws_bedrock: "AWS Bedrock",
    azure_openai: "Azure OpenAI",
    local: "Local",
  };
  return map[provider] ?? provider.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Display name for a quota source. */
export function quotaSourceDisplayName(source: string): string {
  const map: Record<string, string> = {
    provider: "Provider",
    budget_policy: "Budget Policy",
    plan: "Plan",
    manual: "Manual",
    system: "System",
  };
  return map[source] ?? source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
