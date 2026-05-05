import fs from "node:fs/promises";
import path from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { issueContextRefs } from "@combyne/db";

const MAX_REFS_PER_TEXT = 12;
const ABS_PATH_RE = /(?:^|[\s(["'`])((?:\/[^\s"'`)<>{}|]+)+(?:\.[A-Za-z0-9]{1,12})?)/g;
const URL_RE = /\bhttps?:\/\/[^\s"'`)<>{}|]+/g;
const FILE_EXT_RE = /\.(?:pdf|csv|xlsx?|docx?|txt|md|json|yaml|yml|png|jpe?g)$/i;

export interface ExtractIssueContextRefsInput {
  companyId: string;
  issueId: string;
  text: string | null | undefined;
  sourceCommentId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

function normalizeRef(ref: string) {
  return ref.trim().replace(/[),.;:]+$/g, "");
}

function inferKind(rawRef: string): "path" | "url" | "external" {
  if (/^https?:\/\//i.test(rawRef)) return "url";
  if (path.isAbsolute(rawRef)) return "path";
  return "external";
}

function inferLabel(rawRef: string) {
  if (/docs\.google\.com\/spreadsheets/i.test(rawRef)) return "Google Sheet";
  if (/atlassian|jira/i.test(rawRef)) return "Jira";
  if (path.isAbsolute(rawRef)) return path.basename(rawRef) || "Local file";
  return null;
}

async function accessibilityFor(rawRef: string) {
  if (!path.isAbsolute(rawRef)) return "unknown" as const;
  try {
    await fs.access(rawRef);
    return "accessible" as const;
  } catch {
    return "missing" as const;
  }
}

export function extractContextRefCandidates(text: string | null | undefined): string[] {
  if (!text) return [];
  const refs: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string) => {
    const normalized = normalizeRef(candidate);
    if (!normalized || seen.has(normalized)) return;
    if (path.isAbsolute(normalized) || /^https?:\/\//i.test(normalized) || FILE_EXT_RE.test(normalized)) {
      seen.add(normalized);
      refs.push(normalized);
    }
  };

  let match: RegExpExecArray | null;
  while ((match = ABS_PATH_RE.exec(text))) push(match[1] ?? "");
  while ((match = URL_RE.exec(text))) push(match[0] ?? "");
  return refs.slice(0, MAX_REFS_PER_TEXT);
}

export async function captureIssueContextRefs(db: Db, input: ExtractIssueContextRefsInput) {
  const candidates = extractContextRefCandidates(input.text);
  if (candidates.length === 0) return [];

  const values = [];
  for (const rawRef of candidates) {
    const kind = inferKind(rawRef);
    const accessibilityStatus = await accessibilityFor(rawRef);
    values.push({
      companyId: input.companyId,
      issueId: input.issueId,
      sourceCommentId: input.sourceCommentId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      kind,
      label: inferLabel(rawRef),
      rawRef,
      resolvedRef: kind === "path" ? path.resolve(rawRef) : rawRef,
      accessibilityStatus,
      metadata: null,
      updatedAt: new Date(),
    });
  }

  return db
    .insert(issueContextRefs)
    .values(values)
    .onConflictDoUpdate({
      target: [issueContextRefs.companyId, issueContextRefs.issueId, issueContextRefs.rawRef],
      set: {
        sourceCommentId: sql`excluded.source_comment_id`,
        accessibilityStatus: sql`excluded.accessibility_status`,
        resolvedRef: sql`excluded.resolved_ref`,
        label: sql`excluded.label`,
        updatedAt: new Date(),
      },
    })
    .returning();
}

export async function loadIssueContextRefs(db: Db, issueId: string) {
  return db
    .select()
    .from(issueContextRefs)
    .where(eq(issueContextRefs.issueId, issueId))
    .orderBy(desc(issueContextRefs.updatedAt));
}

export function renderIssueContextRefs(refs: Awaited<ReturnType<typeof loadIssueContextRefs>>) {
  if (refs.length === 0) return "";
  const lines = ["## Issue context references"];
  lines.push("Use these same-issue references before asking the user to repeat paths or exports.");
  for (const ref of refs.slice(0, 12)) {
    const label = ref.label ? `${ref.label}: ` : "";
    const status =
      ref.accessibilityStatus === "accessible"
        ? "accessible"
        : ref.accessibilityStatus === "missing"
          ? "not accessible from this worker"
          : "access unknown";
    lines.push(`- ${label}\`${ref.rawRef}\` (${status})`);
  }
  return lines.join("\n");
}
