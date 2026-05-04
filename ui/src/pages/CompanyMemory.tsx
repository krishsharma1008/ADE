import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryEntry, MemoryKind, MemoryStatus, UpdateMemoryEntry } from "@combyne/shared";
import { Brain, Check, Edit2, GitPullRequest, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { useCompany } from "../context/CompanyContext";
import { memoryApi } from "../api/memory";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

type MemoryDraft = {
  subject: string;
  body: string;
  kind: MemoryKind;
  status: MemoryStatus;
  serviceScope: string;
  source: string;
  ttlDays: string;
  tags: string;
};

function draftFromEntry(entry: MemoryEntry): MemoryDraft {
  return {
    subject: entry.subject,
    body: entry.body,
    kind: entry.kind,
    status: entry.status,
    serviceScope: entry.serviceScope ?? "",
    source: entry.source ?? "",
    ttlDays: entry.ttlDays == null ? "" : String(entry.ttlDays),
    tags: entry.tags.join(", "),
  };
}

function payloadFromDraft(draft: MemoryDraft): UpdateMemoryEntry {
  const ttl = draft.ttlDays.trim();
  return {
    subject: draft.subject.trim(),
    body: draft.body.trim(),
    kind: draft.kind,
    status: draft.status,
    serviceScope: draft.serviceScope.trim() || null,
    source: draft.source.trim() || null,
    ttlDays: ttl ? Number(ttl) : null,
    tags: draft.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
}

export function CompanyMemory() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemoryDraft | null>(null);

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
  const updateEntry = useMutation({
    mutationFn: ({ entryId, data }: { entryId: string; data: UpdateMemoryEntry }) =>
      memoryApi.updateEntry(entryId, data),
    onSuccess: async () => {
      if (selectedCompanyId) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.memory.entries(selectedCompanyId, "workspace"),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.memory.entries(selectedCompanyId, "shared"),
          }),
        ]);
      }
      setEditingId(null);
      setDraft(null);
    },
  });

  const entries = useMemo(
    () => [...(workspaceQuery.data ?? []), ...(sharedQuery.data ?? [])],
    [sharedQuery.data, workspaceQuery.data],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      [
        entry.subject,
        entry.body,
        entry.kind,
        entry.layer,
        entry.serviceScope ?? "",
        entry.tags.join(" "),
      ].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [entries, query]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to view shared memory." />;
  }

  const pendingEvents = (eventsQuery.data ?? []).filter((event) => event.memoryStatus === "pending");
  const startEdit = (entry: MemoryEntry) => {
    setEditingId(entry.id);
    setDraft(draftFromEntry(entry));
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };
  const saveEdit = (entry: MemoryEntry) => {
    if (!draft) return;
    updateEntry.mutate({ entryId: entry.id, data: payloadFromDraft(draft) });
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold">Company Memory</h1>
          <p className="text-sm text-muted-foreground">
            Shared context stored in the central database for future agent work.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memory..."
            className="pl-8"
          />
        </div>
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

      <section>
        <div className="mb-2 flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Active Memory</h2>
          <span className="text-xs text-muted-foreground">{filtered.length}</span>
        </div>
        {filtered.length === 0 ? (
          <div className="rounded-md border border-border p-8">
            <EmptyState icon={Brain} message="No matching company memory." />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            {filtered.map((entry) => {
              const isEditing = editingId === entry.id;
              return (
              <article
                key={entry.id}
                className="border-b border-border p-3 last:border-b-0 hover:bg-accent/20"
              >
                {isEditing && draft ? (
                  <div className="space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        value={draft.subject}
                        onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                        placeholder="Memory subject"
                        className="sm:flex-1"
                      />
                      <Select
                        value={draft.kind}
                        onValueChange={(value) => setDraft({ ...draft, kind: value as MemoryKind })}
                      >
                        <SelectTrigger className="sm:w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["fact", "runbook", "convention", "pointer", "note"].map((kind) => (
                            <SelectItem key={kind} value={kind}>{kind}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={draft.status}
                        onValueChange={(value) => setDraft({ ...draft, status: value as MemoryStatus })}
                      >
                        <SelectTrigger className="sm:w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["active", "archived", "deprecated"].map((status) => (
                            <SelectItem key={status} value={status}>{status}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Textarea
                      value={draft.body}
                      onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                      placeholder="Memory body"
                      rows={5}
                    />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        value={draft.tags}
                        onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                        placeholder="Tags, comma-separated"
                      />
                      <Input
                        value={draft.serviceScope}
                        onChange={(event) => setDraft({ ...draft, serviceScope: event.target.value })}
                        placeholder="Service scope"
                      />
                      <Input
                        value={draft.source}
                        onChange={(event) => setDraft({ ...draft, source: event.target.value })}
                        placeholder="Source"
                      />
                      <Input
                        value={draft.ttlDays}
                        onChange={(event) => setDraft({ ...draft, ttlDays: event.target.value.replace(/[^\d]/g, "") })}
                        placeholder="TTL days"
                        inputMode="numeric"
                      />
                    </div>
                    {updateEntry.error && (
                      <div className="text-xs text-destructive">
                        {updateEntry.error instanceof Error
                          ? updateEntry.error.message
                          : "Failed to update memory entry"}
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={updateEntry.isPending}>
                        <X className="h-4 w-4" />
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => saveEdit(entry)}
                        disabled={updateEntry.isPending || !draft.subject.trim() || !draft.body.trim()}
                      >
                        <Check className="h-4 w-4" />
                        {updateEntry.isPending ? "Saving..." : "Save"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{entry.subject}</h3>
                      <Badge variant={entry.layer === "shared" ? "default" : "secondary"}>
                        {entry.layer}
                      </Badge>
                      <Badge variant="outline">{entry.kind}</Badge>
                      {entry.status !== "active" && <Badge variant="outline">{entry.status}</Badge>}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => startEdit(entry)}
                        aria-label={`Edit ${entry.subject}`}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{entry.body}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {entry.serviceScope && <span>{entry.serviceScope}</span>}
                      <span>Used {entry.usageCount} times</span>
                      <span>Updated {formatDate(entry.updatedAt)}</span>
                      {entry.tags.map((tag) => (
                        <span key={tag} className="rounded-sm bg-muted px-1.5 py-0.5">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </article>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Accepted Work Events</h2>
          <span className="text-xs text-muted-foreground">{eventsQuery.data?.length ?? 0}</span>
        </div>
        <div className="overflow-hidden rounded-md border border-border">
          {(eventsQuery.data ?? []).slice(0, 10).map((event) => (
            <div key={event.id} className="flex items-start gap-3 border-b border-border p-3 last:border-b-0">
              <GitPullRequest className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {event.repo}#{event.pullNumber} · {event.title}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn(event.memoryStatus === "pending" && "border-yellow-500 text-yellow-500")}
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
    </div>
  );
}
