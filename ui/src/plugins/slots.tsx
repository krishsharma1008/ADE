import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PluginSlot {
  id?: string;
  pluginId: string;
  pluginKey: string;
  /** Slot classification emitted by the server. Newer contributions use `type`;
   *  older/explicit ones use `slotType`. Consumers read `slotType ?? type`. */
  slotType?: string;
  type?: string;
  pluginDisplayName?: string;
  pluginVersion?: string;
  routePath?: string;
  /** HTML or iframe src provided by the plugin */
  content?: string;
  /** Optional path the slot was registered for */
  path?: string;
  meta?: Record<string, unknown>;
}

interface UsePluginSlotsOptions {
  slotTypes: string[];
  companyId?: string | null;
  enabled?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function usePluginSlots({ slotTypes, companyId, enabled = true }: UsePluginSlotsOptions) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: enabled && !!companyId,
  });

  const slots: PluginSlot[] = (data ?? [])
    .filter((c: any) => slotTypes.includes(c.slotType ?? c.type))
    .map((c: any) => ({
      id: c.id ?? `${c.pluginKey}:${c.slotType ?? c.type}`,
      pluginId: c.pluginId ?? c.pluginKey,
      pluginKey: c.pluginKey,
      slotType: c.slotType ?? c.type,
      content: c.content ?? c.html ?? c.iframeSrc,
      path: c.path,
      meta: c.meta,
    }));

  return { slots, isLoading };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface PluginSlotMountProps {
  slot: PluginSlot;
  context?: Record<string, unknown>;
  className?: string;
  missingBehavior?: "placeholder" | "hidden";
}

export function PluginSlotMount({
  slot,
  context: _context,
  className,
  missingBehavior = "hidden",
}: PluginSlotMountProps) {
  if (!slot.content) {
    if (missingBehavior === "placeholder") {
      return (
        <div className={className}>
          <p className="text-sm text-muted-foreground">
            Plugin slot "{slot.slotType}" has no content to render.
          </p>
        </div>
      );
    }
    return null;
  }

  // If the content looks like a URL, render an iframe
  if (slot.content.startsWith("http://") || slot.content.startsWith("https://") || slot.content.startsWith("/")) {
    return (
      <iframe
        src={slot.content}
        className={className}
        title={`Plugin: ${slot.pluginKey}`}
        style={{ width: "100%", border: "none", minHeight: 200 }}
      />
    );
  }

  // Otherwise render as HTML
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: slot.content }}
    />
  );
}
