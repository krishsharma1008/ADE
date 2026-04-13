import { useCallback, useRef, useState } from "react";

export type AutosaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/**
 * Lightweight hook that tracks the lifecycle of an autosave operation.
 *
 * States: idle -> dirty -> saving -> saved -> idle (or error)
 *
 * Usage:
 *   const { state, markDirty, reset, runSave } = useAutosaveIndicator();
 *   markDirty();                       // content changed
 *   await runSave(() => api.save());   // wraps the save promise
 */
export function useAutosaveIndicator() {
  const [state, setState] = useState<AutosaveState>("idle");
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSavedTimer = useCallback(() => {
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
  }, []);

  const markDirty = useCallback(() => {
    clearSavedTimer();
    setState("dirty");
  }, [clearSavedTimer]);

  const reset = useCallback(() => {
    clearSavedTimer();
    setState("idle");
  }, [clearSavedTimer]);

  const runSave = useCallback(
    async (saveFn: () => Promise<void>) => {
      clearSavedTimer();
      setState("saving");
      try {
        await saveFn();
        setState("saved");
        savedTimerRef.current = setTimeout(() => {
          setState((current) => (current === "saved" ? "idle" : current));
        }, 2000);
      } catch (err) {
        setState("error");
        throw err;
      }
    },
    [clearSavedTimer],
  );

  return { state, markDirty, reset, runSave };
}
