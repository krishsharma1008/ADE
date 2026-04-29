import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { terminalApi } from "../api/terminal";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { usePanel } from "../context/PanelContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens } from "../lib/utils";
import { InlineEditor } from "../components/InlineEditor";
import { CommentThread } from "../components/CommentThread";
import { PromptHistoryDrawer } from "../components/PromptHistoryDrawer";
import { IssueProperties } from "../components/IssueProperties";
import { LiveRunWidget } from "../components/LiveRunWidget";
import type { MentionOption } from "../components/MarkdownEditor";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusBadge } from "../components/StatusBadge";
import { PlanEditor } from "../components/PlanEditor";
import { Identity } from "../components/Identity";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity as ActivityIcon,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  EyeOff,
  Hexagon,
  HelpCircle,
  PlayCircle,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  SlidersHorizontal,
  Trash2,
  UserPlus,
  X as XIcon,
  XCircle,
} from "lucide-react";
import type { ActivityEvent } from "@combyne/shared";
import type { Agent, IssueAttachment } from "@combyne/shared";
import { resolveAgentErrorCode } from "@combyne/shared";

type CommentReassignment = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.question_answered": "answered a question",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function formatAction(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
          : `changed the status to ${humanizeValue(details.status)}`
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
          : `changed the priority to ${humanizeValue(details.priority)}`
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      parts.push(
        details.assigneeAgentId || details.assigneeUserId
          ? "assigned the issue"
          : "unassigned the issue",
      );
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");

    if (parts.length > 0) return parts.join(", ");
  }
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

function ActorIdentity({ evt, agentMap }: { evt: ActivityEvent; agentMap: Map<string, Agent> }) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") return <Identity name="Board" size="sm" />;
  return <Identity name={id || "Unknown"} size="sm" />;
}

export function IssueDetail() {
  const { issueId, companyPrefix } = useParams<{ issueId: string; companyPrefix: string }>();
  const { selectedCompanyId } = useCompany();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("comments");
  const [secondaryOpen, setSecondaryOpen] = useState({
    approvals: false,
    cost: false,
  });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [promptHistoryRunId, setPromptHistoryRunId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 5000,
  });

  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId!),
    queryFn: () => issuesApi.listApprovals(issueId!),
    enabled: !!issueId,
  });

  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId!),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const hasLiveRuns = (liveRuns ?? []).length > 0 || !!activeRun;

  // Filter out runs already shown by the live widget to avoid duplication
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    if (liveIds.size === 0) return linkedRuns ?? [];
    return (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
  }, [linkedRuns, liveRuns, activeRun]);

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent",
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    return options;
  }, [agents, orderedProjects]);

  const childIssues = useMemo(() => {
    if (!allIssues || !issue) return [];
    return allIssues
      .filter((i) => i.parentId === issue.id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [allIssues, issue]);

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      const label = currentUserId === "local-board" ? "Board" : "Me (Board)";
      options.push({ id: `user:${currentUserId}`, label });
    }
    return options;
  }, [agents, currentUserId]);

  const currentAssigneeValue = useMemo(() => {
    if (issue?.assigneeAgentId) return `agent:${issue.assigneeAgentId}`;
    if (issue?.assigneeUserId) return `user:${issue.assigneeUserId}`;
    return "";
  }, [issue?.assigneeAgentId, issue?.assigneeUserId]);

  const commentsWithRunMeta = useMemo(() => {
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null }>();
    const agentIdByRunId = new Map<string, string>();
    for (const run of linkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
      });
    }
    return (comments ?? []).map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      return meta ? { ...comment, ...meta } : comment;
    });
  }, [activity, comments, linkedRuns]);

  const issueCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let hasCost = false;
    let hasTokens = false;

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost =
        usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") ||
        usageNumber(result, "total_cost_usd", "cost_usd", "costUsd");
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
    };
  }, [linkedRuns]);

  const invalidateIssue = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId!) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
    }
  };

  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issueId!, data),
    onSuccess: () => {
      invalidateIssue();
    },
  });

  // Round 3 Phase 8 — operator force-unlock for stuck issues. Visible only
  // when executionRunId is non-null AND no heartbeat is currently alive for
  // the issue (or the lock is old). Posts to POST /issues/:id/force-unlock
  // which is guarded user-only on the server.
  const forceUnlock = useMutation({
    mutationFn: () => issuesApi.forceUnlock(issueId!),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
    },
  });

  const addComment = useMutation({
    mutationFn: ({ body, reopen }: { body: string; reopen?: boolean }) =>
      issuesApi.addComment(issueId!, body, reopen),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      reassignment,
    }: {
      body: string;
      reopen?: boolean;
      reassignment: CommentReassignment;
    }) =>
      issuesApi.update(issueId!, {
        comment: body,
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
      }),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return issuesApi.uploadAttachment(selectedCompanyId, issueId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const approveHire = useMutation({
    mutationFn: (approvalId: string) => approvalsApi.approve(approvalId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: ["company", selectedCompanyId, "approvals"] });
        queryClient.invalidateQueries({ queryKey: ["company", selectedCompanyId, "agents"] });
      }
    },
  });

  const rejectHire = useMutation({
    mutationFn: (approvalId: string) => approvalsApi.reject(approvalId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: ["company", selectedCompanyId, "approvals"] });
      }
    },
  });

  const pendingHires = useMemo(
    () =>
      (linkedApprovals ?? []).filter(
        (a) => a.type === "hire_agent" && a.status === "pending",
      ),
    [linkedApprovals],
  );

  const answerQuestion = useMutation({
    mutationFn: ({ questionCommentId, answer }: { questionCommentId: string; answer: string }) =>
      issuesApi.answerQuestion(issueId!, { questionCommentId, answer }),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const openQuestions = useMemo(
    () =>
      (comments ?? []).filter(
        (c) => c.kind === "question" && !c.answeredAt,
      ),
    [comments],
  );

  const latestRunText = useMemo<string>(() => {
    if (!linkedRuns || linkedRuns.length === 0) return "";
    const sorted = [...linkedRuns].sort((a, b) => {
      const aTs = new Date(a.finishedAt ?? a.createdAt ?? 0).getTime();
      const bTs = new Date(b.finishedAt ?? b.createdAt ?? 0).getTime();
      return bTs - aTs;
    });
    const latest = sorted[0];
    if (!latest) return "";
    const result = asRecord(latest.resultJson);
    const texts: string[] = [];
    const pushString = (v: unknown) => {
      if (typeof v === "string" && v.trim()) texts.push(v);
    };
    if (result) {
      pushString(result.result);
      pushString(result.text);
      pushString(result.content);
      pushString(result.message);
      pushString(result.output);
      pushString(result.response);
      pushString(result.summary);
      const blocks = result.contentBlocks ?? result.content_blocks;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          const rec = asRecord(b);
          if (rec) pushString(rec.text ?? rec.content);
        }
      }
    }
    return texts.join("\n\n");
  }, [linkedRuns]);

  const extractedQuestions = useMemo<string[]>(() => {
    const haystack = latestRunText;
    if (!haystack) return [];
    const qs: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string) => {
      const t = raw
        .trim()
        .replace(/^[-*•\s]+/, "")
        .replace(/^\*\*/, "")
        .replace(/\*\*$/, "")
        .replace(/\*\*/g, "")
        .trim();
      if (t.length < 8) return;
      if (!t.endsWith("?")) return;
      if (seen.has(t)) return;
      seen.add(t);
      qs.push(t);
    };
    // 1. Numbered / lettered list items ending with "?" — highest signal.
    const listRe = /^[\s\-*]*(?:\d+[.)]|[a-zA-Z][.)])\s+(.{6,}\?)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = listRe.exec(haystack))) push(m[1]);
    // 2. Any sentence ending in "?" anywhere in the prose.
    //    Splits on sentence boundaries (. ! ? + whitespace) or newlines.
    const sentenceRe = /([^.!?\n]{8,400}\?)/g;
    while ((m = sentenceRe.exec(haystack))) push(m[1]);
    // 3. Bare-line fallback: whole line ends with "?".
    if (qs.length === 0) {
      for (const line of haystack.split(/\n+/)) push(line);
    }
    return qs.slice(0, 20);
  }, [latestRunText]);

  const continueTerminal = useMutation({
    mutationFn: () => {
      if (!issue?.companyId || !issue?.assigneeAgentId || !issue?.id) {
        throw new Error("Issue missing company/agent — cannot resume");
      }
      return terminalApi.continueSession(issue.companyId, issue.assigneeAgentId, {
        issueId: issue.id,
      });
    },
    onSuccess: ({ session }) => {
      if (issue?.assigneeAgentId) {
        navigate(`/agents/${issue.assigneeAgentId}?tab=terminal&session=${session.id}`);
      } else {
        invalidateIssue();
      }
    },
  });

  useEffect(() => {
    const titleLabel = issue?.title ?? issueId ?? "Issue";
    setBreadcrumbs([
      { label: "Issues", href: "/issues" },
      { label: hasLiveRuns ? `🔵 ${titleLabel}` : titleLabel },
    ]);
  }, [setBreadcrumbs, issue, issueId, hasLiveRuns]);

  // Redirect to identifier-based URL if navigated via UUID
  useEffect(() => {
    if (issue?.identifier && issueId !== issue.identifier) {
      navigate(`/issues/${issue.identifier}`, { replace: true });
    }
  }, [issue, issueId, navigate]);

  useEffect(() => {
    if (!issue?.id) return;
    if (lastMarkedReadIssueIdRef.current === issue.id) return;
    lastMarkedReadIssueIdRef.current = issue.id;
    markIssueRead.mutate(issue.id);
  }, [issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (issue) {
      openPanel(
        <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} />
      );
    }
    return () => closePanel();
  }, [issue]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!issue) return null;

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = issue.ancestors ?? [];

  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    await uploadAttachment.mutateAsync(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const isImageAttachment = (attachment: IssueAttachment) => attachment.contentType.startsWith("image/");

  return (
    <div className="max-w-2xl space-y-6">
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <Link
                to={`/issues/${ancestor.identifier ?? ancestor.id}`}
                className="hover:text-foreground transition-colors truncate max-w-[200px]"
                title={ancestor.title}
              >
                {ancestor.title}
              </Link>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-[200px]">{issue.title}</span>
        </nav>
      )}

      {issue.hiddenAt && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <EyeOff className="h-4 w-4 shrink-0" />
          This issue is hidden
        </div>
      )}

      {pendingHires.length > 0 && (
        <div className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-sky-700 dark:text-sky-300">
          <div className="flex items-center gap-2 font-medium">
            <UserPlus className="h-4 w-4 shrink-0" />
            Proposed hires ({pendingHires.length}) awaiting your decision
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {pendingHires.map((approval) => {
              const payload = (approval.payload ?? {}) as Record<string, unknown>;
              const role = typeof payload.role === "string" ? payload.role : "agent";
              const title = typeof payload.title === "string" ? payload.title : null;
              const adapterType =
                typeof payload.adapterType === "string" ? payload.adapterType : null;
              const reason = typeof payload.reason === "string" ? payload.reason : null;
              const busy =
                (approveHire.isPending && approveHire.variables === approval.id) ||
                (rejectHire.isPending && rejectHire.variables === approval.id);
              return (
                <div
                  key={approval.id}
                  className="flex flex-col gap-2 rounded border border-sky-500/30 bg-background/60 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 text-xs">
                    <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                      <span className="capitalize">{role.replace(/_/g, " ")}</span>
                      {title && <span className="text-muted-foreground">· {title}</span>}
                      {adapterType && (
                        <span className="font-mono text-muted-foreground">
                          · {adapterType}
                        </span>
                      )}
                    </div>
                    {reason && (
                      <div className="mt-0.5 text-muted-foreground line-clamp-2">{reason}</div>
                    )}
                    <Link
                      to={`/approvals/${approval.id}`}
                      className="mt-0.5 inline-block font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {approval.id.slice(0, 8)} · view details
                    </Link>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      disabled={busy}
                      onClick={() => approveHire.mutate(approval.id)}
                      className="gap-1"
                    >
                      <Check className="h-4 w-4" />
                      Hire
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => rejectHire.mutate(approval.id)}
                      className="gap-1"
                    >
                      <XIcon className="h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {openQuestions.length > 0 &&
        issue.status !== "done" &&
        issue.status !== "cancelled" && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-amber-800 dark:text-amber-200">
          <div className="flex items-center justify-between gap-2 font-medium">
            <div className="flex items-center gap-2">
              <HelpCircle className="h-4 w-4 shrink-0" />
              {openQuestions.length === 1
                ? "Agent has a question for you"
                : `Agent has ${openQuestions.length} questions for you`}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateIssue.mutate({ status: "done" })}
              disabled={updateIssue.isPending}
              className="text-amber-900 hover:bg-amber-500/20 dark:text-amber-100"
            >
              {updateIssue.isPending ? "Closing…" : "Close ticket"}
            </Button>
          </div>
          {openQuestions.map((q) => (
            <QuestionAnswerCard
              key={q.id}
              question={q}
              pending={answerQuestion.isPending && answerQuestion.variables?.questionCommentId === q.id}
              onAnswer={(answer) =>
                answerQuestion.mutate({ questionCommentId: q.id, answer })
              }
            />
          ))}
        </div>
      )}

      {/* Failed-run banner — surfaces error taxonomy so the user sees
          what to fix. Fires only when the most-recent non-live run ended
          in failure / timeout and there's no in-flight run that might
          recover. */}
      {(() => {
        if (hasLiveRuns) return null;
        const latest = timelineRuns[0];
        if (!latest) return null;
        if (latest.status !== "failed" && latest.status !== "timed_out") return null;
        const entry = resolveAgentErrorCode(latest.errorCode ?? null);
        return (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm space-y-2">
            <div className="flex items-start gap-2">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="font-medium text-red-900 dark:text-red-200">
                  Last run {latest.status === "timed_out" ? "timed out" : "failed"}
                  {latest.errorCode ? ` (${latest.errorCode})` : ""}
                </div>
                {latest.error && (
                  <div className="text-xs text-red-900/80 dark:text-red-200/80 break-words">
                    {latest.error}
                  </div>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => navigate(`/agents/${latest.agentId}/runs/${latest.runId}`)}
              >
                Open run
              </Button>
            </div>
            {entry && (
              <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs space-y-1 ml-6">
                <div className="font-medium text-amber-900 dark:text-amber-200">{entry.title}</div>
                <div className="text-amber-900/80 dark:text-amber-200/80 leading-relaxed">
                  {entry.body}
                </div>
                <div className="text-amber-900 dark:text-amber-200 leading-relaxed">
                  <span className="font-medium">How to fix: </span>
                  {entry.remediation}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {issue.status === "awaiting_user" && openQuestions.length === 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">
              {issue.originKind === "terminal_session"
                ? "Terminal session idled out"
                : "Agent is waiting for your response"}
            </div>
            <div className="text-xs opacity-80">
              {issue.originKind === "terminal_session"
                ? "Click Continue to reopen the terminal with the prior session's context."
                : "Reply below to resume the agent. The issue will automatically return to in-progress."}
              {issue.awaitingUserSince ? ` Waiting since ${new Date(issue.awaitingUserSince).toLocaleString()}.` : ""}
            </div>
          </div>
          {issue.originKind === "terminal_session" && issue.assigneeAgentId && (
            <Button
              size="sm"
              variant="outline"
              disabled={continueTerminal.isPending}
              onClick={() => continueTerminal.mutate()}
              className="shrink-0 gap-1"
            >
              <PlayCircle className="h-4 w-4" />
              {continueTerminal.isPending ? "Resuming..." : "Continue"}
            </Button>
          )}
        </div>
      )}
      {issue.assigneeAgentId &&
        issue.originKind !== "terminal_session" &&
        openQuestions.length === 0 &&
        !hasLiveRuns && (
          <ReplyAndWakeCard
            issueStatus={issue.status}
            pending={addComment.isPending}
            extractedQuestions={extractedQuestions}
            latestRunText={latestRunText}
            onSubmit={async (body) => {
              const closedStatuses = ["done", "cancelled"];
              await addComment.mutateAsync({
                body,
                reopen: closedStatuses.includes(issue.status),
              });
            }}
            onClose={
              issue.status === "done" || issue.status === "cancelled"
                ? undefined
                : () => updateIssue.mutate({ status: "done" })
            }
            closing={updateIssue.isPending}
          />
        )}
      {issue.originKind === "terminal_session" &&
        issue.assigneeAgentId &&
        issue.status !== "awaiting_user" &&
        issue.status !== "done" && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span>This issue is backed by a live terminal session.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const sessionId = issue.originId ?? "";
                const qs = sessionId ? `?tab=terminal&session=${encodeURIComponent(sessionId)}` : "?tab=terminal";
                navigate(`/agents/${issue.assigneeAgentId}${qs}`);
              }}
              className="shrink-0 gap-1"
            >
              <PlayCircle className="h-4 w-4" />
              Open terminal
            </Button>
          </div>
        )}
      {issue.status === "done" && issue.originKind === "terminal_session" && issue.assigneeAgentId && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span>Terminal session closed. You can resume it if it's still reachable.</span>
          <Button
            size="sm"
            variant="outline"
            disabled={continueTerminal.isPending}
            onClick={() => continueTerminal.mutate()}
            className="shrink-0 gap-1"
          >
            <PlayCircle className="h-4 w-4" />
            {continueTerminal.isPending ? "Resuming..." : "Continue"}
          </Button>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <StatusIcon
            status={issue.status}
            onChange={(status) => updateIssue.mutate({ status })}
          />
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => updateIssue.mutate({ priority })}
          />
          <span className="text-sm font-mono text-muted-foreground shrink-0">{issue.identifier ?? issue.id.slice(0, 8)}</span>

          {hasLiveRuns && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
              </span>
              Live
            </span>
          )}
          {issue.executionRunId &&
            (!hasLiveRuns ||
              (issue.executionLockedAt != null &&
                Date.now() - new Date(issue.executionLockedAt).getTime() > 15 * 60 * 1000)) && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Force-unlock this issue? Clears execution lock even if a run is still marked live.")) {
                    forceUnlock.mutate();
                  }
                }}
                disabled={forceUnlock.isPending}
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 shrink-0 hover:bg-amber-500/20 disabled:opacity-50"
                title="Clear executionRunId so this issue can be picked up again"
              >
                {forceUnlock.isPending ? "Unlocking…" : "Unblock"}
              </button>
            )}

          {issue.projectId ? (
            <Link
              to={`/projects/${issue.projectId}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
            >
              <Hexagon className="h-3 w-3 shrink-0" />
              <span className="truncate">{(projects ?? []).find((p) => p.id === issue.projectId)?.name ?? issue.projectId.slice(0, 8)}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
              <Hexagon className="h-3 w-3 shrink-0" />
              No project
            </span>
          )}

          {(issue.labels ?? []).length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {(issue.labels ?? []).slice(0, 4).map((label) => (
                <span
                  key={label.id}
                  className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    borderColor: label.color,
                    color: label.color,
                    backgroundColor: `${label.color}1f`,
                  }}
                >
                  {label.name}
                </span>
              ))}
              {(issue.labels ?? []).length > 4 && (
                <span className="text-[10px] text-muted-foreground">+{(issue.labels ?? []).length - 4}</span>
              )}
            </div>
          )}

          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto md:hidden shrink-0"
            onClick={() => setMobilePropsOpen(true)}
            title="Properties"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>

          <div className="hidden md:flex items-center md:ml-auto shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0 transition-opacity duration-200",
                panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
              )}
              onClick={() => setPanelVisible(true)}
              title="Show properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>

            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="shrink-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  updateIssue.mutate(
                    { hiddenAt: new Date().toISOString() },
                    { onSuccess: () => navigate("/issues/all") },
                  );
                  setMoreOpen(false);
                }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this Issue
              </button>
            </PopoverContent>
            </Popover>
          </div>
        </div>

        <InlineEditor
          value={issue.title}
          onSave={(title) => updateIssue.mutate({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={issue.description ?? ""}
          onSave={(description) => updateIssue.mutate({ description })}
          as="p"
          className="text-sm text-muted-foreground"
          placeholder="Add a description..."
          multiline
          mentions={mentionOptions}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleFilePicked}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadAttachment.isPending}
            >
              <Paperclip className="h-3.5 w-3.5 mr-1.5" />
              {uploadAttachment.isPending ? "Uploading..." : "Upload image"}
            </Button>
          </div>
        </div>

        {attachmentError && (
          <p className="text-xs text-destructive">{attachmentError}</p>
        )}

        {(!attachments || attachments.length === 0) ? (
          <p className="text-xs text-muted-foreground">No attachments yet.</p>
        ) : (
          <div className="space-y-2">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="border border-border rounded-md p-2">
                <div className="flex items-center justify-between gap-2">
                  <a
                    href={attachment.contentPath}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs hover:underline truncate"
                    title={attachment.originalFilename ?? attachment.id}
                  >
                    {attachment.originalFilename ?? attachment.id}
                  </a>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => deleteAttachment.mutate(attachment.id)}
                    disabled={deleteAttachment.isPending}
                    title="Delete attachment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {attachment.contentType} · {(attachment.byteSize / 1024).toFixed(1)} KB
                </p>
                {isImageAttachment(attachment) && (
                  <a href={attachment.contentPath} target="_blank" rel="noreferrer">
                    <img
                      src={attachment.contentPath}
                      alt={attachment.originalFilename ?? "attachment"}
                      className="mt-2 max-h-56 rounded border border-border object-contain bg-accent/10"
                      loading="lazy"
                    />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Separator />

      <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="comments" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Comments
          </TabsTrigger>
          <TabsTrigger value="subissues" className="gap-1.5">
            <ListTree className="h-3.5 w-3.5" />
            Sub-issues
          </TabsTrigger>
          <TabsTrigger value="plan" className="gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" />
            Plan
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="comments">
          <CommentThread
            comments={commentsWithRunMeta}
            linkedRuns={timelineRuns}
            issueStatus={issue.status}
            agentMap={agentMap}
            draftKey={`combyne:issue-comment-draft:${issue.id}`}
            enableReassign
            reassignOptions={commentReassignOptions}
            currentAssigneeValue={currentAssigneeValue}
            mentions={mentionOptions}
            onAdd={async (body, reopen, reassignment) => {
              if (reassignment) {
                await addCommentAndReassign.mutateAsync({ body, reopen, reassignment });
                return;
              }
              await addComment.mutateAsync({ body, reopen });
            }}
            imageUploadHandler={async (file) => {
              const attachment = await uploadAttachment.mutateAsync(file);
              return attachment.contentPath;
            }}
            onAttachImage={async (file) => {
              await uploadAttachment.mutateAsync(file);
            }}
            liveRunSlot={<LiveRunWidget issueId={issueId!} companyId={issue.companyId} />}
            onOpenPromptHistory={(runId) => setPromptHistoryRunId(runId)}
          />
        </TabsContent>

        <TabsContent value="subissues">
          {childIssues.length === 0 ? (
            <p className="text-xs text-muted-foreground">No sub-issues.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {childIssues.map((child) => (
                <Link
                  key={child.id}
                  to={`/issues/${child.identifier ?? child.id}`}
                  className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusIcon status={child.status} />
                    <PriorityIcon priority={child.priority} />
                    <span className="font-mono text-muted-foreground shrink-0">
                      {child.identifier ?? child.id.slice(0, 8)}
                    </span>
                    <span className="truncate">{child.title}</span>
                  </div>
                  {child.assigneeAgentId && (() => {
                    const name = agentMap.get(child.assigneeAgentId)?.name;
                    return name
                      ? <Identity name={name} size="sm" />
                      : <span className="text-muted-foreground font-mono">{child.assigneeAgentId.slice(0, 8)}</span>;
                  })()}
                </Link>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="plan">
          <PlanEditor
            issueId={issue.id}
            companyId={issue.companyId}
            isBoard={true}
          />
        </TabsContent>

        <TabsContent value="activity">
          {!activity || activity.length === 0 ? (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="space-y-1.5">
              {activity.slice(0, 20).map((evt) => (
                <div key={evt.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ActorIdentity evt={evt} agentMap={agentMap} />
                  <span>{formatAction(evt.action, evt.details)}</span>
                  <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {linkedApprovals && linkedApprovals.length > 0 && (
        <Collapsible
          open={secondaryOpen.approvals}
          onOpenChange={(open) => setSecondaryOpen((prev) => ({ ...prev, approvals: open }))}
          className="rounded-lg border border-border"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
            <span className="text-sm font-medium text-muted-foreground">
              Linked Approvals ({linkedApprovals.length})
            </span>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.approvals && "rotate-180")}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border divide-y divide-border">
              {linkedApprovals.map((approval) => (
                <Link
                  key={approval.id}
                  to={`/approvals/${approval.id}`}
                  className="flex items-center justify-between px-3 py-2 text-xs hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <StatusBadge status={approval.status} />
                    <span className="font-medium">
                      {approval.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                    <span className="font-mono text-muted-foreground">{approval.id.slice(0, 8)}</span>
                  </div>
                  <span className="text-muted-foreground">{relativeTime(approval.createdAt)}</span>
                </Link>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {linkedRuns && linkedRuns.length > 0 && (
        <Collapsible
          open={secondaryOpen.cost}
          onOpenChange={(open) => setSecondaryOpen((prev) => ({ ...prev, cost: open }))}
          className="rounded-lg border border-border"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
            <span className="text-sm font-medium text-muted-foreground">Cost Summary</span>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.cost && "rotate-180")}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border px-3 py-2">
              {!issueCostSummary.hasCost && !issueCostSummary.hasTokens ? (
                <div className="text-xs text-muted-foreground">No cost data yet.</div>
              ) : (
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {issueCostSummary.hasCost && (
                    <span className="font-medium text-foreground">
                      ${issueCostSummary.cost.toFixed(4)}
                    </span>
                  )}
                  {issueCostSummary.hasTokens && (
                    <span>
                      Tokens {formatTokens(issueCostSummary.totalTokens)}
                      {issueCostSummary.cached > 0
                        ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                        : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
                    </span>
                  )}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} inline />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <PromptHistoryDrawer
        runId={promptHistoryRunId}
        companyPrefix={companyPrefix ?? ""}
        onClose={() => setPromptHistoryRunId(null)}
      />
      <ScrollToBottom />
    </div>
  );
}

function ReplyAndWakeCard({
  issueStatus,
  pending,
  extractedQuestions,
  latestRunText,
  onSubmit,
  onClose,
  closing,
}: {
  issueStatus: string;
  pending: boolean;
  extractedQuestions: string[];
  latestRunText?: string;
  onSubmit: (body: string) => Promise<void>;
  onClose?: () => void;
  closing?: boolean;
}) {
  const [freeText, setFreeText] = useState("");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [showFullRunText, setShowFullRunText] = useState(false);
  const hasQuestions = extractedQuestions.length > 0;
  const isAwaiting = issueStatus === "awaiting_user";
  const title = isAwaiting
    ? hasQuestions
      ? `Agent is waiting — ${extractedQuestions.length} question${extractedQuestions.length === 1 ? "" : "s"} for you`
      : "Agent is waiting for your response"
    : hasQuestions
      ? `Agent asked ${extractedQuestions.length} clarifying question${extractedQuestions.length === 1 ? "" : "s"}`
      : "Agent finished — reply to continue the conversation";
  const hint = hasQuestions
    ? "Answer each question inline (or add free-form notes below). Submitting re-opens the issue and wakes the agent with your reply."
    : isAwaiting
      ? "Type your answer. Submitting resumes the agent."
      : "Read the agent's latest update below, then reply. Submitting re-opens the issue and wakes the agent with your reply.";
  const buttonLabel = isAwaiting ? "Send answer" : "Reply & wake agent";
  const runTextPreview = (latestRunText ?? "").trim();
  const shouldShowLatestText = !hasQuestions && runTextPreview.length > 0;
  const SNIPPET_CHARS = 480;
  const runTextIsLong = runTextPreview.length > SNIPPET_CHARS;
  const runTextSnippet = runTextIsLong
    ? runTextPreview.slice(0, SNIPPET_CHARS).trimEnd() + "…"
    : runTextPreview;

  const buildBody = () => {
    const parts: string[] = [];
    for (let i = 0; i < extractedQuestions.length; i++) {
      const a = (answers[i] ?? "").trim();
      if (a) {
        parts.push(`**${i + 1}. ${extractedQuestions[i]}**\n${a}`);
      }
    }
    const free = freeText.trim();
    if (free) parts.push(free);
    return parts.join("\n\n");
  };

  const body = buildBody();
  const submit = async () => {
    if (!body || pending) return;
    await onSubmit(body);
    setFreeText("");
    setAnswers({});
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200">
        <MessageSquare className="h-4 w-4 shrink-0" />
        {title}
      </div>
      <div className="text-xs text-amber-800/80 dark:text-amber-200/80">{hint}</div>
      {shouldShowLatestText && (
        <div className="rounded border border-amber-500/30 bg-background/70 px-3 py-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Agent's latest message
          </div>
          <div className="whitespace-pre-wrap text-sm text-foreground">
            {showFullRunText || !runTextIsLong ? runTextPreview : runTextSnippet}
          </div>
          {runTextIsLong && (
            <button
              type="button"
              onClick={() => setShowFullRunText((v) => !v)}
              className="mt-1 text-[11px] font-medium text-amber-700 hover:underline dark:text-amber-300"
            >
              {showFullRunText ? "Show less" : "Show full message"}
            </button>
          )}
        </div>
      )}
      {hasQuestions && (
        <div className="flex flex-col gap-2">
          {extractedQuestions.map((q, i) => (
            <div
              key={i}
              className="rounded border border-amber-500/30 bg-background/60 px-3 py-2"
            >
              <div className="text-sm font-medium text-foreground">
                <span className="mr-1.5 text-amber-700 dark:text-amber-300">{i + 1}.</span>
                {q}
              </div>
              <textarea
                value={answers[i] ?? ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
                placeholder="Your answer…"
                rows={2}
                className="mt-1.5 w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
                disabled={pending}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
          ))}
        </div>
      )}
      <textarea
        value={freeText}
        onChange={(e) => setFreeText(e.target.value)}
        placeholder={hasQuestions ? "Extra notes or clarifications (optional)…" : "Type your reply to the agent…"}
        rows={hasQuestions ? 2 : 3}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        disabled={pending}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">⌘/Ctrl+Enter to send</span>
        <div className="flex items-center gap-2">
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending || closing}
              onClick={onClose}
              className="text-amber-900 hover:bg-amber-500/20 dark:text-amber-100"
            >
              {closing ? "Closing…" : "Close ticket"}
            </Button>
          )}
          <Button size="sm" disabled={pending || !body} onClick={() => void submit()}>
            {pending ? "Sending…" : buttonLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function QuestionAnswerCard({
  question,
  pending,
  onAnswer,
}: {
  question: import("@combyne/shared").IssueComment;
  pending: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState("");
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const trimmed = text.trim();
  return (
    <div className="rounded border border-amber-500/30 bg-background/60 px-3 py-2 text-foreground">
      <div className="whitespace-pre-wrap text-sm">{question.body}</div>
      {choices.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onAnswer(choice)}
            >
              {choice}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your answer…"
          rows={2}
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
          disabled={pending}
        />
        <Button
          size="sm"
          onClick={() => trimmed && onAnswer(trimmed)}
          disabled={pending || !trimmed}
          className="shrink-0"
        >
          {pending ? "Sending…" : "Send answer"}
        </Button>
      </div>
    </div>
  );
}
