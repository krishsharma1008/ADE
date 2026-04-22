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
}

// Canonical "open" statuses come from @combyne/shared. Prior to Round 3 this
// file hard-coded a list that (a) invented a `review` status that never
// existed and (b) silently excluded `todo`, so todo/in_review issues never
// surfaced in the queue preamble. Keeping a local alias for test introspection.
const OPEN_STATUSES = OPEN_ISSUE_STATUSES;
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface LoadAssignedQueueOptions {
  companyId: string;
  agentId: string;
  currentIssueId?: string | null;
  limit?: number;
}

export async function loadAssignedIssueQueue(
  db: Db,
  opts: LoadAssignedQueueOptions,
): Promise<AssignedQueueResult> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
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
        inArray(issues.status, OPEN_STATUSES as unknown as string[]),
      ),
    )
    .orderBy(asc(issues.priority), asc(issues.createdAt))
    .limit(limit + 1);

  const currentId = opts.currentIssueId ?? null;
  const sorted = [...rows].sort((a, b) => {
    // Currently-woken issue first, then priority, then awaiting_user, then recency.
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
    awaitingUserSince: row.awaitingUserSince ? new Date(row.awaitingUserSince).toISOString() : null,
    awaiting: row.status === "awaiting_user",
    isCurrent: Boolean(currentId && row.id === currentId),
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  }));

  const awaitingCount = items.filter((i) => i.awaiting).length;

  const lines: string[] = [];
  if (items.length === 0) {
    lines.push("_No open issues assigned to you right now._");
  } else {
    for (const item of items) {
      const ident = item.identifier ? `${item.identifier} — ` : "";
      const markers: string[] = [];
      if (item.isCurrent) markers.push("**current**");
      if (item.awaiting) markers.push("awaiting user");
      if (item.priority === "urgent" || item.priority === "high") markers.push(item.priority);
      const tail = markers.length > 0 ? ` _(${markers.join(", ")})_` : "";
      lines.push(`- [${item.status}] ${ident}${item.title}${tail}`);
    }
  }

  // Keep body bounded so it can't bloat the prompt on agents with huge backlogs.
  const MAX_BODY_BYTES = 8_000;
  let body = lines.join("\n");
  if (body.length > MAX_BODY_BYTES) {
    body = `${body.slice(0, MAX_BODY_BYTES)}\n…(truncated)`;
  }

  return {
    items,
    totalOpen: rows.length > limit ? limit : rows.length,
    awaitingCount,
    body,
  };
}

// Exposed for testing so we don't accidentally accept "done"/"cancelled" into
// the live queue if the constants change.
export const __internals = {
  OPEN_STATUSES,
  PRIORITY_ORDER,
};
