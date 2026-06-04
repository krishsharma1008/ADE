import { useMemo, useState } from "react";
import type { MemoryConflictAction, MemoryConflictGroup, MemoryEntry } from "@combyne/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../../lib/utils";
import {
  ConfidenceMeter,
  MemoryCitationLine,
  ProvenanceBadge,
  VerificationBadge,
} from "./MemoryTrustBadges";

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

/**
 * Seed text for a MERGE: both conflicting bodies, attributed, separated by a
 * marker so the resolver can hand-merge. Editable before it becomes the new
 * canonical body.
 */
function seedMergeBody(entries: MemoryEntry[]): string {
  return entries
    .map((e, i) => `# Version ${i + 1} (${e.authorId ?? "unknown"} · ${formatDate(e.updatedAt)})\n${e.body}`)
    .join("\n\n---\n\n");
}

/**
 * THE first-class conflict resolver (§3.5, decision #5). Renders the conflicting
 * entries as side-by-side bordered cards (the ApprovalDetail two-column
 * precedent), PRE-HIGHLIGHTS the newest entry pushed by that user (the user's
 * exact ask — default-surface, NOT silent newest-wins), and offers three actions
 * mapped to supersededById:
 *   OVERRIDE — the selected card wins; the other(s) are superseded to it.
 *   MERGE    — a third editable Textarea seeded from BOTH bodies writes a NEW
 *              canonical entry and supersedes BOTH originals (kept for audit).
 *   EDIT     — free-edit the selected canonical body.
 */
export function MemoryConflictResolver({
  group,
  onResolve,
  isResolving,
  error,
}: {
  group: MemoryConflictGroup;
  onResolve: (payload: {
    action: MemoryConflictAction;
    canonicalEntryId?: string;
    body?: string;
  }) => void;
  isResolving?: boolean;
  error?: string | null;
}) {
  // Pre-select the newest-by-that-user entry (the user's exact ask).
  const [selectedId, setSelectedId] = useState(group.newestByThatUserId);
  const [mode, setMode] = useState<"choose" | "merge" | "edit">("choose");
  const [mergeBody, setMergeBody] = useState(() => seedMergeBody(group.entries));
  const [editBody, setEditBody] = useState(
    () => group.entries.find((e) => e.id === group.newestByThatUserId)?.body ?? "",
  );

  const selected = useMemo(
    () => group.entries.find((e) => e.id === selectedId) ?? null,
    [group.entries, selectedId],
  );

  function selectCard(id: string) {
    setSelectedId(id);
    const body = group.entries.find((e) => e.id === id)?.body ?? "";
    setEditBody(body);
  }

  return (
    <div className="space-y-4" data-conflict-subject-key={group.subjectKey}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{group.subject}</h3>
        <span className="text-xs text-muted-foreground">{group.entries.length} conflicting</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {group.entries.map((entry) => {
          const isSelected = entry.id === selectedId;
          const isNewest = entry.id === group.newestByThatUserId;
          return (
            <button
              type="button"
              key={entry.id}
              onClick={() => selectCard(entry.id)}
              data-conflict-entry={entry.id}
              data-selected={isSelected || undefined}
              data-newest-by-user={isNewest || undefined}
              className={cn(
                "flex flex-col gap-2 rounded-md border p-3 text-left transition-colors",
                isSelected
                  ? "border-primary ring-1 ring-primary bg-accent/30"
                  : "border-border hover:bg-accent/20",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <ProvenanceBadge provenance={entry.provenance} />
                <VerificationBadge state={entry.verificationState} />
                {isNewest && (
                  <span
                    className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary"
                    data-newest-badge
                  >
                    newest by user
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{entry.body}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <ConfidenceMeter confidence={entry.confidence} />
                <span>{entry.authorId ?? "unknown"}</span>
                <span>Updated {formatDate(entry.updatedAt)}</span>
              </div>
              <MemoryCitationLine
                id={entry.id}
                provenance={entry.provenance}
                confidence={entry.confidence}
                sourceRefType={entry.sourceRefType}
                sourceRefId={entry.sourceRefId}
              />
            </button>
          );
        })}
      </div>

      {mode === "merge" && (
        <div className="space-y-1.5" data-merge-editor>
          <label className="text-xs font-medium text-muted-foreground">
            Merged canonical body (seeded from both versions)
          </label>
          <Textarea value={mergeBody} onChange={(e) => setMergeBody(e.target.value)} rows={8} />
        </div>
      )}

      {mode === "edit" && (
        <div className="space-y-1.5" data-edit-editor>
          <label className="text-xs font-medium text-muted-foreground">
            Edit the canonical body
          </label>
          <Textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={8} />
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {mode === "choose" && (
          <>
            <Button
              size="sm"
              data-action="override"
              disabled={isResolving || !selected}
              onClick={() =>
                onResolve({ action: "override", canonicalEntryId: selectedId })
              }
            >
              Override (this wins)
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-action="merge-open"
              disabled={isResolving}
              onClick={() => setMode("merge")}
            >
              Merge…
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-action="edit-open"
              disabled={isResolving || !selected}
              onClick={() => setMode("edit")}
            >
              Edit…
            </Button>
          </>
        )}

        {mode === "merge" && (
          <>
            <Button
              size="sm"
              data-action="merge"
              disabled={isResolving || mergeBody.trim().length === 0}
              onClick={() => onResolve({ action: "merge", body: mergeBody.trim() })}
            >
              Write merged canonical
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("choose")} disabled={isResolving}>
              Cancel
            </Button>
          </>
        )}

        {mode === "edit" && (
          <>
            <Button
              size="sm"
              data-action="edit"
              disabled={isResolving || editBody.trim().length === 0 || !selected}
              onClick={() =>
                onResolve({ action: "edit", canonicalEntryId: selectedId, body: editBody.trim() })
              }
            >
              Save canonical
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("choose")} disabled={isResolving}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
