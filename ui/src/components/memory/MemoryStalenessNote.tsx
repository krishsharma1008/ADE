import { Clock } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Staleness UX note (PR-16 §3.11 — the prompt-cache window). A fact a user just
 * edited / redacted / superseded / resolved can still be served from a cached
 * agent prefix until the cache TTL, so a correction is NOT instant. We surface
 * this on every memory write surface (edit dialog, redaction card, conflict
 * resolver) so users don't assume a change reaches running agents immediately.
 */
export function MemoryStalenessNote({ className }: { className?: string }) {
  return (
    <p
      className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)}
      data-staleness-note
    >
      <Clock className="mt-0.5 h-3 w-3 shrink-0" />
      <span>
        Changes may take up to the prompt-cache TTL to reach running agents — a correction is not
        instant.
      </span>
    </p>
  );
}
