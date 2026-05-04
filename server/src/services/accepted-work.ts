import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import {
  acceptedWorkEvents,
  agents,
  companyIntegrations,
  issueComments,
  issues,
} from "@combyne/db";
import type {
  AcceptedWorkDetectionSource,
  AcceptedWorkEvent,
  AcceptedWorkMemoryStatus,
  GitHubConfig,
  GitHubPullRequest,
  MemoryKind,
} from "@combyne/shared";
import { logger } from "../middleware/logger.js";
import { createGitHubClient } from "./github.js";
import { memoryService } from "./memory.js";

const ISSUE_IDENTIFIER_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/gi;
const GITHUB_RECONCILE_INTERVAL_MS = 12 * 60 * 60_000;
const reconcileThrottle = new Map<string, number>();

type AcceptedWorkRow = typeof acceptedWorkEvents.$inferSelect;

export interface UpsertMergedPullInput {
  companyId: string;
  issueId?: string | null;
  repo: string;
  pullNumber: number;
  pullUrl?: string | null;
  title: string;
  body?: string | null;
  headBranch?: string | null;
  mergedSha?: string | null;
  mergedAt?: Date | string | null;
  detectionSource: AcceptedWorkDetectionSource;
  metadata?: Record<string, unknown> | null;
}

export interface UpsertMergedPullResult {
  event: AcceptedWorkEvent;
  created: boolean;
  shouldWakeManager: boolean;
}

export interface CreateMemoryFromAcceptedWorkInput {
  eventId: string;
  subject: string;
  body: string;
  kind: MemoryKind;
  tags?: string[];
  serviceScope?: string | null;
  createdBy?: string | null;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function rowToEvent(row: AcceptedWorkRow): AcceptedWorkEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    provider: "github",
    repo: row.repo,
    pullNumber: row.pullNumber,
    pullUrl: row.pullUrl ?? null,
    title: row.title,
    body: row.body ?? null,
    headBranch: row.headBranch ?? null,
    mergedSha: row.mergedSha ?? null,
    mergedAt: toIso(row.mergedAt ?? null),
    detectedAt: row.detectedAt.toISOString(),
    detectionSource: row.detectionSource as AcceptedWorkDetectionSource,
    issueId: row.issueId ?? null,
    contributorAgentId: row.contributorAgentId ?? null,
    managerAgentId: row.managerAgentId ?? null,
    wakeupRequestedAt: toIso(row.wakeupRequestedAt ?? null),
    memoryStatus: row.memoryStatus as AcceptedWorkMemoryStatus,
    memoryEntryId: row.memoryEntryId ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractIssueIdentifiers(...parts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const match of part.matchAll(ISSUE_IDENTIFIER_RE)) {
      seen.add(match[0].toUpperCase());
    }
  }
  return [...seen];
}

function repoTag(repo: string): string {
  return `repo:${repo.toLowerCase()}`;
}

async function latestIssueCommentSnippet(db: Db, companyId: string, issueId: string) {
  const row = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId)))
    .orderBy(desc(issueComments.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.body?.slice(0, 800) ?? null;
}

function mergedPullFromGitHub(
  pr: GitHubPullRequest,
  source: AcceptedWorkDetectionSource,
): Omit<UpsertMergedPullInput, "companyId"> {
  return {
    repo: "",
    pullNumber: pr.number,
    pullUrl: pr.htmlUrl,
    title: pr.title,
    body: pr.body,
    headBranch: pr.headBranch,
    mergedSha: pr.mergeCommitSha ?? null,
    mergedAt: pr.mergedAt ?? pr.updatedAt,
    detectionSource: source,
    metadata: { githubUser: pr.user, baseBranch: pr.baseBranch },
  };
}

export function acceptedWorkService(db: Db) {
  async function getById(id: string): Promise<AcceptedWorkEvent | null> {
    const row = await db
      .select()
      .from(acceptedWorkEvents)
      .where(eq(acceptedWorkEvents.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? rowToEvent(row) : null;
  }

  async function list(companyId: string, status?: AcceptedWorkMemoryStatus) {
    const filters = [eq(acceptedWorkEvents.companyId, companyId)];
    if (status) filters.push(eq(acceptedWorkEvents.memoryStatus, status));
    const rows = await db
      .select()
      .from(acceptedWorkEvents)
      .where(and(...filters))
      .orderBy(desc(acceptedWorkEvents.detectedAt))
      .limit(200);
    return rows.map(rowToEvent);
  }

  async function findIssueForPull(input: UpsertMergedPullInput) {
    if (input.issueId) {
      const issue = await db
        .select()
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (issue) return issue;
    }

    const identifiers = extractIssueIdentifiers(input.title, input.body, input.headBranch);
    for (const identifier of identifiers) {
      const issue = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, input.companyId), eq(issues.identifier, identifier)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (issue) return issue;
    }
    return null;
  }

  async function resolveManager(companyId: string, issue: typeof issues.$inferSelect | null) {
    if (issue?.parentId) {
      const parent = await db
        .select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.id, issue.parentId), eq(issues.companyId, issue.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (parent?.assigneeAgentId) return parent.assigneeAgentId;
    }

    if (issue?.assigneeAgentId) {
      const assignee = await db
        .select({ reportsTo: agents.reportsTo })
        .from(agents)
        .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (assignee?.reportsTo) return assignee.reportsTo;
    }

    const fallback = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          isNull(agents.reportsTo),
        ),
      )
      .orderBy(sql`case when ${agents.role} = 'ceo' then 0 else 1 end`, desc(agents.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return fallback?.id ?? null;
  }

  async function upsertMergedPull(input: UpsertMergedPullInput): Promise<UpsertMergedPullResult> {
    const issue = await findIssueForPull(input);
    const companyId = input.companyId;
    const contributorAgentId = issue?.assigneeAgentId ?? null;
    const managerAgentId = await resolveManager(companyId, issue);
    const now = new Date();
    const mergedAt = parseDate(input.mergedAt);
    const existing = await db
      .select()
      .from(acceptedWorkEvents)
      .where(
        and(
          eq(acceptedWorkEvents.companyId, companyId),
          eq(acceptedWorkEvents.provider, "github"),
          eq(acceptedWorkEvents.repo, input.repo),
          eq(acceptedWorkEvents.pullNumber, input.pullNumber),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (existing) {
      const [updated] = await db
        .update(acceptedWorkEvents)
        .set({
          pullUrl: input.pullUrl ?? existing.pullUrl,
          title: input.title,
          body: input.body ?? existing.body,
          headBranch: input.headBranch ?? existing.headBranch,
          mergedSha: input.mergedSha ?? existing.mergedSha,
          mergedAt: mergedAt ?? existing.mergedAt,
          detectionSource: input.detectionSource,
          issueId: issue?.id ?? existing.issueId,
          contributorAgentId: contributorAgentId ?? existing.contributorAgentId,
          managerAgentId: managerAgentId ?? existing.managerAgentId,
          metadata: { ...(existing.metadata ?? {}), ...(input.metadata ?? {}) },
          updatedAt: now,
        })
        .where(eq(acceptedWorkEvents.id, existing.id))
        .returning();
      const event = rowToEvent(updated);
      return {
        event,
        created: false,
        shouldWakeManager:
          event.memoryStatus === "pending" &&
          Boolean(event.managerAgentId) &&
          !event.wakeupRequestedAt,
      };
    }

    const [created] = await db
      .insert(acceptedWorkEvents)
      .values({
        companyId,
        provider: "github",
        repo: input.repo,
        pullNumber: input.pullNumber,
        pullUrl: input.pullUrl ?? null,
        title: input.title,
        body: input.body ?? null,
        headBranch: input.headBranch ?? null,
        mergedSha: input.mergedSha ?? null,
        mergedAt,
        detectionSource: input.detectionSource,
        issueId: issue?.id ?? null,
        contributorAgentId,
        managerAgentId,
        metadata: input.metadata ?? null,
      })
      .returning();
    const event = rowToEvent(created);
    return {
      event,
      created: true,
      shouldWakeManager: Boolean(event.managerAgentId),
    };
  }

  async function markWakeRequested(eventId: string) {
    await db
      .update(acceptedWorkEvents)
      .set({ wakeupRequestedAt: new Date(), updatedAt: new Date() })
      .where(eq(acceptedWorkEvents.id, eventId));
  }

  async function pendingForManager(companyId: string, managerAgentId: string, eventId?: string | null) {
    const filters = [
      eq(acceptedWorkEvents.companyId, companyId),
      eq(acceptedWorkEvents.managerAgentId, managerAgentId),
      eq(acceptedWorkEvents.memoryStatus, "pending"),
    ];
    if (eventId) filters.push(eq(acceptedWorkEvents.id, eventId));
    const rows = await db
      .select()
      .from(acceptedWorkEvents)
      .where(and(...filters))
      .orderBy(desc(acceptedWorkEvents.detectedAt))
      .limit(eventId ? 1 : 5);
    return rows.map(rowToEvent);
  }

  async function buildBrief(companyId: string, events: AcceptedWorkEvent[]): Promise<string> {
    if (events.length === 0) return "";
    const lines = [
      "# Accepted work needs memory curation",
      "",
      "Merged PRs below are accepted work. Create or update only high-signal workspace memory that will help future tasks. Keep entries concise, company-scoped, and repo/service scoped when possible. Do not record failed or rejected-work lessons in this phase.",
    ];
    for (const event of events) {
      let issue: typeof issues.$inferSelect | null = null;
      if (event.issueId) {
        issue = await db
          .select()
          .from(issues)
          .where(and(eq(issues.id, event.issueId), eq(issues.companyId, companyId)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      }
      const latestComment = issue ? await latestIssueCommentSnippet(db, companyId, issue.id) : null;
      lines.push(
        "",
        `## ${event.repo}#${event.pullNumber} — ${event.title}`,
        `- Event id: ${event.id}`,
        `- PR: ${event.pullUrl ?? "(no URL)"}`,
        `- Merged SHA: ${event.mergedSha ?? "(unknown)"}`,
        `- Merged at: ${event.mergedAt ?? "(unknown)"}`,
        `- Linked issue: ${issue?.identifier ?? event.issueId ?? "(none inferred)"}`,
        `- Suggested tags: accepted-work, ${repoTag(event.repo)}${issue?.identifier ? `, ${issue.identifier.toLowerCase()}` : ""}`,
      );
      if (issue?.description) lines.push(`- Issue context: ${issue.description.slice(0, 800)}`);
      if (latestComment) lines.push(`- Latest issue comment: ${latestComment}`);
      if (event.body) lines.push("", event.body.slice(0, 1200));
    }
    lines.push(
      "",
      "When the memory is written, call the accepted-work memory endpoint or mark the event ignored/needs_human_review if nothing durable should be stored.",
    );
    return lines.join("\n");
  }

  async function createMemoryFromEvent(input: CreateMemoryFromAcceptedWorkInput) {
    const event = await getById(input.eventId);
    if (!event) return null;
    const svc = memoryService(db);
    const tags = Array.from(
      new Set(["accepted-work", repoTag(event.repo), ...(input.tags ?? [])]),
    ).slice(0, 32);
    const entry = await svc.createEntry({
      companyId: event.companyId,
      layer: "workspace",
      subject: input.subject,
      body: input.body,
      kind: input.kind,
      tags,
      serviceScope: input.serviceScope ?? event.repo,
      source: `accepted_work:${event.id}`,
      createdBy: input.createdBy ?? null,
    });
    const [updated] = await db
      .update(acceptedWorkEvents)
      .set({
        memoryStatus: "memory_written",
        memoryEntryId: entry.id,
        updatedAt: new Date(),
      })
      .where(eq(acceptedWorkEvents.id, event.id))
      .returning();
    return { event: rowToEvent(updated), memory: entry };
  }

  async function resolveEvent(eventId: string, status: AcceptedWorkMemoryStatus, memoryEntryId?: string | null) {
    const [row] = await db
      .update(acceptedWorkEvents)
      .set({
        memoryStatus: status,
        memoryEntryId: memoryEntryId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(acceptedWorkEvents.id, eventId))
      .returning();
    return row ? rowToEvent(row) : null;
  }

  async function reconcileGitHubCompany(
    companyId: string,
    source: AcceptedWorkDetectionSource = "github_reconcile",
  ) {
    const row = await db
      .select()
      .from(companyIntegrations)
      .where(
        and(
          eq(companyIntegrations.companyId, companyId),
          eq(companyIntegrations.provider, "github"),
          eq(companyIntegrations.enabled, "true"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return { scanned: 0, upserted: 0, events: [] as AcceptedWorkEvent[] };

    const config = row.config as unknown as GitHubConfig;
    const client = createGitHubClient(config);
    const repos = config.defaultRepo
      ? [config.defaultRepo]
      : (await client.listRepos()).slice(0, 20).map((repo) => repo.name);
    const events: AcceptedWorkEvent[] = [];
    let scanned = 0;
    for (const repo of repos) {
      const pulls = await client.listPullRequests(repo, "closed");
      for (const pr of pulls) {
        scanned++;
        if (!pr.merged) continue;
        const merged = mergedPullFromGitHub(pr, source);
        const result = await upsertMergedPull({ ...merged, companyId, repo });
        events.push(result.event);
      }
    }
    return { scanned, upserted: events.length, events };
  }

  async function maybeReconcileGitHubCompany(companyId: string) {
    const last = reconcileThrottle.get(companyId) ?? 0;
    if (Date.now() - last < GITHUB_RECONCILE_INTERVAL_MS) {
      return { skipped: true as const };
    }
    reconcileThrottle.set(companyId, Date.now());
    try {
      return {
        skipped: false as const,
        ...(await reconcileGitHubCompany(companyId, "heartbeat_reconcile")),
      };
    } catch (err) {
      logger.debug({ err, companyId }, "accepted_work.github_reconcile_failed");
      return { skipped: false as const, scanned: 0, upserted: 0, events: [] as AcceptedWorkEvent[] };
    }
  }

  return {
    getById,
    list,
    upsertMergedPull,
    markWakeRequested,
    pendingForManager,
    buildBrief,
    createMemoryFromEvent,
    resolveEvent,
    reconcileGitHubCompany,
    maybeReconcileGitHubCompany,
  };
}

export type AcceptedWorkService = ReturnType<typeof acceptedWorkService>;
