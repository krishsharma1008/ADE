import { ISSUE_COMPLEXITIES, type IssueComplexity } from "@combyne/shared";

type LabelLike = { name?: string | null } | string | null | undefined;

const COMPLEXITY_SET = new Set<string>(ISSUE_COMPLEXITIES);

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[\[#(]+|[\])#:]+$/g, "")
    .trim();
}

export function normalizeIssueComplexity(value: unknown): IssueComplexity | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeToken(value);
  return COMPLEXITY_SET.has(normalized) ? (normalized as IssueComplexity) : null;
}

function complexityFromLabel(label: LabelLike): IssueComplexity | null {
  const name = typeof label === "string" ? label : label?.name;
  const normalized = normalizeToken(name);
  if (normalized === "s" || normalized === "small") return "small";
  if (normalized === "m" || normalized === "medium") return "medium";
  if (normalized === "l" || normalized === "large") return "large";
  if (normalized === "complexity:s" || normalized === "complexity-small") return "small";
  if (normalized === "complexity:m" || normalized === "complexity-medium") return "medium";
  if (normalized === "complexity:l" || normalized === "complexity-large") return "large";
  return null;
}

function complexityFromTitle(title: string | null | undefined): IssueComplexity | null {
  const value = (title ?? "").trim();
  if (!value) return null;
  const match = value.match(/^(?:\[(s|m|l|small|medium|large)\]|\((s|m|l|small|medium|large)\)|(s|m|l|small|medium|large)\s*[:\-])/i);
  const token = match?.slice(1).find(Boolean);
  if (!token) return null;
  const normalized = normalizeToken(token);
  if (normalized === "s" || normalized === "small") return "small";
  if (normalized === "m" || normalized === "medium") return "medium";
  if (normalized === "l" || normalized === "large") return "large";
  return null;
}

export function resolveIssueComplexity(input: {
  complexity?: unknown;
  title?: string | null;
  labels?: LabelLike[];
}): IssueComplexity {
  const explicit = normalizeIssueComplexity(input.complexity);
  if (explicit) return explicit;

  for (const label of input.labels ?? []) {
    const fromLabel = complexityFromLabel(label);
    if (fromLabel) return fromLabel;
  }

  return complexityFromTitle(input.title) ?? "medium";
}

