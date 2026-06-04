import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryVerifyItem } from "@combyne/shared";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useCompany } from "../../context/CompanyContext";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { MemoryEntryCard } from "../../components/memory/MemoryEntryCard";

/**
 * Verify queue tab (§3.4, hybrid SLA / decision #3). Two streams, one list:
 *  (a) agent-claim entries with their distinct-issue reuse count — a board user
 *      weighs the reuse evidence and clicks Verify (POST /memory/entries/:id/verify);
 *  (b) pending promotion proposals — Approve / Reject via the existing decide route.
 */
export function MemoryVerifyQueue() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const queueQuery = useQuery({
    queryKey: queryKeys.memory.verifyQueue(selectedCompanyId!),
    queryFn: () => memoryApi.listVerifyQueue(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.memory.verifyQueue(selectedCompanyId!),
    });

  const verify = useMutation({
    mutationFn: (entryId: string) => memoryApi.verifyEntry(entryId),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to verify"),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "rejected" }) =>
      memoryApi.decidePromotion(id, decision),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to decide"),
  });

  const items = queueQuery.data ?? [];
  const isBusy = verify.isPending || decide.isPending;

  return (
    <div className="space-y-4" data-tab="verify">
      <p className="text-sm text-muted-foreground">
        Agent claims with reuse evidence and pending promotion proposals. Verify
        stamps the claim verified; promotions are approved into shared memory.
      </p>

      {queueQuery.error && (
        <p className="text-sm text-destructive">
          {queueQuery.error instanceof Error
            ? queueQuery.error.message
            : "Failed to load verify queue"}
        </p>
      )}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {items.length === 0 ? (
        <div className="rounded-md border border-border p-8">
          <EmptyState icon={ShieldCheck} message="Nothing awaiting verification." />
        </div>
      ) : (
        <div className="grid gap-3">
          {items.map((item: MemoryVerifyItem) => {
            if (item.kind === "agent-claim") {
              return (
                <div
                  key={item.entry.id}
                  className="overflow-hidden rounded-md border border-border"
                  data-verify-claim={item.entry.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
                    <Badge variant="outline" data-reuse-count>
                      Reused across {item.distinctIssueReuse} distinct issue
                      {item.distinctIssueReuse === 1 ? "" : "s"}
                    </Badge>
                    <Button
                      size="sm"
                      onClick={() => verify.mutate(item.entry.id)}
                      disabled={isBusy}
                      className="bg-green-600 hover:bg-green-700 text-white"
                    >
                      Verify
                    </Button>
                  </div>
                  <MemoryEntryCard entry={item.entry} />
                </div>
              );
            }
            const promotion = item.promotion;
            return (
              <div
                key={promotion.id}
                className="rounded-md border border-border p-3"
                data-verify-promotion={promotion.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">promotion</Badge>
                  <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
                    {promotion.proposedSubject}
                  </h3>
                  <Button
                    size="sm"
                    onClick={() => decide.mutate({ id: promotion.id, decision: "approved" })}
                    disabled={isBusy}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => decide.mutate({ id: promotion.id, decision: "rejected" })}
                    disabled={isBusy}
                  >
                    Reject
                  </Button>
                </div>
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                  {promotion.proposedBody}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
