import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agentHandoffs, agents, issueComments, issues } from "@combyne/db";
import { logger } from "../middleware/logger.js";
import { loadRecentMemory } from "./agent-memory.js";
import { loadRecentTranscript } from "./agent-transcripts.js";

export interface CreateHandoffInput {
  companyId: string;
  issueId: string;
  fromAgentId?: string | null;
  toAgentId: string;
  fromRunId?: string | null;
  openQuestions?: string[];
}

interface BuildBriefInput {
  companyId: string;
  issueId: string;
  fromAgentId: string | null;
  toAgentId: string;
}

async function buildBriefMarkdown(db: Db, input: BuildBriefInput): Promise<{
  brief: string;
  openQuestions: string[];
}> {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .limit(1);

  const [fromAgentRow, toAgentRow] = await Promise.all([
    input.fromAgentId
      ? db.select().from(agents).where(eq(agents.id, input.fromAgentId)).limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db.select().from(agents).where(eq(agents.id, input.toAgentId)).limit(1).then((r) => r[0] ?? null),
  ]);

  const recentComments = await db
    .select({
      createdAt: issueComments.createdAt,
      body: issueComments.body,
      authorUserId: issueComments.authorUserId,
      authorAgentId: issueComments.authorAgentId,
    })
    .from(issueComments)
    .where(and(eq(issueComments.issueId, input.issueId), eq(issueComments.companyId, input.companyId)))
    .orderBy(desc(issueComments.createdAt))
    .limit(6);

  const memory = input.fromAgentId
    ? await loadRecentMemory(db, {
        companyId: input.companyId,
        agentId: input.fromAgentId,
        issueId: input.issueId,
        limit: 5,
      })
    : [];

  const transcript = input.fromAgentId
    ? await loadRecentTranscript(db, {
        companyId: input.companyId,
        agentId: input.fromAgentId,
        issueId: input.issueId,
        limit: 15,
      })
    : [];

  const fromLabel = fromAgentRow
    ? `${fromAgentRow.name} (${fromAgentRow.adapterType})`
    : "(unknown)";
  const toLabel = toAgentRow ? `${toAgentRow.name} (${toAgentRow.adapterType})` : "(unknown)";

  const lines: string[] = [];
  lines.push(`# Handoff — Issue ${issue?.identifier ?? input.issueId}`);
  lines.push(`From: ${fromLabel} → To: ${toLabel}`);
  if (issue) {
    lines.push("");
    lines.push(`## Issue`);
    lines.push(`**${issue.title}**`);
    if (issue.description) {
      lines.push("");
      lines.push(issue.description);
    }
  }

  const openQuestions: string[] = [];
  if (memory.length > 0) {
    lines.push("");
    lines.push("## What I've done so far");
    for (const row of memory) {
      const title = row.title ? ` — ${row.title}` : "";
      lines.push(`- (${row.kind}${title}) ${row.body.split("\n")[0]?.slice(0, 300) ?? ""}`);
      if (row.kind === "summary") {
        const qLines = row.body
          .split("\n")
          .filter((line) => /open question/i.test(line) || line.trim().startsWith("?"));
        for (const q of qLines) openQuestions.push(q.replace(/^[-*]\s*/, "").trim());
      }
    }
  }

  if (transcript.length > 0) {
    lines.push("");
    lines.push("## Recent turns");
    for (const entry of transcript.slice(-10)) {
      const content = (entry.content ?? {}) as Record<string, unknown>;
      const message = typeof content.message === "string" ? content.message.trim() : "";
      if (!message) continue;
      lines.push(`- [${entry.role}] ${message.length > 240 ? `${message.slice(0, 240)}…` : message}`);
    }
  }

  if (recentComments.length > 0) {
    lines.push("");
    lines.push("## Recent comments");
    for (const comment of recentComments.slice().reverse()) {
      const author = comment.authorAgentId
        ? `agent:${comment.authorAgentId.slice(0, 8)}`
        : comment.authorUserId
          ? `user:${comment.authorUserId.slice(0, 8)}`
          : "system";
      const snippet = (comment.body ?? "").slice(0, 400);
      lines.push(`- ${author}: ${snippet}`);
    }
  }

  if (openQuestions.length > 0) {
    lines.push("");
    lines.push("## Open questions");
    for (const q of openQuestions.slice(0, 8)) lines.push(`- ${q}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("_This brief was generated on handoff. Continue the work where the previous agent left off._");

  return { brief: lines.join("\n"), openQuestions };
}

export async function createHandoff(db: Db, input: CreateHandoffInput) {
  try {
    const { brief, openQuestions } = await buildBriefMarkdown(db, {
      companyId: input.companyId,
      issueId: input.issueId,
      fromAgentId: input.fromAgentId ?? null,
      toAgentId: input.toAgentId,
    });

    const [row] = await db
      .insert(agentHandoffs)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        fromAgentId: input.fromAgentId ?? null,
        toAgentId: input.toAgentId,
        fromRunId: input.fromRunId ?? null,
        brief,
        openQuestions: input.openQuestions ?? openQuestions,
        artifactRefs: [],
      })
      .returning();
    return row ?? null;
  } catch (err) {
    logger.warn({ err, issueId: input.issueId }, "createHandoff failed");
    return null;
  }
}

export async function getPendingHandoffBrief(
  db: Db,
  toAgentId: string,
  issueId: string | null,
) {
  const filters = [eq(agentHandoffs.toAgentId, toAgentId), isNull(agentHandoffs.consumedAt)];
  if (issueId) filters.push(eq(agentHandoffs.issueId, issueId));
  const rows = await db
    .select()
    .from(agentHandoffs)
    .where(and(...filters))
    .orderBy(desc(agentHandoffs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function markHandoffConsumed(db: Db, handoffId: string) {
  await db
    .update(agentHandoffs)
    .set({ consumedAt: new Date() })
    .where(eq(agentHandoffs.id, handoffId));
}
