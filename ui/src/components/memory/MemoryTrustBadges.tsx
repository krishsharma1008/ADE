import type {
  MemoryProvenance,
  MemorySourceRefType,
  MemoryVerificationState,
} from "@combyne/shared";
import { cn } from "../../lib/utils";
import { statusBadge, statusBadgeDefault } from "../../lib/status-colors";

/**
 * Trust-spine (0049) display primitives for the Memory UI (PR-13).
 *
 * These are LABEL-ONLY surfaces — they never gate retrieval, they only make the
 * provenance/verification/confidence of a memory entry legible to a human
 * browsing the corpus. Colors are reused from the canonical StatusBadge map
 * (status-colors.ts) so the verification chip stays consistent with the rest of
 * the app: verified=green, unverified=amber, needs_review=red.
 */

/** Reuse the canonical StatusBadge pill shape so trust chips match every other
 *  status indicator in the app. */
const PILL =
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0";

const PROVENANCE_LABELS: Record<MemoryProvenance, string> = {
  "human-answer": "human answer",
  "pr-approval": "PR approval",
  "verified-summary": "verified summary",
  "agent-claim": "agent claim",
  system: "system",
};

export function ProvenanceBadge({ provenance }: { provenance: MemoryProvenance | null }) {
  const label = provenance ? PROVENANCE_LABELS[provenance] : "unknown";
  return (
    <span className={cn(PILL, statusBadgeDefault)} data-provenance={provenance ?? "unknown"}>
      {label}
    </span>
  );
}

// Map the three verification states onto the canonical StatusBadge color keys:
//   verified    → green (reuse the `active`/`approved` green)
//   unverified  → amber (reuse the `awaiting_user` amber)
//   needs_review→ red   (reuse the `failed`/`error` red)
const VERIFICATION_STATUS_KEY: Record<MemoryVerificationState, string> = {
  verified: "approved",
  unverified: "awaiting_user",
  needs_review: "failed",
};

const VERIFICATION_LABELS: Record<MemoryVerificationState, string> = {
  verified: "verified",
  unverified: "unverified",
  needs_review: "needs review",
};

export function VerificationBadge({ state }: { state: MemoryVerificationState }) {
  const colorKey = VERIFICATION_STATUS_KEY[state];
  return (
    <span
      className={cn(PILL, statusBadge[colorKey] ?? statusBadgeDefault)}
      data-verification={state}
    >
      {VERIFICATION_LABELS[state]}
    </span>
  );
}

/** Confidence meter: a small bar whose fill color tracks the value.
 *  red < 0.4, yellow < 0.7, green otherwise. */
export function ConfidenceMeter({ confidence }: { confidence: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  const tone =
    confidence < 0.4
      ? { bar: "bg-red-500", text: "text-red-600 dark:text-red-400", level: "low" }
      : confidence < 0.7
        ? { bar: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-400", level: "medium" }
        : { bar: "bg-green-500", text: "text-green-600 dark:text-green-400", level: "high" };
  return (
    <div
      className="flex items-center gap-1.5"
      title={`Confidence ${confidence.toFixed(2)}`}
      data-confidence={confidence}
      data-confidence-level={tone.level}
    >
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tone.bar)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn("text-xs font-medium tabular-nums", tone.text)}>
        {confidence.toFixed(2)}
      </span>
    </div>
  );
}

/** Single-line machine-readable citation, mirroring the heartbeat render
 *  format: [mem:<id> · <provenance> · conf=<n> · ref=<type>:<id>]. */
export function MemoryCitationLine({
  id,
  provenance,
  confidence,
  sourceRefType,
  sourceRefId,
}: {
  id: string;
  provenance: MemoryProvenance | null;
  confidence: number;
  sourceRefType: MemorySourceRefType | null;
  sourceRefId: string | null;
}) {
  const ref = sourceRefType ? `${sourceRefType}:${sourceRefId ?? "?"}` : "none";
  return (
    <span className="text-xs font-mono text-muted-foreground" data-slot="memory-citation">
      [mem:{id} · {provenance ?? "unknown"} · conf={confidence.toFixed(2)} · ref={ref}]
    </span>
  );
}
