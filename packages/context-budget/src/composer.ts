// Greedy, cache-aware preamble composer.
//
// Round 3 Phase 4 — ships the composition algorithm but wires it into
// heartbeat.ts in shadow mode only. The byte caps in agent-queue.ts /
// adapter-utils still decide what the adapter actually sees; this
// composer's output is logged for comparison.

import { createHash } from "node:crypto";
import { countTokens } from "./index.js";

export type SectionName =
  | "system"
  | "skills"
  | "projects"
  | "memory"
  | "focus"
  | "queue"
  | "recentTurns"
  | "toolResults"
  | "bootstrap"
  | "handoff"
  | "workspace"
  | "standing"
  | "working";

export type TruncationStrategy = "head" | "tail" | "middle" | "preserve";

export interface PreambleSection {
  name: SectionName | string;
  content: string;
  priority: number;
  cacheStable: boolean;
  maxTokens?: number;
  truncationStrategy: TruncationStrategy;
}

export interface ComposedSection {
  name: string;
  content: string;
  tokens: number;
  truncated: boolean;
  dropped: boolean;
}

export interface ComposedPreamble {
  body: string;
  cachePrefix: string;
  cachePrefixHash: string;
  totalTokens: number;
  stableTokens: number;
  varyTokens: number;
  usage: Record<string, number>;
  dropped: string[];
  truncated: string[];
  warnings: string[];
  sections: ComposedSection[];
}

export interface ComposeOptions {
  budget: number;
  model: string;
  calibrationRatio?: number;
  // Fraction of total budget reserved for stable sections before
  // forcing the lowest-priority stable section to shrink. Default 0.6.
  stableHeadroom?: number;
  // Separator between stable prefix and vary body. Kept static so the
  // prefix hash is a direct function of stable content only.
  varySeparator?: string;
}

const DEFAULT_STABLE_HEADROOM = 0.6;
const DEFAULT_SEPARATOR = "\n\n---\n\n";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Slice text to fit a token budget. Uses observed chars/token to size
// the cut, then iterates if js-tiktoken disagrees with our estimate.
function truncateToTokens(
  text: string,
  maxTokens: number,
  model: string,
  strategy: TruncationStrategy,
  calibrationRatio?: number,
): { text: string; finalTokens: number; truncated: boolean } {
  if (!text) return { text, finalTokens: 0, truncated: false };
  const opts = calibrationRatio !== undefined ? { calibrationRatio } : undefined;
  const current = countTokens(text, model, opts);
  if (current <= maxTokens) return { text, finalTokens: current, truncated: false };
  if (strategy === "preserve") return { text, finalTokens: current, truncated: false };

  const charsPerToken = text.length / Math.max(1, current);
  let safetyFactor = 0.95;
  let out = text;
  let finalTokens = current;

  for (let attempt = 0; attempt < 3; attempt++) {
    const targetChars = Math.max(16, Math.floor(charsPerToken * maxTokens * safetyFactor));
    if (targetChars >= text.length) {
      out = text;
      finalTokens = current;
      break;
    }
    switch (strategy) {
      case "tail":
        out = text.slice(0, targetChars) + "\n…[truncated]";
        break;
      case "head":
        out = "…[truncated]\n" + text.slice(text.length - targetChars);
        break;
      case "middle": {
        const half = Math.floor(targetChars / 2);
        out =
          text.slice(0, half) +
          "\n…[content omitted]…\n" +
          text.slice(text.length - half);
        break;
      }
    }
    finalTokens = countTokens(out, model, opts);
    if (finalTokens <= maxTokens) break;
    safetyFactor *= 0.85;
  }

  return { text: out, finalTokens, truncated: true };
}

interface RenderedSection {
  section: PreambleSection;
  content: string;
  tokens: number;
  truncated: boolean;
  dropped: boolean;
}

export function composeBudgetedPreamble(
  sections: PreambleSection[],
  opts: ComposeOptions,
): ComposedPreamble {
  const separator = opts.varySeparator ?? DEFAULT_SEPARATOR;
  const stableHeadroom = opts.stableHeadroom ?? DEFAULT_STABLE_HEADROOM;
  const warnings: string[] = [];
  const usage: Record<string, number> = {};
  const dropped: string[] = [];
  const truncated: string[] = [];

  // Sanity: dedupe identical names by keeping the last occurrence.
  const byName = new Map<string, PreambleSection>();
  for (const s of sections) byName.set(s.name, s);
  const uniqueSections = Array.from(byName.values());

  // Round 3 Phase 6 — "standing" sits between memory and workspace in the
  // stable tier. It's rewritten occasionally (cooldown ~10 min) but the
  // stable-tier placement buys us cache hits on the ~90%+ of wakes where the
  // summary is unchanged. "working" stays in vary since it tracks ticket
  // progression and changes per-issue between wakes.
  const stableOrder = [
    "system",
    "bootstrap",
    "handoff",
    "skills",
    "projects",
    "memory",
    "standing",
    "workspace",
  ];
  const varyOrder = ["focus", "working", "recentTurns", "queue", "toolResults"];

  const stable = uniqueSections
    .filter((s) => s.cacheStable && s.content.length > 0)
    .sort((a, b) => {
      const ia = stableOrder.indexOf(String(a.name));
      const ib = stableOrder.indexOf(String(b.name));
      if (ia === -1 && ib === -1) return a.priority - b.priority;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

  const vary = uniqueSections
    .filter((s) => !s.cacheStable && s.content.length > 0)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const ia = varyOrder.indexOf(String(a.name));
      const ib = varyOrder.indexOf(String(b.name));
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

  const renderedStable: RenderedSection[] = [];
  let stableTokens = 0;
  const stableBudget = Math.floor(opts.budget * stableHeadroom);

  for (const s of stable) {
    const perSectionCap = s.maxTokens ?? opts.budget;
    const remaining = Math.max(0, stableBudget - stableTokens);
    const cap = Math.max(0, Math.min(perSectionCap, remaining));
    if (cap <= 0) {
      renderedStable.push({ section: s, content: "", tokens: 0, truncated: false, dropped: true });
      dropped.push(String(s.name));
      continue;
    }
    const { text, finalTokens, truncated: wasTruncated } = truncateToTokens(
      s.content,
      cap,
      opts.model,
      s.truncationStrategy,
      opts.calibrationRatio,
    );
    renderedStable.push({
      section: s,
      content: text,
      tokens: finalTokens,
      truncated: wasTruncated,
      dropped: false,
    });
    stableTokens += finalTokens;
    usage[String(s.name)] = finalTokens;
    if (wasTruncated) truncated.push(String(s.name));
  }

  if (stableTokens > stableBudget) {
    warnings.push("context_budget.stable_overflow");
    // Shrink lowest-priority stable sections (reverse stableOrder) until fit.
    for (let i = renderedStable.length - 1; i >= 0 && stableTokens > stableBudget; i--) {
      const r = renderedStable[i];
      if (r.dropped || r.tokens === 0) continue;
      const overBy = stableTokens - stableBudget;
      const targetTokens = Math.max(0, r.tokens - overBy);
      if (targetTokens === 0) {
        stableTokens -= r.tokens;
        r.content = "";
        r.tokens = 0;
        r.dropped = true;
        dropped.push(String(r.section.name));
        usage[String(r.section.name)] = 0;
        continue;
      }
      const { text, finalTokens, truncated: wasTruncated } = truncateToTokens(
        r.content,
        targetTokens,
        opts.model,
        r.section.truncationStrategy,
        opts.calibrationRatio,
      );
      stableTokens -= r.tokens;
      r.content = text;
      r.tokens = finalTokens;
      stableTokens += finalTokens;
      usage[String(r.section.name)] = finalTokens;
      if (wasTruncated && !truncated.includes(String(r.section.name))) {
        truncated.push(String(r.section.name));
      }
    }
  }

  const cachePrefix = renderedStable
    .filter((r) => !r.dropped && r.content.length > 0)
    .map((r) => r.content.trimEnd())
    .join(separator);
  const cachePrefixHash = sha256(cachePrefix);

  const varyBudget = Math.max(0, opts.budget - stableTokens);
  let varyTokens = 0;
  const renderedVary: RenderedSection[] = [];

  for (const s of vary) {
    const perSectionCap = s.maxTokens ?? opts.budget;
    const remaining = Math.max(0, varyBudget - varyTokens);
    const cap = Math.max(0, Math.min(perSectionCap, remaining));
    if (cap <= 0) {
      dropped.push(String(s.name));
      usage[String(s.name)] = 0;
      renderedVary.push({ section: s, content: "", tokens: 0, truncated: false, dropped: true });
      continue;
    }
    const { text, finalTokens, truncated: wasTruncated } = truncateToTokens(
      s.content,
      cap,
      opts.model,
      s.truncationStrategy,
      opts.calibrationRatio,
    );
    renderedVary.push({
      section: s,
      content: text,
      tokens: finalTokens,
      truncated: wasTruncated,
      dropped: false,
    });
    varyTokens += finalTokens;
    usage[String(s.name)] = finalTokens;
    if (wasTruncated) truncated.push(String(s.name));
  }

  const varyBody = renderedVary
    .filter((r) => !r.dropped && r.content.length > 0)
    .map((r) => r.content.trimEnd())
    .join(separator);

  const body = cachePrefix && varyBody ? `${cachePrefix}${separator}${varyBody}` : cachePrefix || varyBody;

  const composedSections: ComposedSection[] = [...renderedStable, ...renderedVary].map((r) => ({
    name: String(r.section.name),
    content: r.content,
    tokens: r.tokens,
    truncated: r.truncated,
    dropped: r.dropped,
  }));

  return {
    body,
    cachePrefix,
    cachePrefixHash,
    totalTokens: stableTokens + varyTokens,
    stableTokens,
    varyTokens,
    usage,
    dropped,
    truncated,
    warnings,
    sections: composedSections,
  };
}
