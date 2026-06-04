import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryEntry, UpdateMemoryEntry } from "@combyne/shared";
import { Brain, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { useCompany } from "../../context/CompanyContext";
import { memoryApi, type MemoryEntryFilters } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { MemoryEntryCard } from "../../components/memory/MemoryEntryCard";

const ANY = "__any__";

interface FilterState {
  layer: string;
  kind: string;
  provenance: string;
  verificationState: string;
  confidence: string;
  serviceScope: string;
  age: string;
}

const INITIAL_FILTERS: FilterState = {
  layer: ANY,
  kind: ANY,
  provenance: ANY,
  verificationState: ANY,
  confidence: ANY,
  serviceScope: "",
  age: ANY,
};

/** A single labelled Select in the filter row. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-auto min-w-[8rem]">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{label}: any</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function MemoryBrowse() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);

  // Translate the UI filter state into the API filter shape. `__any__` and the
  // blank service-scope field mean "no constraint" so they are dropped.
  const apiFilters: MemoryEntryFilters = useMemo(() => {
    const f: MemoryEntryFilters = {};
    if (filters.layer !== ANY) f.layer = filters.layer as MemoryEntryFilters["layer"];
    if (filters.provenance !== ANY) {
      f.provenance = filters.provenance as MemoryEntryFilters["provenance"];
    }
    if (filters.verificationState !== ANY) {
      f.verificationState = filters.verificationState as MemoryEntryFilters["verificationState"];
    }
    if (filters.confidence !== ANY) f.minConfidence = Number(filters.confidence);
    if (filters.serviceScope.trim()) f.serviceScope = filters.serviceScope.trim();
    if (filters.age !== ANY) f.age = Number(filters.age);
    return f;
  }, [filters]);

  const entriesQuery = useQuery({
    queryKey: queryKeys.memory.browse(selectedCompanyId!, apiFilters),
    queryFn: () => memoryApi.listEntries(selectedCompanyId!, apiFilters),
    enabled: !!selectedCompanyId,
  });

  const updateEntry = useMutation({
    mutationFn: ({ entryId, data }: { entryId: string; data: UpdateMemoryEntry }) =>
      memoryApi.updateEntry(entryId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memory", selectedCompanyId, "browse"] });
    },
  });

  // `kind` has no server-side filter param, so it is applied client-side along
  // with the free-text search.
  const filtered = useMemo(() => {
    const rows = entriesQuery.data ?? [];
    const needle = query.trim().toLowerCase();
    return rows.filter((entry: MemoryEntry) => {
      if (filters.kind !== ANY && entry.kind !== filters.kind) return false;
      if (!needle) return true;
      return [
        entry.subject,
        entry.body,
        entry.kind,
        entry.layer,
        entry.serviceScope ?? "",
        entry.tags.join(" "),
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [entriesQuery.data, filters.kind, query]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to browse memory." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory..."
            className="pl-8"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            label="Layer"
            value={filters.layer}
            onChange={(v) => setFilters({ ...filters, layer: v })}
            options={[
              { value: "workspace", label: "workspace" },
              { value: "personal", label: "personal" },
              { value: "shared", label: "shared" },
            ]}
          />
          <FilterSelect
            label="Kind"
            value={filters.kind}
            onChange={(v) => setFilters({ ...filters, kind: v })}
            options={[
              { value: "fact", label: "fact" },
              { value: "runbook", label: "runbook" },
              { value: "convention", label: "convention" },
              { value: "pointer", label: "pointer" },
              { value: "note", label: "note" },
            ]}
          />
          <FilterSelect
            label="Provenance"
            value={filters.provenance}
            onChange={(v) => setFilters({ ...filters, provenance: v })}
            options={[
              { value: "human-answer", label: "human answer" },
              { value: "pr-approval", label: "PR approval" },
              { value: "verified-summary", label: "verified summary" },
              { value: "agent-claim", label: "agent claim" },
              { value: "system", label: "system" },
            ]}
          />
          <FilterSelect
            label="Verification"
            value={filters.verificationState}
            onChange={(v) => setFilters({ ...filters, verificationState: v })}
            options={[
              { value: "verified", label: "verified" },
              { value: "unverified", label: "unverified" },
              { value: "needs_review", label: "needs review" },
            ]}
          />
          <FilterSelect
            label="Confidence"
            value={filters.confidence}
            onChange={(v) => setFilters({ ...filters, confidence: v })}
            options={[
              { value: "0.7", label: "high (≥0.7)" },
              { value: "0.4", label: "medium (≥0.4)" },
              { value: "0", label: "any (≥0)" },
            ]}
          />
          <FilterSelect
            label="Age"
            value={filters.age}
            onChange={(v) => setFilters({ ...filters, age: v })}
            options={[
              { value: "7", label: "last 7 days" },
              { value: "30", label: "last 30 days" },
              { value: "90", label: "last 90 days" },
            ]}
          />
          <Input
            value={filters.serviceScope}
            onChange={(e) => setFilters({ ...filters, serviceScope: e.target.value })}
            placeholder="Service scope"
            className="h-8 w-auto min-w-[8rem] text-sm"
          />
        </div>
      </div>

      {entriesQuery.error && (
        <p className="text-sm text-destructive">
          {entriesQuery.error instanceof Error
            ? entriesQuery.error.message
            : "Failed to load memory entries"}
        </p>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-md border border-border p-8">
          <EmptyState icon={Brain} message="No matching memory entries." />
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          {filtered.map((entry) => (
            <MemoryEntryCard
              key={entry.id}
              entry={entry}
              onSave={(entryId, data) => updateEntry.mutate({ entryId, data })}
              isSaving={updateEntry.isPending}
              saveError={
                updateEntry.error instanceof Error ? updateEntry.error.message : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
