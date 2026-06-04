export interface SidebarBadges {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  /**
   * Pending memory items awaiting human attention (capture + verify + conflict
   * depth). Optional + unpopulated until the Memory UI verify/capture/conflicts
   * tabs land (PR-14); the Memory nav item reads it as a forward-compatible stub
   * so wiring the count later is a server-only change.
   */
  memory?: number;
}
