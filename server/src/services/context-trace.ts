import { logger } from "../middleware/logger.js";

/**
 * ───────────────────────────────────────────────────────────────────────────
 *  CONTEXT-TRACE — TEMPORARY end-to-end tracing for the 2-DB context flow.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * This is debug instrumentation for the manual UI test pass. It traces the whole
 * lifecycle of context across the ops⟷context DB boundary — answer captured →
 * embedded → written → retrieved → passed down → PR-approval captured — so that
 * if a hop breaks you can `grep` ONE issueId and see exactly where it stopped.
 *
 * TOGGLE (no redeploy): set `COMBYNE_CONTEXT_TRACE=1` to turn tracing ON; leave it
 * unset/empty for it to be a true no-op (zero overhead, nothing logged).
 *
 * DELETE AFTER TESTING: every trace call site is tagged with the marker
 * `CONTEXT-TRACE` in a comment. To remove all of this instrumentation in one shot:
 *     grep -rn "CONTEXT-TRACE" server/src        # find every call site + this file
 * then delete those lines and this file. Nothing else depends on it.
 *
 * Each event carries a stable `event` name and a flat fields object; pass an
 * `issueId` whenever available so a single `grep '"issueId":"<id>"'` reconstructs
 * the full cross-DB lifecycle of one ticket.
 */

let traceEnabled: boolean | null = null;

function isTraceEnabled(): boolean {
  if (traceEnabled === null) {
    const v = process.env.COMBYNE_CONTEXT_TRACE;
    traceEnabled = v === "1" || v === "true";
  }
  return traceEnabled;
}

/** Emit a context-flow trace event (no-op unless COMBYNE_CONTEXT_TRACE is on). */
export function contextTrace(event: string, fields: Record<string, unknown> = {}): void {
  if (!isTraceEnabled()) return;
  logger.info({ ctxtrace: true, event, ...fields }, `ctxtrace:${event}`);
}
