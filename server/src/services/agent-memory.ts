import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agentMemory, agentTranscripts } from "@combyne/db";
import { logger } from "../middleware/logger.js";

export type MemoryScope = "agent" | "company" | "issue";
export type MemoryKind = "summary" | "fact" | "preference" | "artifact_ref";

export interface UpsertMemoryInput {
  companyId: string;
  agentId?: string | null;
  issueId?: string | null;
  sourceRunId?: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  title?: string | null;
  body: string;
}

export async function upsertMemory(db: Db, input: UpsertMemoryInput) {
  await db.insert(agentMemory).values({
    companyId: input.companyId,
    agentId: input.agentId ?? null,
    issueId: input.issueId ?? null,
    sourceRunId: input.sourceRunId ?? null,
    scope: input.scope,
    kind: input.kind,
    title: input.title ?? null,
    body: input.body,
  });
}

export interface LoadMemoryOptions {
  companyId: string;
  agentId?: string | null;
  issueId?: string | null;
  scope?: MemoryScope;
  limit?: number;
}

export async function loadRecentMemory(db: Db, opts: LoadMemoryOptions) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const filters = [eq(agentMemory.companyId, opts.companyId)];
  if (opts.agentId) filters.push(eq(agentMemory.agentId, opts.agentId));
  if (opts.issueId) filters.push(eq(agentMemory.issueId, opts.issueId));
  if (opts.scope) filters.push(eq(agentMemory.scope, opts.scope));
  const rows = await db
    .select()
    .from(agentMemory)
    .where(and(...filters))
    .orderBy(desc(agentMemory.updatedAt))
    .limit(limit);
  return rows;
}

const DEFAULT_MIN_TRANSCRIPT_ENTRIES = 3;

export interface SummarizeRunOptions {
  runId: string;
  companyId: string;
  agentId: string;
  issueId?: string | null;
  minEntries?: number;
}

/**
 * Read the run's transcript and compress it into a rolling summary.
 * Deterministic + cheap: we pull the last N assistant/user/tool turns,
 * strip payload noise, and emit two rows (per-issue + per-agent).
 *
 * Designed to be hot-swappable with an LLM summarizer later — signature
 * stays the same, only the body construction changes.
 */
export async function summarizeRunAndPersist(db: Db, opts: SummarizeRunOptions) {
  const minEntries = opts.minEntries ?? DEFAULT_MIN_TRANSCRIPT_ENTRIES;
  try {
    const entries = await db
      .select()
      .from(agentTranscripts)
      .where(eq(agentTranscripts.runId, opts.runId));

    if (entries.length < minEntries) return;

    const sorted = entries.sort((a, b) => a.seq - b.seq);
    const tail = sorted.slice(-60);

    const bulletLines: string[] = [];
    const seenMessages = new Set<string>();
    let assistantTurns = 0;
    let toolCalls = 0;
    let stderrLines = 0;

    for (const entry of tail) {
      const content = (entry.content ?? {}) as Record<string, unknown>;
      const message = typeof content.message === "string" ? content.message.trim() : "";
      if (entry.role === "assistant") assistantTurns++;
      if (entry.role === "tool_call") toolCalls++;
      if (entry.role === "stderr") stderrLines++;
      if (!message) continue;
      const dedupeKey = `${entry.role}:${message.slice(0, 120)}`;
      if (seenMessages.has(dedupeKey)) continue;
      seenMessages.add(dedupeKey);
      bulletLines.push(
        `- [${entry.role}] ${message.length > 280 ? `${message.slice(0, 280)}…` : message}`,
      );
      if (bulletLines.length >= 20) break;
    }

    const summaryBody = [
      `Run ${opts.runId} — ${sorted.length} transcript entries, ${assistantTurns} assistant turns, ${toolCalls} tool calls, ${stderrLines} stderr lines.`,
      bulletLines.length > 0 ? "Highlights:" : null,
      ...bulletLines,
    ]
      .filter(Boolean)
      .join("\n");

    if (opts.issueId) {
      await upsertMemory(db, {
        companyId: opts.companyId,
        agentId: opts.agentId,
        issueId: opts.issueId,
        sourceRunId: opts.runId,
        scope: "issue",
        kind: "summary",
        title: `Run summary (${new Date().toISOString().slice(0, 19)}Z)`,
        body: summaryBody,
      });
    }

    await upsertMemory(db, {
      companyId: opts.companyId,
      agentId: opts.agentId,
      sourceRunId: opts.runId,
      scope: "agent",
      kind: "summary",
      title: `Agent run summary (${new Date().toISOString().slice(0, 19)}Z)`,
      body: summaryBody,
    });
  } catch (err) {
    logger.warn({ err, runId: opts.runId }, "agent memory summarizer failed");
  }
}

export interface SummarizeTerminalSessionOptions {
  terminalSessionId: string;
  companyId: string;
  agentId: string;
  issueId?: string | null;
  minEntries?: number;
}

/**
 * Mirror of summarizeRunAndPersist for interactive terminal sessions. Called
 * from closeSession so that anything the user discussed in the REPL rolls
 * into agent_memory — otherwise the next heartbeat wake would see an empty
 * memory preamble for work that happened seconds ago in the terminal.
 *
 * Kept as a separate entry point so run-level and terminal-level summaries
 * remain distinguishable by sourceRunId (null for terminal) + title prefix.
 */
export async function summarizeTerminalSessionAndPersist(
  db: Db,
  opts: SummarizeTerminalSessionOptions,
) {
  const minEntries = opts.minEntries ?? DEFAULT_MIN_TRANSCRIPT_ENTRIES;
  try {
    const entries = await db
      .select()
      .from(agentTranscripts)
      .where(eq(agentTranscripts.terminalSessionId, opts.terminalSessionId));

    if (entries.length < minEntries) return;

    const sorted = entries.sort((a, b) => a.seq - b.seq);
    const tail = sorted.slice(-60);

    const bulletLines: string[] = [];
    const seenMessages = new Set<string>();
    let assistantTurns = 0;
    let userTurns = 0;
    for (const entry of tail) {
      const content = (entry.content ?? {}) as Record<string, unknown>;
      const message = typeof content.message === "string" ? content.message.trim() : "";
      if (entry.role === "assistant") assistantTurns++;
      if (entry.role === "user") userTurns++;
      if (!message) continue;
      const dedupeKey = `${entry.role}:${message.slice(0, 120)}`;
      if (seenMessages.has(dedupeKey)) continue;
      seenMessages.add(dedupeKey);
      bulletLines.push(
        `- [${entry.role}] ${message.length > 280 ? `${message.slice(0, 280)}…` : message}`,
      );
      if (bulletLines.length >= 20) break;
    }

    const summaryBody = [
      `Terminal session ${opts.terminalSessionId} — ${sorted.length} transcript entries, ${userTurns} user prompts, ${assistantTurns} assistant output flushes.`,
      bulletLines.length > 0 ? "Highlights:" : null,
      ...bulletLines,
    ]
      .filter(Boolean)
      .join("\n");

    if (opts.issueId) {
      await upsertMemory(db, {
        companyId: opts.companyId,
        agentId: opts.agentId,
        issueId: opts.issueId,
        scope: "issue",
        kind: "summary",
        title: `Terminal session summary (${new Date().toISOString().slice(0, 19)}Z)`,
        body: summaryBody,
      });
    }

    await upsertMemory(db, {
      companyId: opts.companyId,
      agentId: opts.agentId,
      scope: "agent",
      kind: "summary",
      title: `Agent terminal session summary (${new Date().toISOString().slice(0, 19)}Z)`,
      body: summaryBody,
    });
  } catch (err) {
    logger.warn(
      { err, terminalSessionId: opts.terminalSessionId },
      "agent memory terminal-session summarizer failed",
    );
  }
}
