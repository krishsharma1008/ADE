import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agentsApi,
  type AgentContextBudgetRun,
  type AgentSummaryRow,
} from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { formatTokens, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown, ChevronRight, Settings } from "lucide-react";
import type { Agent } from "@combyne/shared";

interface Props {
  agent: Agent;
  companyId?: string;
}

interface SummarizerConfig {
  enabled?: boolean;
  model?: string;
  maxCostUsd?: number;
  minTriggerTokensStanding?: number;
  minTriggerTokensWorking?: number;
}

function readSummarizerConfig(agent: Agent): SummarizerConfig {
  const cfg = agent.adapterConfig as Record<string, unknown> | null | undefined;
  const summarizer = cfg && typeof cfg === "object" ? cfg.summarizer : null;
  if (!summarizer || typeof summarizer !== "object") return {};
  const s = summarizer as Record<string, unknown>;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : undefined,
    model: typeof s.model === "string" ? s.model : undefined,
    maxCostUsd: typeof s.maxCostUsd === "number" ? s.maxCostUsd : undefined,
    minTriggerTokensStanding:
      typeof s.minTriggerTokensStanding === "number" ? s.minTriggerTokensStanding : undefined,
    minTriggerTokensWorking:
      typeof s.minTriggerTokensWorking === "number" ? s.minTriggerTokensWorking : undefined,
  };
}

function TokenBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-cyan-500/70"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-16 text-right tabular-nums text-muted-foreground">
        {formatTokens(value)}
      </span>
    </div>
  );
}

function LatestRunBreakdown({ run }: { run: AgentContextBudgetRun }) {
  const pb = run.promptBudgetJson;
  if (!pb) {
    return (
      <p className="text-xs text-muted-foreground">
        No budget telemetry for this run.
      </p>
    );
  }
  const composer = pb.composer;
  const sections = composer?.sections ?? [];
  const max =
    sections.length > 0 ? Math.max(...sections.map((s) => s.tokens), 1) : 1;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        {typeof pb.estimatedInputTokens === "number" && (
          <span>est {formatTokens(pb.estimatedInputTokens)}</span>
        )}
        {typeof pb.actualInputTokens === "number" && (
          <span>actual {formatTokens(pb.actualInputTokens)}</span>
        )}
        {pb.tokenizerFamily && <span>family {pb.tokenizerFamily}</span>}
        {typeof pb.calibrationRatio === "number" && (
          <span>ratio {pb.calibrationRatio.toFixed(2)}</span>
        )}
        {typeof pb.cacheHit === "boolean" && (
          <span
            className={
              pb.cacheHit ? "text-green-600 dark:text-green-400" : "text-muted-foreground"
            }
          >
            cache {pb.cacheHit ? "hit" : "miss"}
          </span>
        )}
      </div>
      {sections.length > 0 ? (
        <div className="space-y-1">
          {sections.map((s) => (
            <TokenBar
              key={s.name}
              label={`${s.name}${s.truncated ? " ✂" : ""}`}
              value={s.tokens}
              max={max}
            />
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">
          No per-section breakdown (composer may be disabled).
        </p>
      )}
      {composer?.dropped && composer.dropped.length > 0 && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400">
          dropped: {composer.dropped.join(", ")}
        </p>
      )}
    </div>
  );
}

function RunList({ runs }: { runs: AgentContextBudgetRun[] }) {
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground">No runs with budget telemetry yet.</p>;
  }
  const max = Math.max(
    ...runs
      .map((r) => r.promptBudgetJson?.composer?.totalTokens ?? r.promptBudgetJson?.estimatedInputTokens ?? 0),
    1,
  );
  return (
    <div className="space-y-1">
      {runs.map((r) => {
        const total =
          r.promptBudgetJson?.composer?.totalTokens ??
          r.promptBudgetJson?.estimatedInputTokens ??
          0;
        return (
          <div key={r.id} className="flex items-center gap-2 text-[10px]">
            <span className="w-20 shrink-0 text-muted-foreground tabular-nums">
              {relativeTime(r.createdAt)}
            </span>
            <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-500/50"
                style={{ width: `${Math.min(100, (total / max) * 100)}%` }}
              />
            </div>
            <span className="w-14 text-right tabular-nums text-muted-foreground">
              {formatTokens(total)}
            </span>
            <span
              className={
                r.status === "succeeded"
                  ? "w-16 text-right text-green-600 dark:text-green-400"
                  : r.status === "failed" || r.status === "timed_out"
                    ? "w-16 text-right text-red-600 dark:text-red-400"
                    : "w-16 text-right text-muted-foreground"
              }
            >
              {r.status}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SummaryRows({ rows }: { rows: AgentSummaryRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground">
        No summaries yet. They'll appear here after the summarizer runs.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 text-[10px]">
          <span
            className={
              r.scopeKind === "standing"
                ? "w-16 text-blue-600 dark:text-blue-400"
                : "w-16 text-purple-600 dark:text-purple-400"
            }
          >
            {r.scopeKind}
          </span>
          <span className="text-muted-foreground tabular-nums">
            cutoff {r.cutoffSeq}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {formatTokens(r.sourceInputTokens ?? 0)} in → {formatTokens(r.outputTokens ?? 0)} out
          </span>
          <span className="text-muted-foreground">{r.summarizerModel}</span>
          <span className="ml-auto text-muted-foreground tabular-nums">
            {relativeTime(r.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

function SummarizerSettings({ agent, companyId }: Props) {
  const [draft, setDraft] = useState<SummarizerConfig>(() => readSummarizerConfig(agent));
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (next: SummarizerConfig) => {
      const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const merged = { ...existing, summarizer: { ...(existing.summarizer as object | undefined), ...next } };
      return agentsApi.update(agent.id, { adapterConfig: merged }, companyId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    },
  });

  const save = () => mutation.mutate(draft);

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <div className="flex items-center gap-2">
        <Checkbox
          id="summarizer-enabled"
          checked={draft.enabled === true}
          onCheckedChange={(v) => setDraft({ ...draft, enabled: v === true })}
        />
        <label htmlFor="summarizer-enabled" className="text-xs">
          Enable automatic summarization for this agent
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <label className="space-y-1">
          <span className="text-muted-foreground">Model override</span>
          <Input
            value={draft.model ?? ""}
            placeholder="e.g. claude-haiku-4-5"
            onChange={(e) => setDraft({ ...draft, model: e.target.value || undefined })}
            className="h-7 text-xs"
          />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">Max cost per call (USD)</span>
          <Input
            type="number"
            step="0.05"
            min="0"
            value={draft.maxCostUsd ?? ""}
            placeholder="0.50"
            onChange={(e) =>
              setDraft({
                ...draft,
                maxCostUsd: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="h-7 text-xs"
          />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">Standing trigger (tokens)</span>
          <Input
            type="number"
            min="0"
            value={draft.minTriggerTokensStanding ?? ""}
            placeholder="50000"
            onChange={(e) =>
              setDraft({
                ...draft,
                minTriggerTokensStanding:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="h-7 text-xs"
          />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">Working trigger (tokens)</span>
          <Input
            type="number"
            min="0"
            value={draft.minTriggerTokensWorking ?? ""}
            placeholder="20000"
            onChange={(e) =>
              setDraft({
                ...draft,
                minTriggerTokensWorking:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="h-7 text-xs"
          />
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        {mutation.isError && (
          <span className="text-[10px] text-red-500">
            {(mutation.error as Error)?.message ?? "save failed"}
          </span>
        )}
        {mutation.isSuccess && (
          <span className="text-[10px] text-green-500">saved</span>
        )}
        <Button size="sm" variant="outline" onClick={save} disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function AgentContextBudgetCard({ agent, companyId }: Props) {
  const [showSettings, setShowSettings] = useState(false);
  const runsQuery = useQuery({
    queryKey: ["agent-context-budget", agent.id],
    queryFn: () => agentsApi.contextBudget(agent.id, companyId, 20),
    staleTime: 30_000,
  });
  const summariesQuery = useQuery({
    queryKey: ["agent-summaries", agent.id],
    queryFn: () => agentsApi.summaries(agent.id, companyId, 10),
    staleTime: 30_000,
  });

  const latestRun = useMemo(
    () => runsQuery.data?.find((r) => !!r.promptBudgetJson) ?? null,
    [runsQuery.data],
  );

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">Context budget</h3>
          <span className="text-[10px] text-muted-foreground/60">
            Tokens per run, per section, plus summarizer activity.
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowSettings((v) => !v)}
          className="h-7 px-2 text-[10px]"
        >
          {showSettings ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <Settings className="h-3 w-3 ml-1" />
          <span className="ml-1">Summarizer</span>
        </Button>
      </div>

      {runsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : latestRun ? (
        <>
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">Latest run breakdown</p>
            <LatestRunBreakdown run={latestRun} />
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">Recent runs</p>
            <RunList runs={runsQuery.data ?? []} />
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No budget telemetry yet. It populates as this agent runs.
        </p>
      )}

      <div>
        <p className="text-[10px] text-muted-foreground mb-1">Recent summaries</p>
        <SummaryRows rows={summariesQuery.data ?? []} />
      </div>

      {showSettings && <SummarizerSettings agent={agent} companyId={companyId} />}
    </div>
  );
}
