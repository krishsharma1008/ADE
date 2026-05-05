import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowUpRight, X } from "lucide-react";
import { heartbeatsApi } from "../api/heartbeats";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./ui/sheet";
import { Button } from "./ui/button";
import { TranscriptTurnRow, type TranscriptEntry } from "./TranscriptTurnRow";

interface PromptHistoryDrawerProps {
  runId: string | null;
  companyPrefix: string;
  onClose: () => void;
}

export function PromptHistoryDrawer({ runId, companyPrefix, onClose }: PromptHistoryDrawerProps) {
  const open = !!runId;
  const { data, isLoading, error } = useQuery({
    queryKey: ["run-transcript", runId],
    queryFn: () => heartbeatsApi.transcript(runId!),
    enabled: open,
  });

  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>({});

  const entries: TranscriptEntry[] = useMemo(() => data?.entries ?? [], [data?.entries]);

  // Auto-expand the latest assistant turn so users see the answer first.
  useEffect(() => {
    if (entries.length === 0) return;
    const lastAssistant = [...entries].reverse().find((e) => e.role === "assistant");
    if (lastAssistant) {
      setExpandedEntries((prev) =>
        prev[lastAssistant.id] ? prev : { ...prev, [lastAssistant.id]: true },
      );
    }
  }, [entries]);

  // Reset expansion state when switching runs.
  useEffect(() => {
    if (!runId) setExpandedEntries({});
  }, [runId]);

  const run = data?.run;
  const ctx = (run?.contextSnapshot ?? {}) as Record<string, unknown>;
  const wakeReason = (ctx.wakeReason as string) ?? null;
  const wakeSource = (ctx.wakeSource as string) ?? run?.invocationSource ?? null;
  const triggerDetail = run?.triggerDetail ?? null;
  const userReplyBody = (ctx.userReplyBody as string) ?? null;
  const issueIdInCtx = (ctx.issueId as string) ?? null;
  const commentIdInCtx = (ctx.commentId as string) ?? null;
  const contextProfile = (ctx.contextProfile as string) ?? null;
  const contextFocusIssueId = (ctx.contextFocusIssueId as string) ?? null;
  const contextQueueDigest = (ctx.contextQueueDigest as string) ?? null;
  const contextIncludedSections = Array.isArray(ctx.contextIncludedSections)
    ? ctx.contextIncludedSections.filter((section): section is string => typeof section === "string")
    : [];

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-US", { hour12: false }) : "—";

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-[520px]"
      >
        <SheetHeader className="border-b border-border px-4 py-3 text-left">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="text-sm font-semibold">
              {run ? (
                <>
                  Run <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
                  <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {run.status}
                  </span>
                </>
              ) : (
                "Prompt history"
              )}
            </SheetTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {isLoading && (
            <p className="text-xs text-muted-foreground">Loading prompt history…</p>
          )}
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {error instanceof Error ? error.message : "Failed to load prompt history"}
            </p>
          )}

          {data && (
            <div className="space-y-4">
              <section className="rounded-md border border-border bg-muted/30 p-3 text-xs">
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Wake context
                </h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {wakeReason && (
                    <>
                      <dt className="text-muted-foreground">Reason</dt>
                      <dd className="font-mono">{wakeReason}</dd>
                    </>
                  )}
                  {wakeSource && (
                    <>
                      <dt className="text-muted-foreground">Source</dt>
                      <dd className="font-mono">{wakeSource}</dd>
                    </>
                  )}
                  {triggerDetail && (
                    <>
                      <dt className="text-muted-foreground">Trigger</dt>
                      <dd className="font-mono">{triggerDetail}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Started</dt>
                  <dd className="font-mono">{fmt(run?.startedAt ?? null)}</dd>
                  <dt className="text-muted-foreground">Finished</dt>
                  <dd className="font-mono">{fmt(run?.finishedAt ?? null)}</dd>
                  {contextProfile && (
                    <>
                      <dt className="text-muted-foreground">Context</dt>
                      <dd className="font-mono">
                        {contextProfile}
                        {contextQueueDigest ? ` · queue ${contextQueueDigest}` : ""}
                      </dd>
                    </>
                  )}
                  {contextFocusIssueId && (
                    <>
                      <dt className="text-muted-foreground">Focus issue</dt>
                      <dd className="font-mono">{contextFocusIssueId.slice(0, 8)}</dd>
                    </>
                  )}
                  {contextIncludedSections.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">Sections</dt>
                      <dd className="font-mono">{contextIncludedSections.join(", ")}</dd>
                    </>
                  )}
                  {commentIdInCtx && issueIdInCtx && (
                    <>
                      <dt className="text-muted-foreground">Comment</dt>
                      <dd className="font-mono">
                        <Link
                          to={`/${companyPrefix}/issues/${issueIdInCtx}#comment-${commentIdInCtx}`}
                          className="text-blue-700 hover:underline dark:text-blue-300"
                          onClick={onClose}
                        >
                          {commentIdInCtx.slice(0, 8)}
                        </Link>
                      </dd>
                    </>
                  )}
                </dl>
                {userReplyBody && (
                  <div className="mt-2 rounded border border-border bg-background/70 p-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      User reply
                    </div>
                    <div className="whitespace-pre-wrap text-xs text-foreground">
                      {userReplyBody}
                    </div>
                  </div>
                )}
                {run?.error && (
                  <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-red-700 dark:text-red-300">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide">
                      Error{run.errorCode ? ` · ${run.errorCode}` : ""}
                    </div>
                    <div className="whitespace-pre-wrap text-xs">{run.error}</div>
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Transcript ({entries.length})
                </h3>
                {entries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No persisted transcript entries for this run.
                  </p>
                ) : (
                  <div className="space-y-1 font-mono text-xs">
                    {entries.map((entry) => (
                      <TranscriptTurnRow
                        key={entry.id}
                        entry={entry}
                        expanded={!!expandedEntries[entry.id]}
                        onToggle={() =>
                          setExpandedEntries((prev) => ({ ...prev, [entry.id]: !prev[entry.id] }))
                        }
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-2 text-xs">
          {run ? (
            <Link
              to={`/${companyPrefix}/agents/${run.agentId}/runs/${run.id}`}
              onClick={onClose}
              className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300"
            >
              Open full run detail <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
