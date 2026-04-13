/**
 * Build the path for an issue detail page.
 *
 * @param issuePathId - The issue identifier or id used in the URL
 * @param state - Optional location state to pass through (unused in path construction)
 */
export function createIssueDetailPath(
  issuePathId: string,
  _state?: unknown,
): string {
  return `/issues/${encodeURIComponent(issuePathId)}`;
}
