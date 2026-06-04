import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useLocation } from "@/lib/router";
import { Brain, GitPullRequest } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/EmptyState";
import { PageTabBar } from "../components/PageTabBar";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { memoryApi } from "../api/memory";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { MemoryBrowse } from "./memory/MemoryBrowse";
import { MemoryCaptureReview } from "./memory/MemoryCaptureReview";
import { MemoryVerifyQueue } from "./memory/MemoryVerifyQueue";
import { MemoryConflicts } from "./memory/MemoryConflicts";

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

// Path-driven tabs (mirrors Approvals.tsx). PR-13 shipped Browse; PR-14 adds the
// capture/verify/conflicts queues. Later slices (PR-15..16) add setup/redaction/
// questions/passdown alongside them.
const TABS = ["browse", "capture", "verify", "conflicts"] as const;
type MemoryTab = (typeof TABS)[number];

function resolveTab(segment: string | undefined): MemoryTab {
  return (TABS as readonly string[]).includes(segment ?? "") ? (segment as MemoryTab) : "browse";
}

export function CompanyMemory() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const location = useLocation();

  // The flat /memory route (no tab segment) renders Browse without redirecting,
  // so existing deep links and the sidebar item keep working.
  const lastSegment = location.pathname.split("/").filter(Boolean).pop();
  const tab = resolveTab(lastSegment === "memory" ? undefined : lastSegment);

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
  }, [setBreadcrumbs]);

  const workspaceQuery = useQuery({
    queryKey: queryKeys.memory.entries(selectedCompanyId!, "workspace"),
    queryFn: () => memoryApi.listEntries(selectedCompanyId!, { layer: "workspace" }),
    enabled: !!selectedCompanyId,
  });
  const sharedQuery = useQuery({
    queryKey: queryKeys.memory.entries(selectedCompanyId!, "shared"),
    queryFn: () => memoryApi.listEntries(selectedCompanyId!, { layer: "shared" }),
    enabled: !!selectedCompanyId,
  });
  const eventsQuery = useQuery({
    queryKey: queryKeys.memory.acceptedWork(selectedCompanyId!),
    queryFn: () => memoryApi.listAcceptedWorkEvents(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to view shared memory." />;
  }

  const pendingEvents = (eventsQuery.data ?? []).filter(
    (event) => event.memoryStatus === "pending",
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5">
      <div>
        <h1 className="text-xl font-bold">Company Memory</h1>
        <p className="text-sm text-muted-foreground">
          Shared context stored in the central database for future agent work.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground">Workspace entries</div>
          <div className="mt-1 text-2xl font-bold">{workspaceQuery.data?.length ?? 0}</div>
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground">Shared entries</div>
          <div className="mt-1 text-2xl font-bold">{sharedQuery.data?.length ?? 0}</div>
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground">Accepted work pending</div>
          <div className="mt-1 text-2xl font-bold">{pendingEvents.length}</div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => navigate(`/memory/${v}`)}>
        <PageTabBar
          items={[
            { value: "browse", label: "Browse" },
            { value: "capture", label: "Capture" },
            { value: "verify", label: "Verify" },
            { value: "conflicts", label: "Conflicts" },
          ]}
        />
      </Tabs>

      {tab === "browse" && <MemoryBrowse />}
      {tab === "capture" && <MemoryCaptureReview />}
      {tab === "verify" && <MemoryVerifyQueue />}
      {tab === "conflicts" && <MemoryConflicts />}

      {tab === "browse" && (
      <section>
        <div className="mb-2 flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Accepted Work Events</h2>
          <span className="text-xs text-muted-foreground">{eventsQuery.data?.length ?? 0}</span>
        </div>
        <div className="overflow-hidden rounded-md border border-border">
          {(eventsQuery.data ?? []).slice(0, 10).map((event) => (
            <div
              key={event.id}
              className="flex items-start gap-3 border-b border-border p-3 last:border-b-0"
            >
              <GitPullRequest className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {event.repo}#{event.pullNumber} · {event.title}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn(
                      event.memoryStatus === "pending" && "border-yellow-500 text-yellow-500",
                    )}
                  >
                    {event.memoryStatus}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Detected {formatDate(event.detectedAt)} · Issue {event.issueId ?? "not linked"}
                </div>
              </div>
            </div>
          ))}
          {(eventsQuery.data ?? []).length === 0 && (
            <div className="p-8">
              <EmptyState icon={GitPullRequest} message="No accepted work events yet." />
            </div>
          )}
        </div>
      </section>
      )}
    </div>
  );
}
