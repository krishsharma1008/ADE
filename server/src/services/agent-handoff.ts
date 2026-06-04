import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@combyne/db";
import type { IssueComplexity } from "@combyne/shared";
import { agentHandoffs, agents, issueComments, issues } from "@combyne/db";
import { logger } from "../middleware/logger.js";
import { loadRecentMemory } from "./agent-memory.js";
import { loadRecentTranscript } from "./agent-transcripts.js";
import { passdownService, type PassdownPacket } from "./em-passdown.js";

export interface CreateHandoffInput {
  companyId: string;
  issueId: string;
  fromAgentId?: string | null;
  toAgentId: string;
  fromRunId?: string | null;
  openQuestions?: string[];
  /** PR-9: ticket complexity tier driving the passdown packet size budget. */
  complexity?: IssueComplexity | null;
  /** PR-9: explicit retrieval target (issues.service_scope) for the passdown packet. */
  serviceScope?: string | null;
  /** PR-9: EM-pinned escape-hatch memory entry ids unioned into the packet. */
  curatedMemoryEntryIds?: string[];
}

interface BuildBriefInput {
  companyId: string;
  issueId: string;
  fromAgentId: string | null;
  toAgentId: string;
  /** PR-9: pre-built vetted passdown packet embedded into the brief markdown. */
  passdown?: PassdownPacket | null;
}

// Adapter types whose execute.ts reads context.combynePassdownContext directly
// (and thus get the vetted packet via the tier-capped composer section). The
// brief-fallback adapters NOT in this set receive the packet embedded in the brief.
const PASSDOWN_SECTION_ADAPTERS = new Set<string>(["claude_local", "codex_local"]);

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

  // PR-9 §5.3 brief-fallback: adapters that read context.combynePassdownContext
  // directly (claude_local/codex_local) get the packet via the composer section
  // — which also enforces the tier cap — so embedding it in the brief too would
  // double-inject AND let the full untruncated copy escape the cap in the
  // cache-stable prefix. Embed in the brief ONLY for the brief-fallback adapters
  // (cursor/gemini/opencode/pi/process) that never see the section.
  const targetReadsPassdownSection = PASSDOWN_SECTION_ADAPTERS.has(toAgentRow?.adapterType ?? "");
  if (input.passdown && input.passdown.body.trim().length > 0 && !targetReadsPassdownSection) {
    lines.push("");
    lines.push(input.passdown.body.trim());
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
    // PR-9 §5.1: assemble the vetted passdown packet at delegate time. The
    // packet retrieves [shared,workspace] requireVerified entries keyed on the
    // child ticket and unions the EM-pinned curated ids, budgeted by complexity.
    // It is persisted into the (previously always-[]) artifactRefs jsonb and is
    // ALSO embedded into the brief markdown for the brief-fallback adapters.
    let passdown: PassdownPacket | null = null;
    try {
      const [child] = await db
        .select({ title: issues.title, description: issues.description, serviceScope: issues.serviceScope })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .limit(1);
      if (child) {
        const serviceScope = input.serviceScope ?? child.serviceScope ?? null;
        passdown = await passdownService(db).buildPassdownPacket({
          companyId: input.companyId,
          childIssueId: input.issueId,
          title: child.title,
          description: child.description,
          serviceScope,
          complexity: input.complexity ?? "small",
          curatedMemoryEntryIds: input.curatedMemoryEntryIds,
        });
      }
    } catch (err) {
      // A passdown failure must never block the handoff itself.
      logger.warn({ err, issueId: input.issueId }, "buildPassdownPacket failed");
      passdown = null;
    }

    const { brief, openQuestions } = await buildBriefMarkdown(db, {
      companyId: input.companyId,
      issueId: input.issueId,
      fromAgentId: input.fromAgentId ?? null,
      toAgentId: input.toAgentId,
      passdown,
    });

    // Persist the typed packet into the existing-but-unused artifactRefs jsonb
    // (zero schema migration). Empty packets are stored as [] so downstream
    // re-hydration stays a simple "first artifactRef of kind passdown" lookup.
    const artifactRefs: Record<string, unknown>[] =
      passdown && passdown.items.length > 0
        ? [passdown as unknown as Record<string, unknown>]
        : [];

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
        artifactRefs,
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
