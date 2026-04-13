import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuePlansApi, type IssuePlan } from "../api/issue-plans";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "../api/client";
import {
  ClipboardList,
  Send,
  CheckCircle2,
  XCircle,
  Pencil,
} from "lucide-react";

const statusConfig: Record<
  string,
  { label: string; className: string }
> = {
  draft: {
    label: "Draft",
    className:
      "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
  },
  submitted: {
    label: "Submitted",
    className:
      "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  },
  approved: {
    label: "Approved",
    className:
      "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  },
  rejected: {
    label: "Rejected",
    className:
      "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  },
};

function PlanStatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? {
    label: status,
    className: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        config.className,
      )}
    >
      {config.label}
    </span>
  );
}

interface PlanEditorProps {
  issueId: string;
  companyId: string;
  isBoard: boolean;
}

export function PlanEditor({ issueId, companyId, isBoard }: PlanEditorProps) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  const {
    data: plan,
    isLoading,
    error: fetchError,
  } = useQuery({
    queryKey: queryKeys.issuePlans.forIssue(issueId),
    queryFn: () => issuePlansApi.getPlan(issueId),
    enabled: !!issueId,
    retry: (failureCount, err) => {
      // Don't retry 404s — it just means no plan exists yet
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });

  const hasPlan = !!plan && !(fetchError instanceof ApiError && fetchError.status === 404);

  useEffect(() => {
    if (plan) {
      setContent(plan.content);
    }
  }, [plan]);

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.issuePlans.forIssue(issueId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.approvals.list(companyId),
    });
  };

  const saveMutation = useMutation({
    mutationFn: (newContent: string) =>
      issuePlansApi.createOrUpdatePlan(issueId, newContent),
    onSuccess: () => {
      setError(null);
      setIsEditing(false);
      invalidate();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to save plan");
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => issuePlansApi.submitPlanForApproval(issueId),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to submit plan");
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => issuePlansApi.approvePlan(issueId),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to approve plan");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (note?: string) => issuePlansApi.rejectPlan(issueId, note),
    onSuccess: () => {
      setError(null);
      setShowRejectInput(false);
      setRejectNote("");
      invalidate();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to reject plan");
    },
  });

  const isPending =
    saveMutation.isPending ||
    submitMutation.isPending ||
    approveMutation.isPending ||
    rejectMutation.isPending;

  // No plan yet — show creation form
  if (!hasPlan) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Plan</h3>
        </div>

        {isEditing ? (
          <>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Describe the task plan..."
              className="min-h-[120px] text-sm font-mono"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => saveMutation.mutate(content)}
                disabled={!content.trim() || isPending}
              >
                Create Plan
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsEditing(false);
                  setContent("");
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5 mr-1.5" />
            Create Plan
          </Button>
        )}
      </div>
    );
  }

  const canEdit = plan.status === "draft" || plan.status === "rejected";
  const canSubmit = plan.status === "draft";
  const canApproveReject = plan.status === "submitted" && isBoard;
  const isReadOnly = plan.status === "approved" || (plan.status === "submitted" && !isBoard);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Plan</h3>
          <PlanStatusBadge status={plan.status} />
        </div>
        <span className="text-xs text-muted-foreground">v{plan.version}</span>
      </div>

      {isEditing && canEdit ? (
        <>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Describe the task plan..."
            className="min-h-[120px] text-sm font-mono"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate(content)}
              disabled={!content.trim() || isPending}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsEditing(false);
                setContent(plan.content);
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-64 overflow-y-auto">
          {plan.content}
        </div>
      )}

      {error && !isEditing && <p className="text-xs text-destructive">{error}</p>}

      {/* Draft actions */}
      {canEdit && !isEditing && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5 mr-1.5" />
            Edit
          </Button>
          {canSubmit && (
            <Button
              size="sm"
              onClick={() => submitMutation.mutate()}
              disabled={isPending}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" />
              Submit for Approval
            </Button>
          )}
          {plan.status === "rejected" && (
            <Button
              size="sm"
              onClick={() => {
                // Save then submit in sequence
                saveMutation.mutate(content, {
                  onSuccess: () => {
                    submitMutation.mutate();
                  },
                });
              }}
              disabled={!content.trim() || isPending}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" />
              Resubmit
            </Button>
          )}
        </div>
      )}

      {/* Board approval/rejection actions */}
      {canApproveReject && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button
              size="sm"
              className="bg-green-700 hover:bg-green-600 text-white"
              onClick={() => approveMutation.mutate()}
              disabled={isPending}
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              Approve Plan
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowRejectInput(!showRejectInput)}
              disabled={isPending}
            >
              <XCircle className="h-3.5 w-3.5 mr-1.5" />
              Reject
            </Button>
          </div>
          {showRejectInput && (
            <div className="space-y-2">
              <Textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="Rejection note (optional)..."
                className="min-h-[60px] text-sm"
              />
              <Button
                variant="destructive"
                size="sm"
                onClick={() => rejectMutation.mutate(rejectNote || undefined)}
                disabled={isPending}
              >
                Confirm Rejection
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Read-only info for submitted plans (non-board) */}
      {isReadOnly && plan.status === "submitted" && (
        <p className="text-xs text-muted-foreground italic">
          Awaiting board approval...
        </p>
      )}
    </div>
  );
}
