import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agentTranscripts } from "@combyne/db";

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
