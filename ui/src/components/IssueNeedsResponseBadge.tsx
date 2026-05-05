import { MessageSquareWarning } from "lucide-react";
import type { Issue } from "@combyne/shared";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

interface IssueNeedsResponseBadgeProps {
  issue: Pick<Issue, "status" | "awaitingUserSince">;
  className?: string;
  compact?: boolean;
}

export function IssueNeedsResponseBadge({
  issue,
  className,
  compact = false,
}: IssueNeedsResponseBadgeProps) {
  if (issue.status !== "awaiting_user") return null;

  const waitingText = issue.awaitingUserSince
    ? compact
      ? timeAgo(issue.awaitingUserSince)
      : `Waiting since ${timeAgo(issue.awaitingUserSince)}`
    : null;

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200",
        className,
      )}
      title={waitingText ?? "Agent needs a response"}
    >
      <MessageSquareWarning className="h-3 w-3 shrink-0" />
      <span className="shrink-0">Needs response</span>
      {waitingText && !compact ? (
        <span className="min-w-0 truncate text-amber-800/70 dark:text-amber-200/70">
          {waitingText}
        </span>
      ) : null}
    </span>
  );
}
