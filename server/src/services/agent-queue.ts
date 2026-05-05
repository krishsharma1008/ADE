import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { issues } from "@combyne/db";
import { OPEN_ISSUE_STATUSES } from "@combyne/shared";

export interface AssignedIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  awaitingUserSince: string | null;
  awaiting: boolean;
  isCurrent: boolean;
  updatedAt: string | null;
}

export interface AssignedQueueResult {
  items: AssignedIssueSummary[];
  totalOpen: number;
  awaitingCount: number;
  body: string;
  focusBody: string;
  digestBody: string;
  directive: string | null;
  focusItem: AssignedIssueSummary | null;
  currentIssueMissing: boolean;
}

const OPEN_STATUSES = OPEN_ISSUE_STATUSES;
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const FOCUS_DIRECTIVE =
  "Respond only to the current focus issue. Other items below are context for " +
  "awareness only — do not work on them unless explicitly reassigned.";

export interface LoadAssignedQueueOptions {
  companyId: string;
  agentId: string;
  currentIssueId?: string | null;
  currentIssueBody?: string | null;
  limit?: number;
  focusMode?: boolean;
  includeReviewIssues?: boolean;
}

const FOCUS_BODY_TRUNCATE = 512;
const FOCUSED_TIMER_STATUSES = ["todo", "in_progress", "in_review"] as const;

function renderDigestLine(item: AssignedIssueSummary): string {
  const ident = item.identifier ? `${item.identifier} — ` : "";
  const markers: string[] = [];
  if (item.awaiting) markers.push("awaiting user");
  if (item.priority === "urgent" || item.priority === "critical" || item.priority === "high") {
    markers.push(item.priority);
  }
  const tail = markers.length > 0 ? ` _(${markers.join(", ")})_` : "";
  return `- [${item.status}] ${ident}${item.title}${tail}`;
}

function renderFocusSection(
  item: AssignedIssueSummary,
  body: string | null,
  directive: string,
): string {
  const ident = item.identifier ? `${item.identifier} — ` : "";
  const lines: string[] = [];
  lines.push(`## 🎯 Current focus: ${ident}${item.title}`);
  lines.push(`> ${directive}`);
  lines.push("");
  lines.push(`- Status: \`${item.status}\``);
  lines.push(`- Priority: \`${item.priority}\``);
  if (item.awaiting) lines.push("- Awaiting user");
  if (item.updatedAt) lines.push(`- Updated: ${item.updatedAt}`);
  if (body) {
    const trimmed = body.trim();
    if (trimmed.length > 0) {
      const capped =
        trimmed.length > FOCUS_BODY_TRUNCATE
          ? `${trimmed.slice(0, FOCUS_BODY_TRUNCATE)}…`
          : trimmed;
      lines.push("");
      lines.push("Issue description:");
      lines.push(capped);
    }
  }
  return lines.join("\n");
}

export async function loadAssignedIssueQueue(
  db: Db,
  opts: LoadAssignedQueueOptions,
): Promise<AssignedQueueResult> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const focusMode = opts.focusMode ?? true;
  const statuses = opts.includeReviewIssues === false
    ? OPEN_STATUSES.filter((status) => status !== "in_review")
    : OPEN_STATUSES;
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      awaitingUserSince: issues.awaitingUserSince,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, opts.companyId),
        eq(issues.assigneeAgentId, opts.agentId),
        inArray(issues.status, statuses as unknown as string[]),
      ),
    )
    .orderBy(asc(issues.priority), asc(issues.createdAt))
    .limit(limit + 1);

  const currentId = opts.currentIssueId ?? null;
  const sorted = [...rows].sort((a, b) => {
    if (currentId && a.id === currentId && b.id !== currentId) return -1;
    if (currentId && b.id === currentId && a.id !== currentId) return 1;
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    if (a.status === "awaiting_user" && b.status !== "awaiting_user") return -1;
    if (b.status === "awaiting_user" && a.status !== "awaiting_user") return 1;
    const ua = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const ub = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return ub - ua;
  });

  const items: AssignedIssueSummary[] = sorted.slice(0, limit).map((row) => ({
    id: row.id,
    identifier: row.identifier ?? null,
    title: row.title,
    status: row.status,
    priority: row.priority,
    awaitingUserSince: row.awaitingUserSince
      ? new Date(row.awaitingUserSince).toISOString()
      : null,
    awaiting: row.status === "awaiting_user",
    isCurrent: Boolean(currentId && row.id === currentId),
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  }));

  const awaitingCount = items.filter((i) => i.awaiting).length;

  const focusItem = currentId ? items.find((i) => i.id === currentId) ?? null : null;
  const currentIssueMissing = Boolean(currentId) && focusItem === null;
  const otherItems = focusItem ? items.filter((i) => i.id !== focusItem.id) : items;

  // Focus block — only present when focusMode is on AND a real focus issue resolved.
  let focusBody = "";
  let directive: string | null = null;
  if (focusMode && focusItem) {
    directive = FOCUS_DIRECTIVE;
    focusBody = renderFocusSection(focusItem, opts.currentIssueBody ?? null, directive);
  }

  // Digest block — one line per other open issue (labelled only when focus is on).
  const digestLines: string[] = [];
  if (otherItems.length === 0 && !focusItem) {
    digestLines.push("_No open issues assigned to you right now._");
  } else if (otherItems.length > 0) {
    if (focusMode && focusItem) {
      digestLines.push(
        "## Other open issues (do not work on these unless explicitly reassigned)",
      );
    }
    for (const item of otherItems) {
      digestLines.push(renderDigestLine(item));
    }
  }
  let digestBody = digestLines.join("\n");

  const MAX_DIGEST_BYTES = 8_000;
  if (digestBody.length > MAX_DIGEST_BYTES) {
    digestBody = `${digestBody.slice(0, MAX_DIGEST_BYTES)}\n…(truncated)`;
  }

  // Backward-compatible combined body: focus-first when present, otherwise digest.
  // Existing consumers that read `body` keep working; new consumers prefer
  // `focusBody`/`digestBody` explicitly and handle the ordering themselves.
  let body = "";
  if (focusBody && digestBody) {
    body = `${focusBody}\n\n${digestBody}`;
  } else if (focusBody) {
    body = focusBody;
  } else {
    body = digestBody;
  }

  return {
    items,
    totalOpen: rows.length > limit ? limit : rows.length,
    awaitingCount,
    body,
    focusBody,
    digestBody,
    directive,
    focusItem,
    currentIssueMissing,
  };
}

export async function loadNextFocusedIssue(
  db: Db,
  opts: { companyId: string; agentId: string },
): Promise<AssignedIssueSummary | null> {
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      awaitingUserSince: issues.awaitingUserSince,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, opts.companyId),
        eq(issues.assigneeAgentId, opts.agentId),
        inArray(issues.status, FOCUSED_TIMER_STATUSES as unknown as string[]),
      ),
    )
    .orderBy(asc(issues.priority), asc(issues.createdAt))
    .limit(100);

  const sorted = [...rows].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    const ua = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const ub = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return ub - ua;
  });

  const row = sorted[0];
  if (!row) return null;
  return {
    id: row.id,
    identifier: row.identifier ?? null,
    title: row.title,
    status: row.status,
    priority: row.priority,
    awaitingUserSince: row.awaitingUserSince
      ? new Date(row.awaitingUserSince).toISOString()
      : null,
    awaiting: row.status === "awaiting_user",
    isCurrent: true,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export const __internals = {
  OPEN_STATUSES,
  PRIORITY_ORDER,
  FOCUS_DIRECTIVE,
  FOCUSED_TIMER_STATUSES,
};
