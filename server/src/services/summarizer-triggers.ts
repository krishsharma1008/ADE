// Round 3 Phase 6 PR 6.3 — shared helpers for the heartbeat integration.
//
// Kept out of transcript-summarizer.ts because these functions are the
// read path (preamble composition + post-run trigger decision), separate
// from the write path owned by the summarizer itself. Splitting avoids an
// import cycle between heartbeat → summarizer-queue → transcript-summarizer
// while letting both share the same counting contract.

import type { Db } from "@combyne/db";
import { countTokens } from "@combyne/context-budget";
import {
  COUNTABLE_ROLES,
  EXCLUDED_CONTENT_KINDS,
  extractCountableText,
  loadTranscriptSince,
  type LoadedTranscriptEntry,
} from "./agent-transcripts.js";
import {
  loadLatestSummary,
  type SummaryScope,
} from "./transcript-summarizer.js";

export interface UnsummarizedTokensInput {
  companyId: string;
  agentId: string;
  scope: SummaryScope;
  issueId?: string | null;
  model: string;
  calibrationRatio?: number | null;
  maxRows?: number;
  // Round 3 Phase 7 — "aggressive" excludes raw turns ≤ summary.cutoffSeq.
  // "additive" (default) loads the full tail regardless of summary state so
  // the summary row just enriches the prompt without shrinking it.
  pruningMode?: "additive" | "aggressive";
}

export interface UnsummarizedTokensResult {
  tokens: number;
  turnCount: number;
  cutoffOrdinal: number | null;
  entries: LoadedTranscriptEntry[];
}

// "How many tokens of un-summarized transcript does this scope have right
// now?" Used by the post-run trigger to decide whether to enqueue a
// summarization job, and indirectly by the preamble composer when it
// wants to surface recent-turns content.
export async function unsummarizedTokensFor(
  db: Db,
  opts: UnsummarizedTokensInput,
): Promise<UnsummarizedTokensResult> {
  const scopeId = opts.scope === "working" ? opts.issueId ?? null : null;
  const latest = await loadLatestSummary(db, {
    agentId: opts.agentId,
    scopeKind: opts.scope,
    scopeId,
  });

  const mode = opts.pruningMode ?? "aggressive";
  const sinceOrdinal =
    mode === "aggressive" && latest?.cutoffSeq != null
      ? Number(latest.cutoffSeq)
      : null;

  const transcript = await loadTranscriptSince(db, {
    companyId: opts.companyId,
    agentId: opts.agentId,
    issueId: opts.scope === "working" ? opts.issueId ?? null : null,
    sinceOrdinal,
    maxRows: opts.maxRows ?? 500,
    excludeContentKinds: Array.from(EXCLUDED_CONTENT_KINDS),
  });

  const entries = transcript.entries.filter(
    (e) =>
      COUNTABLE_ROLES.includes(e.role) &&
      (!e.contentKind || !EXCLUDED_CONTENT_KINDS.includes(e.contentKind)),
  );
  const text = entries.map(extractCountableText).join("\n\n");
  const tokens = text
    ? countTokens(text, opts.model, {
        calibrationRatio: opts.calibrationRatio ?? null,
      })
    : 0;
  return {
    tokens,
    turnCount: entries.length,
    cutoffOrdinal: latest?.cutoffSeq != null ? Number(latest.cutoffSeq) : null,
    entries,
  };
}

// Cap the rendered "recent turns" block at this many tokens when writing
// to context. The composer still bounds it per its section strategy; this
// is a cheap pre-clip so we don't spend composer cycles on a 200k-token
// payload that will obviously be trimmed.
export const RECENT_TURNS_MAX_TOKENS = 5_000;

export interface RenderRecentTurnsOutput {
  body: string;
  tokens: number;
  turnCount: number;
}

// Render a compact markdown block of the tail of `entries`. Role-prefixed
// headers keep the structure readable to the model; ordinals are kept so
// the operator can cross-reference in the transcript UI.
export function renderRecentTurns(
  entries: LoadedTranscriptEntry[],
  model: string,
  opts?: { maxTokens?: number; calibrationRatio?: number | null },
): RenderRecentTurnsOutput {
  const maxTokens = opts?.maxTokens ?? RECENT_TURNS_MAX_TOKENS;
  if (entries.length === 0) {
    return { body: "", tokens: 0, turnCount: 0 };
  }

  // Walk from newest → oldest, prepend until we exceed the cap, then
  // reverse. This keeps the latest turns and drops the oldest, which is
  // the right heuristic when a wake is picking up a mid-flight thread.
  const blocks: string[] = [];
  const kept: LoadedTranscriptEntry[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const text = extractCountableText(e);
    if (!text) continue;
    const header = e.contentKind
      ? `### ${e.role}/${e.contentKind} · ord=${e.ordinal}`
      : `### ${e.role} · ord=${e.ordinal}`;
    const rendered = `${header}\n${text}`;
    const tokenEst = countTokens(rendered, model, {
      calibrationRatio: opts?.calibrationRatio ?? null,
    });
    if (total + tokenEst > maxTokens && blocks.length > 0) break;
    blocks.unshift(rendered);
    kept.unshift(e);
    total += tokenEst;
  }

  return {
    body: blocks.join("\n\n---\n\n"),
    tokens: total,
    turnCount: kept.length,
  };
}
