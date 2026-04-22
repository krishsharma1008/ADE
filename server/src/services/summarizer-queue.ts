// Round 3 Phase 6 PR 6.2 — coordination tier around `summarizeAgentTranscript`.
//
// Two-layer coordination for Phase 6.2:
//   1. In-process Map keyed `agentId:scope:scopeId` for fast-path coalescing
//      of concurrent triggers inside the same node.
//   2. DB-driven cooldown: read the latest `transcript_summaries.created_at`
//      for this key and skip if within the per-scope cooldown window.
//
// The UNIQUE index on `transcript_summaries(agent_id, scope_kind, scope_id,
// cutoff_seq)` is the authoritative backstop: even if two replicas race, at
// most one row lands. The loser hits UNIQUE, catches via `race_lost`, and
// returns the winner's row as `created`. Wasted LLM spend in that narrow
// window is acceptable given the 10-min cooldowns.
//
// The advisory-lock primitives in `summarizer-failures.ts` are kept for the
// multi-replica story (PR 6.3+) but not used on the hot path here —
// `pg_try_advisory_lock` is session-scoped and postgres-js pools connections,
// so lock/release can land on different sessions. Proper integration needs a
// reserved client per call, which isn't worth the complexity at this stage.
//
// Non-durable intentionally. On restart, the next heartbeat re-fires
// post-run triggers, and pruning is additive-only in Phase 6 so the
// fallback is always "use the raw tail."

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { transcriptSummaries } from "@combyne/db";
import { logger } from "../middleware/logger.js";
import {
  summarizeAgentTranscript,
  type SummarizeInput,
  type SummarizeResult,
  type SummarizeStatus,
  type SummarizerDriver,
} from "./transcript-summarizer.js";

export const DEFAULT_COOLDOWN_MS: Record<"standing" | "working", number> = {
  standing: 10 * 60_000,
  working: 10 * 60_000,
};

export type QueueStatus = SummarizeStatus | "skipped_cooldown";

export interface QueueResult extends Omit<SummarizeResult, "status"> {
  status: QueueStatus;
}

export interface SummarizerQueueOptions {
  driver: SummarizerDriver;
  cooldownMs?: Partial<typeof DEFAULT_COOLDOWN_MS>;
  now?: () => Date;
}

function keyOf(input: SummarizeInput): string {
  const scopeId = input.scope === "working" ? input.issueId ?? "" : "";
  return `${input.agentId}:${input.scope}:${scopeId}`;
}

export class SummarizerQueue {
  private readonly inFlight = new Map<string, Promise<QueueResult>>();
  private readonly cooldownMs: typeof DEFAULT_COOLDOWN_MS;
  private readonly now: () => Date;
  private readonly driver: SummarizerDriver;

  constructor(options: SummarizerQueueOptions) {
    this.driver = options.driver;
    this.cooldownMs = { ...DEFAULT_COOLDOWN_MS, ...options.cooldownMs };
    this.now = options.now ?? (() => new Date());
  }

  // Coalesces concurrent triggers for the same key inside a single node. Two
  // callers asking for the same summary simultaneously share one driver call.
  // Reserving the in-flight slot is synchronous so there's no check-and-set
  // race between peer callers on the same agent+scope.
  async maybeEnqueue(db: Db, input: SummarizeInput): Promise<QueueResult> {
    const key = keyOf(input);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.doWork(db, input).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async doWork(db: Db, input: SummarizeInput): Promise<QueueResult> {
    const cooldown = this.cooldownMs[input.scope];
    if (await this.withinCooldown(db, input, cooldown)) {
      return { status: "skipped_cooldown" };
    }
    return this.run(db, input);
  }

  private async withinCooldown(
    db: Db,
    input: SummarizeInput,
    cooldownMs: number,
  ): Promise<boolean> {
    if (cooldownMs <= 0) return false;
    try {
      const filters = [
        eq(transcriptSummaries.agentId, input.agentId),
        eq(transcriptSummaries.scopeKind, input.scope),
      ];
      const scopeId = input.scope === "working" ? input.issueId ?? null : null;
      if (scopeId) {
        filters.push(eq(transcriptSummaries.scopeId, scopeId));
      } else {
        filters.push(isNull(transcriptSummaries.scopeId));
      }
      const rows = await db
        .select({ createdAt: transcriptSummaries.createdAt })
        .from(transcriptSummaries)
        .where(and(...filters))
        .orderBy(desc(transcriptSummaries.createdAt))
        .limit(1);
      if (rows.length === 0) return false;
      const last = rows[0].createdAt.getTime();
      return this.now().getTime() - last < cooldownMs;
    } catch (err) {
      // Be permissive on lookup failures — the advisory lock + UNIQUE index
      // still protect against runaway duplicate work.
      logger.debug({ err }, "summarizer_queue.cooldown_check_failed");
      return false;
    }
  }

  private async run(db: Db, input: SummarizeInput): Promise<QueueResult> {
    const result = await summarizeAgentTranscript(db, this.driver, input);
    return result as QueueResult;
  }
}

// Process-wide singleton — heartbeat wires its driver in at boot time.
let singleton: SummarizerQueue | null = null;

export function setSummarizerQueue(queue: SummarizerQueue | null): void {
  singleton = queue;
}

export function getSummarizerQueue(): SummarizerQueue | null {
  return singleton;
}
