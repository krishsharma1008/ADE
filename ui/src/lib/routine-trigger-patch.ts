import type { RoutineTrigger } from "@combyne/shared";

/**
 * Build a minimal patch object for saving an edited trigger. Only includes
 * fields that have actually changed from the current trigger state.
 */
export function buildRoutineTriggerPatch(
  trigger: RoutineTrigger,
  draft: {
    label: string;
    cronExpression: string;
    signingMode: string;
    replayWindowSec: string;
  },
  timezone: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const trimmedLabel = draft.label.trim();
  if (trimmedLabel !== (trigger.label ?? "")) {
    patch.label = trimmedLabel || null;
  }

  if (trigger.kind === "schedule") {
    const trimmedCron = draft.cronExpression.trim();
    if (trimmedCron !== (trigger.cronExpression ?? "")) {
      patch.cronExpression = trimmedCron || null;
    }
    if (timezone !== (trigger.timezone ?? "")) {
      patch.timezone = timezone;
    }
  }

  if (trigger.kind === "webhook") {
    if (draft.signingMode !== (trigger.signingMode ?? "bearer")) {
      patch.signingMode = draft.signingMode;
    }
    const replayWindow = parseInt(draft.replayWindowSec, 10);
    if (
      !Number.isNaN(replayWindow) &&
      replayWindow !== (trigger.replayWindowSec ?? 300)
    ) {
      patch.replayWindowSec = replayWindow;
    }
  }

  return patch;
}
