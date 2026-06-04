import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryConflictAction, MemoryConflictGroup } from "@combyne/shared";
import { GitMerge } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { useCompany } from "../../context/CompanyContext";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { MemoryConflictResolver } from "../../components/memory/MemoryConflictResolver";

/**
 * Conflicts tab (§3.5) — THE first-class user ask (decision #5). Lists detected
 * conflicts (subjectKey groups with >1 distinct human-answer body) and opens the
 * MemoryConflictResolver per group. Labeled "Detected conflicts" because the
 * subjectKey key is conservative and under-reports paraphrases.
 */
export function MemoryConflicts() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const conflictsQuery = useQuery({
    queryKey: queryKeys.memory.conflicts(selectedCompanyId!),
    queryFn: () => memoryApi.listConflicts(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const resolve = useMutation({
    mutationFn: ({
      subjectKey,
      payload,
    }: {
      subjectKey: string;
      payload: { action: MemoryConflictAction; canonicalEntryId?: string; body?: string };
    }) => memoryApi.resolveConflict(selectedCompanyId!, subjectKey, payload),
    onSuccess: () => {
      setActiveKey(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.memory.conflicts(selectedCompanyId!),
      });
      queryClient.invalidateQueries({ queryKey: ["memory", selectedCompanyId, "browse"] });
    },
  });

  const groups = conflictsQuery.data ?? [];

  return (
    <div className="space-y-4" data-tab="conflicts">
      <p className="text-sm text-muted-foreground">
        Detected conflicts — subjects with disagreeing human answers. The newest
        answer that user pushed is pre-highlighted. Resolving may take up to the
        prompt-cache TTL to reach running agents.
      </p>

      {conflictsQuery.error && (
        <p className="text-sm text-destructive">
          {conflictsQuery.error instanceof Error
            ? conflictsQuery.error.message
            : "Failed to load conflicts"}
        </p>
      )}

      {groups.length === 0 ? (
        <div className="rounded-md border border-border p-8">
          <EmptyState icon={GitMerge} message="No detected conflicts." />
        </div>
      ) : (
        <div className="grid gap-3">
          {groups.map((group: MemoryConflictGroup) => {
            const isActive = activeKey === group.subjectKey;
            return (
              <div
                key={group.subjectKey}
                className="rounded-md border border-border p-3"
                data-conflict-group={group.subjectKey}
              >
                {isActive ? (
                  <MemoryConflictResolver
                    group={group}
                    isResolving={resolve.isPending}
                    error={resolve.error instanceof Error ? resolve.error.message : null}
                    onResolve={(payload) =>
                      resolve.mutate({ subjectKey: group.subjectKey, payload })
                    }
                  />
                ) : (
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 text-left"
                    onClick={() => setActiveKey(group.subjectKey)}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {group.subject}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {group.entries.length} conflicting · resolve
                    </span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
