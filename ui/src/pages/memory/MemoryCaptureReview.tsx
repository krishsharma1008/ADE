import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryCaptureItem, UpdateMemoryEntry } from "@combyne/shared";
import { Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useCompany } from "../../context/CompanyContext";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { MemoryEntryCard } from "../../components/memory/MemoryEntryCard";

/**
 * Capture review tab (§3.3). A first-class, actionable inbox of freshly-captured
 * human-answer / pr-approval entries — promoting the old read-only "Accepted
 * Work Events" list into a Confirm / Edit / Dismiss queue. Confirm verifies the
 * entry; Edit reuses the MemoryEntryCard edit dialog; Dismiss archives it.
 */
export function MemoryCaptureReview() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const inboxQuery = useQuery({
    queryKey: queryKeys.memory.captureInbox(selectedCompanyId!),
    queryFn: () => memoryApi.listCaptureInbox(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.memory.captureInbox(selectedCompanyId!),
    });

  const confirm = useMutation({
    mutationFn: (entryId: string) => memoryApi.verifyEntry(entryId),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to confirm"),
  });

  const dismiss = useMutation({
    mutationFn: (entryId: string) =>
      memoryApi.updateEntry(entryId, { status: "archived" } as UpdateMemoryEntry),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to dismiss"),
  });

  const editEntry = useMutation({
    mutationFn: ({ entryId, data }: { entryId: string; data: UpdateMemoryEntry }) =>
      memoryApi.updateEntry(entryId, data),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to save"),
  });

  const items = inboxQuery.data ?? [];
  const isBusy = confirm.isPending || dismiss.isPending || editEntry.isPending;

  return (
    <div className="space-y-4" data-tab="capture">
      <p className="text-sm text-muted-foreground">
        Newly-captured human answers and PR approvals awaiting review. Confirm
        promotes the entry to verified; Dismiss archives it.
      </p>

      {inboxQuery.error && (
        <p className="text-sm text-destructive">
          {inboxQuery.error instanceof Error
            ? inboxQuery.error.message
            : "Failed to load capture inbox"}
        </p>
      )}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {items.length === 0 ? (
        <div className="rounded-md border border-border p-8">
          <EmptyState icon={Inbox} message="No captured answers awaiting review." />
        </div>
      ) : (
        <div className="grid gap-3">
          {items.map((item: MemoryCaptureItem) => (
            <div
              key={item.entry.id}
              className="overflow-hidden rounded-md border border-border"
              data-capture-entry={item.entry.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Source:</span>
                  {item.citation ? (
                    <Badge variant="outline" data-citation>
                      {item.citation}
                    </Badge>
                  ) : (
                    <span className="italic">no citation</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => confirm.mutate(item.entry.id)}
                    disabled={isBusy}
                  >
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => dismiss.mutate(item.entry.id)}
                    disabled={isBusy}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
              <MemoryEntryCard
                entry={item.entry}
                onSave={(entryId, data) => editEntry.mutate({ entryId, data })}
                isSaving={editEntry.isPending}
                saveError={editEntry.error instanceof Error ? editEntry.error.message : null}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
