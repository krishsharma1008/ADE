import { useState } from "react";
import type { MemoryEntry } from "@combyne/shared";
import { Eye, EyeOff, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProvenanceBadge, VerificationBadge } from "./MemoryTrustBadges";
import { MemoryStalenessNote } from "./MemoryStalenessNote";

/**
 * Redaction-queue card (PR-15 §3.6 — the blocking redact-before-embed gate).
 *
 * The body is a credential-bearing channel by design (it was quarantined to
 * needs_review precisely because the secret scanner found a credential shape, or
 * a human force-flagged it). It is therefore MASKED BY DEFAULT: the raw body is
 * NEVER rendered into the DOM until the board principal explicitly clicks Reveal.
 * This is a hard regression guard — see MemoryRedactionCard.test.tsx, which
 * asserts no secret span exists in the DOM before Reveal.
 *
 * Actions:
 *  - Approve-as-clean → POST .../redaction/resolve { action:'approve' } (verify).
 *  - Keep-redacted    → POST .../redaction/resolve { action:'reject' } (archive).
 */
export function MemoryRedactionCard({
  entry,
  onResolve,
  isResolving,
}: {
  entry: MemoryEntry;
  onResolve: (entryId: string, action: "approve" | "reject") => void;
  isResolving?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <article
      className="overflow-hidden rounded-md border border-red-500/40 bg-red-500/[0.03]"
      data-redaction-entry={entry.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0 text-red-500" />
          <h3 className="min-w-0 truncate text-sm font-medium">{entry.subject}</h3>
        </div>
        <div className="flex items-center gap-2">
          <ProvenanceBadge provenance={entry.provenance} />
          <VerificationBadge state={entry.verificationState} />
        </div>
      </div>

      <div className="space-y-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className="border-red-500/60 text-red-600 dark:text-red-400">
            held out of retrieval
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRevealed((v) => !v)}
            data-action="reveal-toggle"
            aria-pressed={revealed}
          >
            {revealed ? (
              <>
                <EyeOff className="mr-1.5 h-4 w-4" />
                Hide
              </>
            ) : (
              <>
                <Eye className="mr-1.5 h-4 w-4" />
                Reveal
              </>
            )}
          </Button>
        </div>

        {/* MASKED BY DEFAULT. The raw body is rendered ONLY after Reveal — it is
            never present in the DOM in the masked state (the leak regression
            guard). */}
        {revealed ? (
          <pre
            className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs"
            data-revealed-body
          >
            {entry.body}
          </pre>
        ) : (
          <div
            className="rounded-md border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground"
            data-masked-body
          >
            Body masked. This entry was quarantined because it may contain a
            credential. Click Reveal to inspect before deciding.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => onResolve(entry.id, "approve")}
            disabled={isResolving}
            data-action="approve"
            className="bg-green-600 hover:bg-green-700 text-white"
          >
            Approve as clean
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onResolve(entry.id, "reject")}
            disabled={isResolving}
            data-action="reject"
          >
            Keep redacted
          </Button>
        </div>

        <MemoryStalenessNote />
      </div>
    </article>
  );
}
