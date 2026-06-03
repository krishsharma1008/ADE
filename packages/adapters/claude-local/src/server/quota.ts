import type { ProviderQuotaResultLike } from "@combyne/adapter-utils";

// ── Provider quota windows for the claude-local adapter (Issue 4) ─────────
//
// The Claude CLI does NOT expose a live quota / rate-limit API we can poll, so
// this hook is BEST-EFFORT and DERIVED, not authoritative: it reports the 5h
// subscription window based on the most recent usage-limit error the adapter
// observed in-process (`recordUsageLimitObservation`, called from execute()'s
// usage-limit branch).
//
// Semantics:
//   - No observation yet, or the last observed reset is in the past → we report
//     the window as 0% used (best guess: the window has reset / we have no
//     evidence we're throttled) with no resetsAt.
//   - A recent observation whose resetsAt is still in the future → we report the
//     window as 100% used (we KNOW we were just throttled) with that resetsAt.
//
// `fetchAllQuotaWindows` (server/src/services/quota-windows.ts) picks this up
// automatically because the adapter module exposes `getQuotaWindows`.

interface UsageLimitObservation {
  observedAt: number;
  resetsAt: string | null;
  message: string | null;
}

let lastObservation: UsageLimitObservation | null = null;

/**
 * Record that a usage limit was just observed. Called from the adapter's
 * execute() usage-limit branch so getQuotaWindows() can report a derived 5h
 * window. `resetsAt` is the ISO reset time when one was parseable, else null.
 */
export function recordUsageLimitObservation(input: {
  resetsAt: string | null;
  message: string | null;
}): void {
  lastObservation = {
    observedAt: Date.now(),
    resetsAt: input.resetsAt,
    message: input.message,
  };
}

/** Test/maintenance helper — clears the in-process observation. */
export function __resetUsageLimitObservation(): void {
  lastObservation = null;
}

/**
 * Best-effort provider quota windows for claude-local. Derives the 5h
 * subscription window from the last observed usage-limit error rather than a
 * live API (which the CLI does not provide). Always resolves `ok: true` — a
 * lack of observations is a valid "not throttled / unknown" state, not a fetch
 * failure.
 */
export async function getQuotaWindows(): Promise<ProviderQuotaResultLike> {
  const now = Date.now();
  const obs = lastObservation;

  let resetsAt: string | null = null;
  let usedPercent: number | null = null;
  let detail: string | null =
    "Derived from the last observed Claude usage-limit error; the Claude CLI exposes no live quota API.";

  if (obs) {
    const resetMs = obs.resetsAt ? Date.parse(obs.resetsAt) : NaN;
    const resetInFuture = Number.isFinite(resetMs) && resetMs > now;
    if (resetInFuture) {
      // We know we were throttled and the window hasn't reset yet.
      resetsAt = obs.resetsAt;
      usedPercent = 100;
      detail = obs.message
        ? `Throttled: ${obs.message}`
        : "Throttled by a recent Claude usage limit.";
    } else if (!obs.resetsAt) {
      // Saw a limit but couldn't parse a reset time. Surface that we were
      // recently throttled without claiming a precise reset.
      usedPercent = 100;
      detail = obs.message
        ? `Recently throttled (reset time unknown): ${obs.message}`
        : "Recently throttled by a Claude usage limit (reset time unknown).";
    }
    // else: reset is in the past → window has reset; leave usedPercent null/0.
  }

  return {
    provider: "anthropic",
    ok: true,
    source: "derived:last-usage-limit",
    fetchedAt: new Date(now).toISOString(),
    windows: [
      {
        label: "5h",
        usedPercent,
        resetsAt,
        valueLabel: null,
        detail,
      },
    ],
  };
}
