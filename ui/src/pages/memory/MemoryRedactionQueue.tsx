import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryEntry } from "@combyne/shared";
import { ShieldCheck } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { useCompany } from "../../context/CompanyContext";
import { memoryApi, type MemoryRedactionResolveAction } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { MemoryRedactionCard } from "../../components/memory/MemoryRedactionCard";

/**
 * Redaction queue tab (PR-15 §3.6 — the blocking redact-before-embed gate).
 * Board-gated server-side. Lists `needs_review` entries held OUT of retrieval;
 * each body is masked by default with a Reveal toggle. Approve-as-clean clears
 * the quarantine to verified (re-enters retrieval); Keep-redacted archives it.
 */
export function MemoryRedactionQueue() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const queueQuery = useQuery({
    queryKey: queryKeys.memory.redactionQueue(selectedCompanyId!),
    queryFn: () => memoryApi.listRedactionQueue(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const resolve = useMutation({
    mutationFn: ({ entryId, action }: { entryId: string; action: MemoryRedactionResolveAction }) =>
      memoryApi.resolveRedaction(entryId, action),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.memory.redactionQueue(selectedCompanyId!),
      });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to resolve"),
  });

  const items = queueQuery.data ?? [];

  return (
    <div className="space-y-4" data-tab="redaction">
      <p className="text-sm text-muted-foreground">
        Entries quarantined to <code className="text-xs">needs_review</code> because a credential
        shape was detected (or a human flagged them). They are held out of retrieval. The body is
        masked by default — Reveal it, then Approve-as-clean (re-enters retrieval) or Keep-redacted
        (archived).
      </p>

      {queueQuery.error && (
        <p className="text-sm text-destructive">
          {queueQuery.error instanceof Error
            ? queueQuery.error.message
            : "Failed to load redaction queue"}
        </p>
      )}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {items.length === 0 ? (
        <div className="rounded-md border border-border p-8">
          <EmptyState icon={ShieldCheck} message="No entries awaiting redaction review." />
        </div>
      ) : (
        <div className="grid gap-3">
          {items.map((entry: MemoryEntry) => (
            <MemoryRedactionCard
              key={entry.id}
              entry={entry}
              onResolve={(entryId, action) => resolve.mutate({ entryId, action })}
              isResolving={resolve.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
