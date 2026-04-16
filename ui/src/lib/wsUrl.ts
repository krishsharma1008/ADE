/**
 * Build a same-origin WebSocket URL from an API path.
 *
 * - Picks `ws://` vs `wss://` based on the current page protocol.
 * - URI-encodes every path segment so that IDs with slashes, spaces,
 *   or other reserved characters don't corrupt the URL.
 * - Preserves a leading `/api` if the caller includes it; adds one if
 *   not, so callers can pass either `"/api/.../ws"` or `"companies/x/ws"`.
 *
 * Callers should pass an array of segments they want encoded, not a
 * pre-built string — that's how we avoid the double-encode / no-encode
 * drift we had across the five live-event + terminal call sites.
 */

function currentWindow(): Window | null {
  return typeof window === "undefined" ? null : window;
}

export function wsScheme(): "ws" | "wss" {
  const win = currentWindow();
  if (!win) return "ws";
  return win.location.protocol === "https:" ? "wss" : "ws";
}

export function wsHost(): string {
  const win = currentWindow();
  return win ? win.location.host : "localhost";
}

/**
 * Build a WebSocket URL from path segments.
 *
 * @example
 *   buildWsUrl(["api", "companies", companyId, "events", "ws"])
 *   // → "ws://localhost:5173/api/companies/<encoded>/events/ws"
 *
 *   buildWsUrl(["api", "companies", companyId, "agents", agentId, "terminal", "ws"])
 */
export function buildWsUrl(segments: string[], query?: Record<string, string | number | boolean | null | undefined>): string {
  const scheme = wsScheme();
  const host = wsHost();
  const encoded = segments
    .filter((seg) => seg !== "" && seg !== undefined && seg !== null)
    .map((seg) => encodeURIComponent(String(seg)))
    .join("/");
  let qs = "";
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    const s = params.toString();
    if (s) qs = `?${s}`;
  }
  return `${scheme}://${host}/${encoded}${qs}`;
}

/**
 * Convenience for the very common `/api/companies/:id/events/ws` path.
 */
export function buildEventsWsUrl(companyId: string, query?: Record<string, string | number | boolean | null | undefined>): string {
  return buildWsUrl(["api", "companies", companyId, "events", "ws"], query);
}

/**
 * Convenience for the terminal WS path.
 */
export function buildTerminalWsUrl(companyId: string, agentId: string, query?: Record<string, string | number | boolean | null | undefined>): string {
  return buildWsUrl(["api", "companies", companyId, "agents", agentId, "terminal", "ws"], query);
}
