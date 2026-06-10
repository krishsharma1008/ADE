import type { MemoryEntry, UpdateMemoryEntry } from "@combyne/shared";
import { Check, Edit2, Globe, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { cn } from "../../lib/utils";
import {
  ConfidenceMeter,
  MemoryCitationLine,
  ProvenanceBadge,
  VerificationBadge,
} from "./MemoryTrustBadges";
import { MemoryEntryEditDialog } from "./MemoryEntryEditDialog";

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

/**
 * Browse-tab card for a single memory entry (PR-13). Extends the original
 * CompanyMemory inline-edit card with the trust-spine surfaces: provenance +
 * verification badges, a confidence meter, the machine-readable citation line,
 * and a struck-through "superseded" state for conflict losers.
 *
 * Editing is workspace/personal only — shared entries are promotion-gated, so
 * the edit affordance is hidden for them (the server validator also rejects it).
 */
export function MemoryEntryCard({
  entry,
  onSave,
  isSaving,
  saveError,
  /**
   * M6: when supplied (instance-admin only), a "Promote to global" action is
   * shown on VERIFIED workspace/shared entries. It copies the entry into the
   * instance-wide global layer (company_id = NULL) via the promote endpoint.
   */
  onPromoteToGlobal,
  isPromoting,
  alreadyPromoted,
  justPromoted,
  promoteError,
  /** When supplied, a Delete (archive) action is shown. Server enforces layer gates. */
  onDelete,
  isDeleting,
  deleteError,
}: {
  entry: MemoryEntry;
  onSave?: (entryId: string, data: UpdateMemoryEntry) => void;
  isSaving?: boolean;
  saveError?: string | null;
  onPromoteToGlobal?: (entryId: string) => void;
  isPromoting?: boolean;
  /** This source already has a global-layer copy — show a settled "In global" state. */
  alreadyPromoted?: boolean;
  /** The most recent promote of THIS entry just succeeded — transient confirmation. */
  justPromoted?: boolean;
  /** A failed promote of THIS entry, surfaced inline (the action was otherwise silent). */
  promoteError?: string | null;
  onDelete?: (entryId: string) => void;
  isDeleting?: boolean;
  deleteError?: string | null;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const superseded = entry.supersededById != null;
  const editable = onSave != null && entry.layer !== "shared";
  // Promote is offered only for already-verified, non-global, non-superseded
  // company entries — the global layer should carry trusted facts, and a global
  // row can't be re-promoted into itself.
  const canPromoteToGlobal =
    onPromoteToGlobal != null &&
    !superseded &&
    entry.layer !== "global" &&
    (entry.layer === "workspace" || entry.layer === "shared") &&
    entry.verificationState === "verified";

  return (
    <article
      className={cn(
        "border-b border-border p-3 last:border-b-0 hover:bg-accent/20",
        superseded && "opacity-60",
      )}
      data-superseded={superseded || undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            superseded && "line-through",
          )}
        >
          {entry.subject}
        </h3>
        <Badge variant={entry.layer === "shared" ? "default" : "secondary"}>{entry.layer}</Badge>
        <Badge variant="outline">{entry.kind}</Badge>
        <ProvenanceBadge provenance={entry.provenance} />
        <VerificationBadge state={entry.verificationState} />
        {superseded && (
          <Badge variant="outline" className="border-muted-foreground text-muted-foreground">
            superseded
          </Badge>
        )}
        {editable && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setEditOpen(true)}
            aria-label={`Edit ${entry.subject}`}
          >
            <Edit2 className="h-4 w-4" />
          </Button>
        )}
        {alreadyPromoted || justPromoted ? (
          <Badge
            variant="outline"
            className="gap-1 border-green-600/40 text-green-600"
            aria-label={`${entry.subject} is in the global layer`}
          >
            <Check className="h-3.5 w-3.5" />
            In global
          </Badge>
        ) : canPromoteToGlobal ? (
          <Button
            variant="outline"
            size="sm"
            disabled={isPromoting}
            onClick={() => onPromoteToGlobal?.(entry.id)}
            aria-label={`Promote ${entry.subject} to global`}
          >
            <Globe className="mr-1 h-3.5 w-3.5" />
            {isPromoting ? "Promoting…" : "Promote to global"}
          </Button>
        ) : null}
        {onDelete && !superseded && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={isDeleting}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => {
              if (
                window.confirm(
                  `Delete (archive) this memory entry?\n\n"${entry.subject}"\n\nIt leaves retrieval immediately; the row is archived, not destroyed.`,
                )
              ) {
                onDelete(entry.id);
              }
            }}
            aria-label={`Delete ${entry.subject}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      {deleteError && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          Delete failed: {deleteError}
        </p>
      )}
      {promoteError && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          Promote failed: {promoteError}
        </p>
      )}

      <p
        className={cn(
          "mt-2 line-clamp-3 text-sm text-muted-foreground",
          superseded && "line-through",
        )}
      >
        {entry.body}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <ConfidenceMeter confidence={entry.confidence} />
        {entry.serviceScope && <span>{entry.serviceScope}</span>}
        <span>Used {entry.usageCount} times</span>
        <span>Updated {formatDate(entry.updatedAt)}</span>
        {entry.tags.map((tag) => (
          <span key={tag} className="rounded-sm bg-muted px-1.5 py-0.5">
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-2">
        <MemoryCitationLine
          id={entry.id}
          provenance={entry.provenance}
          confidence={entry.confidence}
          sourceRefType={entry.sourceRefType}
          sourceRefId={entry.sourceRefId}
        />
      </div>

      {editable && onSave && (
        <MemoryEntryEditDialog
          entry={entry}
          open={editOpen}
          onOpenChange={setEditOpen}
          onSave={(data) => onSave(entry.id, data)}
          isSaving={isSaving}
          error={saveError}
        />
      )}
    </article>
  );
}
