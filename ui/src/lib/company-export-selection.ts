import type { CompanyPortabilityIssueManifestEntry } from "@combyne/shared";

/**
 * Build the initial set of checked (selected) file paths for the export view.
 *
 * All file paths are checked by default, except issue/task files which are
 * excluded by default to keep exports lean. If a previous selection (`prev`)
 * exists, it is preserved as-is for any paths that still exist in the new file
 * list.
 */
export function buildInitialExportCheckedFiles(
  allPaths: string[],
  issues: CompanyPortabilityIssueManifestEntry[],
  prev: Set<string> | null | undefined,
): Set<string> {
  // If there was a previous selection, keep it but prune stale paths
  if (prev && prev.size > 0) {
    const validPaths = new Set(allPaths);
    const result = new Set<string>();
    for (const p of prev) {
      if (validPaths.has(p)) result.add(p);
    }
    // Add any new paths that weren't in the previous set — check them by
    // default unless they are task/issue paths.
    const issuePaths = new Set(issues.map((i) => i.path));
    for (const p of allPaths) {
      if (!prev.has(p) && !issuePaths.has(p) && !p.startsWith("tasks/")) {
        result.add(p);
      }
    }
    return result;
  }

  // Fresh selection: include everything except issue/task files
  const issuePaths = new Set(issues.map((i) => i.path));
  const checked = new Set<string>();
  for (const p of allPaths) {
    if (!issuePaths.has(p) && !p.startsWith("tasks/")) {
      checked.add(p);
    }
  }
  return checked;
}
