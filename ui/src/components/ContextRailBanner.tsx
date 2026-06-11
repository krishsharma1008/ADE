import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api } from "../api/client";

interface ContextRailHealth {
  usingSeparateContextDb: boolean;
  status: "ok" | "unreachable" | "unknown";
  at: number;
  lastError: string | null;
}

/**
 * Global warning strip when the shared context rail (separate context DB) is
 * unreachable. Found live (finding #25): a rail outage used to be invisible —
 * runs hung, then failed, and nothing on the UI said why. The server now fails
 * fast and stamps a health surface; this banner makes it operator-visible.
 * Renders nothing in single-DB mode or while the rail is healthy.
 */
export function ContextRailBanner() {
  const { data } = useQuery({
    queryKey: ["instance", "context-rail-health"],
    queryFn: () => api.get<ContextRailHealth>("/instance/context-database/health"),
    refetchInterval: 30_000,
    retry: false,
  });

  if (!data || !data.usingSeparateContextDb || data.status !== "unreachable") {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-1.5 text-xs text-amber-800 dark:text-amber-200"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="font-medium">Shared context rail unreachable.</span>
      <span className="text-amber-700/80 dark:text-amber-200/70 truncate">
        Agent runs fail fast and re-deliver; memory recall is degraded until the rail recovers.
        {data.lastError ? ` (${data.lastError})` : ""}
      </span>
    </div>
  );
}
