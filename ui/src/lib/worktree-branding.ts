export interface WorktreeUiBranding {
  /** Display name for the worktree (e.g. branch name or label). */
  name: string;
  /** Background / accent color (CSS color string). */
  color: string;
  /** Contrasting text color for use on top of `color`. */
  textColor: string;
}

const WORKTREE_STORAGE_KEY = "combyne:worktree-branding";

/**
 * Read worktree branding from the environment or localStorage.
 *
 * Returns `null` when the UI is not running inside a worktree context.
 */
export function getWorktreeUiBranding(): WorktreeUiBranding | null {
  // Check for a meta tag or injected global first (set by the server when
  // serving a worktree build).
  if (typeof window !== "undefined") {
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="combyne-worktree"]',
    );
    if (meta?.content) {
      try {
        const parsed = JSON.parse(meta.content);
        if (parsed && typeof parsed.name === "string") {
          return {
            name: parsed.name,
            color: parsed.color ?? "#7c3aed",
            textColor: parsed.textColor ?? "#ffffff",
          };
        }
      } catch {
        // fall through
      }
    }

    // Fallback: check localStorage (useful during local development with
    // worktrees).
    try {
      const raw = localStorage.getItem(WORKTREE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.name === "string") {
          return {
            name: parsed.name,
            color: parsed.color ?? "#7c3aed",
            textColor: parsed.textColor ?? "#ffffff",
          };
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}
