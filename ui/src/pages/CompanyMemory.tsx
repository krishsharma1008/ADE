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
import { databaseApi } from "../api/database";
import { ApiError } from "../api/client";
import { MemoryBrowse } from "./memory/MemoryBrowse";
import { MemoryCaptureReview } from "./memory/MemoryCaptureReview";
import { MemoryVerifyQueue } from "./memory/MemoryVerifyQueue";
import { MemoryConflicts } from "./memory/MemoryConflicts";
import { MemoryRedactionQueue } from "./memory/MemoryRedactionQueue";
import { MemoryQuestions } from "./memory/MemoryQuestions";
import { MemoryPassdown } from "./memory/MemoryPassdown";
import { MemoryDatabase } from "./memory/MemoryDatabase";
import { MemorySetup } from "./memory/MemorySetup";

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

// Path-driven tabs (mirrors Approvals.tsx). PR-13 shipped Browse; PR-14 added the
// capture/verify/conflicts queues; PR-15 adds the redaction queue (board) and the
// database/setup admin tabs (instance-admin only — hidden for non-admins); PR-16
// adds the questions (ask-don't-hallucinate loop) + passdown (EM packet audit)
// read-only tabs, completing the eight-flow set.
const TABS = [
  "browse",
  "capture",
  "verify",
  "conflicts",
  "redaction",
  "questions",
  "passdown",
  "database",
  "setup",
] as const;
type MemoryTab = (typeof TABS)[number];

// Tabs gated to instance-admins. They are hidden from the tab bar for non-admins
// AND their endpoints are instance-admin gated server-side (defense in depth).
const ADMIN_TABS: ReadonlySet<MemoryTab> = new Set(["database", "setup"]);

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

  // Instance-admin probe: the context-DB status endpoint is instance-admin gated
  // and 403s for everyone else, so a successful fetch == this user can manage the
  // instance. We use it only to decide whether to surface the Database/Setup
  // admin tabs (the endpoints enforce the gate regardless). A 403 is a definitive
  // "not admin" — never retried.
  const adminProbe = useQuery({
    queryKey: queryKeys.contextDatabase.status,
    queryFn: () => databaseApi.getStatus(),
    retry: (_count, error) => !(error instanceof ApiError && error.status === 403),
    staleTime: 5 * 60 * 1000,
  });
  // Fail CLOSED: admin tabs stay hidden until the gated probe definitively
  // succeeds. Loading and transient (non-403) errors keep this false, so the
  // UI gate matches the server gate and the admin tabs never flash for a
  // non-admin. (The endpoints are server-gated regardless; this is UX hygiene.)
  const isInstanceAdmin = adminProbe.isSuccess;

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to view shared memory." />;
  }

  // Never render an admin-only tab's body for a non-admin, even via a deep link.
  const effectiveTab: MemoryTab = ADMIN_TABS.has(tab) && !isInstanceAdmin ? "browse" : tab;

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

      <Tabs value={effectiveTab} onValueChange={(v) => navigate(`/memory/${v}`)}>
        <PageTabBar
          items={[
            { value: "browse", label: "Browse" },
            { value: "capture", label: "Capture" },
            { value: "verify", label: "Verify" },
            { value: "conflicts", label: "Conflicts" },
            { value: "redaction", label: "Redaction" },
            { value: "questions", label: "Questions" },
            { value: "passdown", label: "Passdown" },
            ...(isInstanceAdmin
              ? [
                  { value: "database", label: "Database" },
                  { value: "setup", label: "Setup" },
                ]
              : []),
          ]}
        />
      </Tabs>

      {effectiveTab === "browse" && <MemoryBrowse />}
      {effectiveTab === "capture" && <MemoryCaptureReview />}
      {effectiveTab === "verify" && <MemoryVerifyQueue />}
      {effectiveTab === "conflicts" && <MemoryConflicts />}
      {effectiveTab === "redaction" && <MemoryRedactionQueue />}
      {effectiveTab === "questions" && <MemoryQuestions />}
      {effectiveTab === "passdown" && <MemoryPassdown />}
      {effectiveTab === "database" && <MemoryDatabase />}
      {effectiveTab === "setup" && <MemorySetup />}

      {effectiveTab === "browse" && (
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
