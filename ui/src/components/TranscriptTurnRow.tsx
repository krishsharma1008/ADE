import { cn } from "../lib/utils";

const TRANSCRIPT_ROLE_STYLE: Record<string, string> = {
  user: "text-neutral-500 dark:text-neutral-400",
  assistant: "text-green-700 dark:text-green-300",
  system: "text-blue-700 dark:text-blue-300",
  tool_call: "text-yellow-700 dark:text-yellow-300",
  tool_result: "text-purple-700 dark:text-purple-300",
  stderr: "text-red-700 dark:text-red-300",
  lifecycle: "text-cyan-700 dark:text-cyan-300",
};

export interface TranscriptEntry {
  id: string;
  role: string;
  contentKind: string | null;
  content: Record<string, unknown> | unknown;
  createdAt: string;
}

export function TranscriptTurnRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: TranscriptEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const roleColor = TRANSCRIPT_ROLE_STYLE[entry.role] ?? "text-foreground";
  const ts = new Date(entry.createdAt).toLocaleTimeString("en-US", { hour12: false });
  const kind = entry.contentKind ? `:${entry.contentKind}` : "";

  return (
    <div className="grid grid-cols-[auto_auto_1fr] gap-x-2 items-baseline py-0.5">
      <span className="text-neutral-400 dark:text-neutral-600 select-none w-16 text-[10px]">
        {ts}
      </span>
      <span className={cn("w-28 text-[10px]", roleColor)}>
        {entry.role}
        {kind}
      </span>
      <div className="min-w-0">
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground"
          onClick={onToggle}
        >
          {expanded ? "hide JSON" : "show JSON"}
        </button>
        {expanded && (
          <pre className="mt-1 bg-neutral-100 dark:bg-neutral-950 rounded p-2 text-[11px] overflow-x-auto whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
            {JSON.stringify(entry.content, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
