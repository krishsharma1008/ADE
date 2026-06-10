export interface SidebarBadges {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  /**
   * Issues currently in awaiting_user — an agent asked the board something (or a
   * gate parked the issue) and only a human answer moves it again. Counted into
   * `inbox` as well (F10, e2e-run-2026-06-10).
   */
  awaitingUser?: number;
  /**
   * Pending memory items awaiting human attention (capture + verify + conflict
   * depth). Optional + unpopulated until the Memory UI verify/capture/conflicts
   * tabs land (PR-14); the Memory nav item reads it as a forward-compatible stub
   * so wiring the count later is a server-only change.
   */
  memory?: number;
}
