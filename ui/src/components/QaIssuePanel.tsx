import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, QaExportFormat, QaTestRun } from "@combyne/shared";
import { Download, FileCheck2, GitBranch, MessageSquareWarning, RefreshCw, ShieldCheck } from "lucide-react";
import { qaApi } from "../api/qa";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./StatusBadge";
import { cn } from "../lib/utils";

function runTone(status: string) {
  if (status === "passed") return "text-green-500";
  if (status === "failed" || status === "blocked") return "text-red-500";
  if (status === "running") return "text-cyan-500";
  return "text-yellow-500";
}

function downloadExport(result: { filename?: string; content?: string; contentType?: string }) {
  if (!result.content) return;
  const blob = new Blob([result.content], { type: result.contentType ?? "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename ?? "qa-report.txt";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function QaIssuePanel({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const { data: runs } = useQuery({
    queryKey: queryKeys.qa.runs(issue.companyId, issue.id),
    queryFn: () => qaApi.listRuns(issue.companyId, issue.id),
  });
  const { data: suites } = useQuery({
    queryKey: queryKeys.qa.suites(issue.companyId),
    queryFn: () => qaApi.listSuites(issue.companyId),
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(issue.companyId),
    queryFn: () => agentsApi.list(issue.companyId),
  });

  const qaAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.role === "qa" && agent.status !== "terminated"),
    [agents],
  );
  const latest = runs?.[0] ?? null;
  const defaultSuite = suites?.[0] ?? null;
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.qa.runs(issue.companyId, issue.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.qa.summary(issue.companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.qa.feedback(issue.companyId) });
  };

  const createRun = useMutation({
    mutationFn: () =>
      qaApi.createRun(issue.companyId, {
        issueId: issue.id,
        projectId: issue.projectId,
        suiteId: defaultSuite?.id ?? null,
        qaAgentId: qaAgent?.id ?? null,
        title: `QA validation — ${issue.identifier ?? issue.title}`,
        platform: defaultSuite?.platform ?? "api",
        runnerType: defaultSuite?.runnerType ?? "rest_assured",
        service: defaultSuite?.service ?? null,
        parserType: defaultSuite?.parserType ?? "junit_xml",
      }),
    onSuccess: invalidate,
  });

  const syncCi = useMutation({
    mutationFn: (runId: string) => qaApi.syncGitHubCi(runId),
    onSuccess: invalidate,
  });

  const sendFeedback = useMutation({
    mutationFn: (run: QaTestRun) =>
      qaApi.sendFeedback(run.id, {
        toAgentId: issue.assigneeAgentId,
        createBugIssue: true,
        wakeDeveloper: true,
      }),
    onSuccess: invalidate,
  });

  const signoff = useMutation({
    mutationFn: (runId: string) => qaApi.signoff(runId, { status: "approved", note: "QA signoff from issue panel." }),
    onSuccess: invalidate,
  });

  const exportRun = useMutation({
    mutationFn: ({ runId, format }: { runId: string; format: QaExportFormat }) =>
      qaApi.exportRun(runId, { format }),
    onSuccess: (result) => {
      if (result.content) downloadExport(result);
      invalidate();
    },
  });

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          QA
        </div>
        <Button size="sm" variant="outline" onClick={() => createRun.mutate()} disabled={createRun.isPending}>
          <FileCheck2 className="mr-1.5 h-3.5 w-3.5" />
          {createRun.isPending ? "Creating..." : "Run QA"}
        </Button>
      </div>
      <div className="space-y-3 px-3 py-3">
        {!runs || runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No QA runs yet. Use Run QA to create a structured QA request for this issue.
          </p>
        ) : (
          runs.slice(0, 4).map((run) => (
            <div key={run.id} className="rounded-md border border-border bg-muted/20 px-3 py-2">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{run.title}</span>
                    <StatusBadge status={run.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{run.platform}</span>
                    <span>{run.runnerType}</span>
                    {run.service && <span>{run.service}</span>}
                    {run.headSha && <span className="font-mono">{run.headSha.slice(0, 8)}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {run.runnerType === "github_ci_api" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => syncCi.mutate(run.id)}
                      disabled={syncCi.isPending}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      Sync CI
                    </Button>
                  )}
                  {(run.status === "failed" || run.status === "blocked") && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => sendFeedback.mutate(run)}
                      disabled={sendFeedback.isPending}
                    >
                      <MessageSquareWarning className="mr-1.5 h-3.5 w-3.5" />
                      Send for QA approval
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => exportRun.mutate({ runId: run.id, format: "pdf" })}
                    disabled={exportRun.isPending}
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    PDF
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => exportRun.mutate({ runId: run.id, format: "csv" })}
                    disabled={exportRun.isPending}
                  >
                    CSV
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => exportRun.mutate({ runId: run.id, format: "jira" })}
                    disabled={exportRun.isPending}
                  >
                    Jira
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => signoff.mutate(run.id)}
                    disabled={run.status !== "passed" || signoff.isPending}
                  >
                    Signoff
                  </Button>
                </div>
              </div>
              <div className={cn("mt-2 text-xs font-medium", runTone(run.status))}>
                {run.summary ?? `${run.status.replace("_", " ")} via ${run.runnerType}`}
              </div>
            </div>
          ))
        )}
        {latest?.repo && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            {latest.repo}
            {latest.pullNumber ? `#${latest.pullNumber}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
