import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MemoryEntry } from "@combyne/shared";
import { Brain } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useCompany } from "../../context/CompanyContext";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { ProvenanceBadge } from "./MemoryTrustBadges";

/**
 * MemoryPassdownPicker (PR-16 §3.8) — embedded in the issue-delegate dialog.
 *
 * A checkbox-list of VERIFIED memory entries matching the child issue's
 * serviceScope/title, letting an EM pin `curatedMemoryEntryIds[]` into the
 * delegate call (the §5.1.2 escape hatch for the weak hash ranker). The server
 * delegate route + buildPassdownPacket already accept and union these ids — the
 * pin still passes the verified-only, non-personal, same-company invariant, so a
 * pin can never launder an unverified row into the vetted packet.
 *
 * Controlled: the parent owns `selectedIds` and threads them through delegate.
 * Candidates are fetched with requireVerified (verificationState='verified') and
 * the child's serviceScope so the list is the entries actually eligible to pin.
 */
export function MemoryPassdownPicker({
  serviceScope,
  title,
  selectedIds,
  onChange,
  disabled,
}: {
  /** The child issue's service scope (narrows candidates server-side). */
  serviceScope?: string | null;
  /** The child issue's title — used to client-side rank/highlight relevant entries. */
  title?: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { selectedCompanyId } = useCompany();
  const scope = serviceScope?.trim() || undefined;

  const candidatesQuery = useQuery({
    queryKey: queryKeys.memory.candidates(selectedCompanyId!, scope),
    queryFn: () =>
      memoryApi.listEntries(selectedCompanyId!, {
        verificationState: "verified",
        ...(scope ? { serviceScope: scope } : {}),
      }),
    enabled: !!selectedCompanyId,
  });

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Client-side relevance sort: entries whose subject/body overlaps the child
  // title float to the top so the EM sees the likely-relevant facts first. The
  // server already enforced the verified/scope filter — this is ranking only.
  const candidates = useMemo(() => {
    // Mirror the buildPassdownPacket invariant: only shared/workspace entries can
    // ever be pinned (personal entries are dropped server-side), so never offer a
    // personal entry as a pickable candidate — it would be a UX dead-end and would
    // surface a private fact in the delegate dialog.
    const rows = (candidatesQuery.data ?? []).filter((e) => e.layer !== "personal");
    const needle = (title ?? "").trim().toLowerCase();
    if (!needle) return rows;
    const score = (e: MemoryEntry) =>
      [e.subject, e.body, e.serviceScope ?? "", e.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(needle)
        ? 1
        : 0;
    return [...rows].sort((a, b) => score(b) - score(a));
  }, [candidatesQuery.data, title]);

  function toggle(id: string) {
    if (selected.has(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  return (
    <div className="space-y-2" data-slot="passdown-picker">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Pin verified memory for this delegation</span>
        {selectedIds.length > 0 && (
          <span className="text-xs text-muted-foreground" data-selected-count>
            {selectedIds.length} pinned
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Pinned entries are unioned into the sub-agent&apos;s vetted context packet regardless of the
        ranker score. Only verified entries can be pinned.
      </p>

      {candidatesQuery.error && (
        <p className="text-xs text-destructive">
          {candidatesQuery.error instanceof Error
            ? candidatesQuery.error.message
            : "Failed to load candidate entries"}
        </p>
      )}

      {candidates.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          <Brain className="h-4 w-4" />
          No verified entries{scope ? ` for scope "${scope}"` : ""} to pin.
        </div>
      ) : (
        <ul className="max-h-60 divide-y divide-border overflow-auto rounded-md border border-border">
          {candidates.map((entry) => {
            const checked = selected.has(entry.id);
            return (
              <li key={entry.id} data-candidate={entry.id}>
                <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-accent/20">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(entry.id)}
                    disabled={disabled}
                    aria-label={`Pin ${entry.subject}`}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {entry.subject}
                      </span>
                      <ProvenanceBadge provenance={entry.provenance} />
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                      {entry.body}
                    </span>
                    {entry.serviceScope && (
                      <span className="mt-1 inline-block rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {entry.serviceScope}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
