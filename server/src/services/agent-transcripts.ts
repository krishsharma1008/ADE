import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agentTranscripts, heartbeatRuns } from "@combyne/db";

export type TranscriptRole =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "stderr"
  | "lifecycle";

export interface AppendTranscriptInput {
  companyId: string;
  agentId: string;
  runId?: string | null;
  issueId?: string | null;
  terminalSessionId?: string | null;
  seq: number;
  role: TranscriptRole;
  contentKind?: string | null;
  content: Record<string, unknown>;
}

export async function appendTranscriptEntry(db: Db, input: AppendTranscriptInput) {
  await db.insert(agentTranscripts).values({
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId ?? null,
    issueId: input.issueId ?? null,
    terminalSessionId: input.terminalSessionId ?? null,
    seq: input.seq,
    role: input.role,
    contentKind: input.contentKind ?? null,
    content: input.content,
  });
}

export interface LatestTranscriptOptions {
  agentId: string;
  companyId: string;
  issueId?: string | null;
  limit?: number;
}

export async function loadRecentTranscript(db: Db, opts: LatestTranscriptOptions) {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const filters = [
    eq(agentTranscripts.companyId, opts.companyId),
    eq(agentTranscripts.agentId, opts.agentId),
  ];
  if (opts.issueId) filters.push(eq(agentTranscripts.issueId, opts.issueId));
  const rows = await db
    .select()
    .from(agentTranscripts)
    .where(and(...filters))
    .orderBy(desc(agentTranscripts.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function loadRunTranscript(db: Db, runId: string) {
  return db
    .select()
    .from(agentTranscripts)
    .where(eq(agentTranscripts.runId, runId))
    .orderBy(asc(agentTranscripts.seq));
}

export async function loadTerminalSessionTranscript(db: Db, terminalSessionId: string) {
  return db
    .select()
    .from(agentTranscripts)
    .where(eq(agentTranscripts.terminalSessionId, terminalSessionId))
    .orderBy(asc(agentTranscripts.seq));
}

// -----------------------------------------------------------------------------
// Round 3 Phase 6 PR 6.1 — durable cursor reads.
//
// `seq` resets per run and per terminal session, so it cannot drive "everything
// the summarizer hasn't seen yet". Migration 0039 added a global `ordinal`
// column that is monotonic per-row across the whole table. All summarization
// cursor math uses `ordinal`.
// -----------------------------------------------------------------------------

export interface LoadTranscriptSinceOptions {
  companyId: string;
  agentId: string;
  // When set, restricts results to entries bound to this issue, plus any
  // untagged entries from runs that were bound to this issue (Codex §0.4).
  // When null/undefined, returns every entry for the agent since the cursor.
  issueId?: string | null;
  // Strict `>` comparison. Pass the latest summary's cutoff_seq, or `null` for
  // "from the beginning".
  sinceOrdinal?: number | null;
  // Caps; loader returns up to maxRows and tells you whether more remain.
  maxRows?: number;
  // Drop rows whose contentKind is in this list. Used to exclude the heavy
  // adapter.invoke/adapter.result payloads from token counting.
  excludeContentKinds?: string[];
}

export interface LoadedTranscriptEntry {
  id: string;
  ordinal: number;
  seq: number;
  runId: string | null;
  issueId: string | null;
  terminalSessionId: string | null;
  role: string;
  contentKind: string | null;
  content: Record<string, unknown>;
  createdAt: Date;
}

export interface LoadedTranscript {
  entries: LoadedTranscriptEntry[];
  totalCount: number;
  hasMore: boolean;
  maxOrdinalSeen: number | null;
}

const DEFAULT_MAX_ROWS = 200;
const HARD_CAP_ROWS = 1_000;

function orNull<T>(v: T | null | undefined): T | null {
  return v === undefined || v === null ? null : v;
}

export async function loadTranscriptSince(
  db: Db,
  opts: LoadTranscriptSinceOptions,
): Promise<LoadedTranscript> {
  const maxRows = Math.min(Math.max(opts.maxRows ?? DEFAULT_MAX_ROWS, 1), HARD_CAP_ROWS);

  const baseWhere = [
    eq(agentTranscripts.companyId, opts.companyId),
    eq(agentTranscripts.agentId, opts.agentId),
  ];
  if (opts.sinceOrdinal != null) {
    baseWhere.push(gt(agentTranscripts.ordinal, opts.sinceOrdinal));
  }

  // Issue filter (Codex §0.4): when scoped to an issue, include untagged rows
  // whose runId belonged to a run that was bound to this issue via its
  // contextSnapshot. heartbeat_runs doesn't carry issueId as a column — the
  // snapshot is the source of truth.
  if (opts.issueId) {
    const issueId = opts.issueId;
    const boundRunExists = sql<boolean>`exists (
      select 1 from ${heartbeatRuns} hr
       where hr.id = ${agentTranscripts.runId}
         and (hr.context_snapshot ->> 'issueId') = ${issueId}
    )`;
    baseWhere.push(
      or(
        eq(agentTranscripts.issueId, issueId),
        and(isNull(agentTranscripts.issueId), boundRunExists),
      )!,
    );
  }

  // Fetch maxRows + 1 to detect overflow.
  const rows = await db
    .select()
    .from(agentTranscripts)
    .where(and(...baseWhere))
    .orderBy(asc(agentTranscripts.ordinal))
    .limit(maxRows + 1);

  const hasMore = rows.length > maxRows;
  const kept = hasMore ? rows.slice(0, maxRows) : rows;

  const excludeKinds = new Set(opts.excludeContentKinds ?? []);
  const filtered = excludeKinds.size
    ? kept.filter((r) => !r.contentKind || !excludeKinds.has(r.contentKind))
    : kept;

  return {
    entries: filtered.map((r) => ({
      id: r.id,
      ordinal: Number(r.ordinal),
      seq: r.seq,
      runId: orNull(r.runId),
      issueId: orNull(r.issueId),
      terminalSessionId: orNull(r.terminalSessionId),
      role: r.role,
      contentKind: orNull(r.contentKind),
      content: r.content,
      createdAt: r.createdAt,
    })),
    totalCount: filtered.length,
    hasMore,
    maxOrdinalSeen: kept.length > 0 ? Number(kept[kept.length - 1].ordinal) : null,
  };
}

// -----------------------------------------------------------------------------
// Counting contract for summarizer triggers (Codex §0.6).
//
// The summarizer trigger asks "how many tokens of un-summarized transcript
// does this scope have". Counts only `content` JSON for user-facing roles,
// excluding the heavy adapter.invoke / adapter.result envelopes.
// -----------------------------------------------------------------------------

export const COUNTABLE_ROLES: ReadonlyArray<string> = [
  "user",
  "assistant",
  "tool_result",
  "system",
];

export const EXCLUDED_CONTENT_KINDS: ReadonlyArray<string> = [
  "adapter.invoke",
  "adapter.result",
  "bootstrap_preamble",
  "handoff_brief",
];

export function extractCountableText(entry: LoadedTranscriptEntry): string {
  if (!COUNTABLE_ROLES.includes(entry.role)) return "";
  if (entry.contentKind && EXCLUDED_CONTENT_KINDS.includes(entry.contentKind)) return "";
  try {
    return JSON.stringify(entry.content);
  } catch {
    return "";
  }
}
