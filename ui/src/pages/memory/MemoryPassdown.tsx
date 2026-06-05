import { useQuery } from "@tanstack/react-query";
import type { MemoryPassdownPacket } from "@combyne/shared";
import { PackageOpen, Link2, Pin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { useCompany } from "../../context/CompanyContext";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

/**
 * Passdown tab (PR-16 §3.1 / §3.8) — read-only audit of EM passdown packets.
 * For each recent handoff carrying a non-empty passdown manifest (stored in
 * agent_handoffs.artifactRefs), shows the child issue, complexity tier, entry
 * count, token budget, and the cited entries (with the curated/pinned marker).
 * Curation itself lives in the delegate dialog (MemoryPassdownPicker); this tab
 * is the after-the-fact record of what each delegation carried.
 */
export function MemoryPassdown() {
  const { selectedCompanyId } = useCompany();

  const packetsQuery = useQuery({
    queryKey: queryKeys.memory.passdownPackets(selectedCompanyId!),
    queryFn: () => memoryApi.listPassdownPackets(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const packets = packetsQuery.data ?? [];

  return (
    <div className="space-y-4" data-tab="passdown">
      <p className="text-sm text-muted-foreground">
        Read-only audit of the vetted context each delegation carried to a sub-agent. When a
        manager delegates an issue, a budget-trimmed slice of verified memory is pinned into the
        handoff; this is the record of what was sent.
      </p>

      {packetsQuery.error && (
        <p className="text-sm text-destructive">
          {packetsQuery.error instanceof Error
            ? packetsQuery.error.message
            : "Failed to load passdown packets"}
        </p>
      )}

      {packets.length === 0 ? (
        <div className="rounded-md border border-border p-8">
          <EmptyState icon={PackageOpen} message="No passdown packets recorded yet." />
        </div>
      ) : (
        <div className="grid gap-3">
          {packets.map((packet: MemoryPassdownPacket) => (
            <article
              key={packet.handoffId}
              className="overflow-hidden rounded-md border border-border"
              data-passdown-packet={packet.handoffId}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium" data-child-issue>
                    {packet.childIssueIdentifier ?? packet.childIssueId.slice(0, 8)}
                    {packet.childIssueTitle ? ` · ${packet.childIssueTitle}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" data-complexity>
                    {packet.complexity}
                  </Badge>
                  {packet.serviceScope && (
                    <Badge variant="secondary">{packet.serviceScope}</Badge>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
                <span data-entry-count>
                  {packet.entryCount} {packet.entryCount === 1 ? "entry" : "entries"}
                </span>
                <span data-token-budget>~{packet.estimatedTokens} tokens</span>
                <span>Delegated {formatDate(packet.createdAt)}</span>
              </div>

              {packet.items.length > 0 && (
                <ul className="divide-y divide-border border-t border-border">
                  {packet.items.map((item) => (
                    <li
                      key={item.entryId}
                      className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                      data-packet-item={item.entryId}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.subject}</span>
                      {item.curated && (
                        <Badge
                          variant="outline"
                          className="border-blue-500 text-blue-500"
                          data-curated
                        >
                          <Pin className="mr-1 h-3 w-3" />
                          pinned
                        </Badge>
                      )}
                      <Badge variant="outline">{item.layer}</Badge>
                      {item.serviceScope && (
                        <span className="text-xs text-muted-foreground">{item.serviceScope}</span>
                      )}
                      <span className="text-xs tabular-nums text-muted-foreground">
                        conf={item.confidence.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
