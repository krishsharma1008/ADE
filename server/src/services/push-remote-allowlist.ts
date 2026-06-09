// Production-remote push/PR guardrail.
//
// Agents run `git` and `gh` directly inside their realized workspaces. Nothing in
// the toolchain stops an agent from pushing to — or opening a PR against — a real
// production remote that merely happens to be reachable (e.g. a dirty clone of
// github.com/bukuwarung/fs-bnpl-service). This module is the single source of
// truth for deciding whether a given git remote / repo slug is an allowlisted
// TEST target.
//
// Design rules:
// - STRICT by default: anything that does not positively match the allowlist is
//   BLOCKED. An empty or unparseable allowlist blocks everything.
// - Pure + side-effect free so it can be unit-tested and reused by both the
//   per-workspace pre-push hook generator and the server-side PR-tracking route.

// Comma-separated globs (and a couple of regex conveniences) describing the
// host/owner/repo slugs agents are permitted to push to. See
// `matchesPattern` for the supported syntax.
export const ALLOWED_PUSH_REMOTE_PATTERNS_ENV = "COMBYNE_ALLOWED_PUSH_REMOTE_PATTERNS";

// A normalized "slug" is the canonical identity we match against, derived from a
// remote URL or a `owner/repo` string: `host/owner/repo` lower-cased, with any
// `.git` suffix and embedded credentials stripped. Examples:
//   git@github.com:acme/widget-test.git -> github.com/acme/widget-test
//   https://github.com/acme/widget.git  -> github.com/acme/widget
//   acme/widget-test                    -> github.com/acme/widget-test (host defaulted)
const DEFAULT_HOST = "github.com";

export interface RemoteSlug {
  host: string;
  owner: string;
  repo: string;
  /** `host/owner/repo`, lower-cased, no `.git`. */
  slug: string;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function stripCredentials(host: string): string {
  // user:pass@host -> host
  const at = host.lastIndexOf("@");
  return at >= 0 ? host.slice(at + 1) : host;
}

/**
 * Parse a git remote URL or a bare `owner/repo` slug into a normalized
 * `host/owner/repo` identity. Returns null when the value cannot be understood
 * as a remote (which, under strict matching, means "block").
 *
 * Handles: https/http, ssh `git@host:owner/repo`, `ssh://` URLs, and bare
 * `owner/repo` (host defaults to github.com).
 */
export function parseRemoteSlug(rawValue: string | null | undefined): RemoteSlug | null {
  if (typeof rawValue !== "string") return null;
  const value = rawValue.trim();
  if (value.length === 0) return null;

  let host: string | null = null;
  let pathPart: string | null = null;

  // scp-like syntax: [user@]host:owner/repo (no scheme, single colon before path)
  const scpMatch = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
  if (scpMatch && !value.includes("://")) {
    host = stripCredentials(scpMatch[1]!);
    pathPart = scpMatch[2]!;
  } else if (value.includes("://")) {
    try {
      const url = new URL(value);
      host = url.host || url.hostname;
      pathPart = url.pathname;
    } catch {
      return null;
    }
  } else if (value.includes("/")) {
    // Bare owner/repo (or owner/repo with extra path segments). Default the host.
    host = DEFAULT_HOST;
    pathPart = value;
  } else {
    return null;
  }

  if (!host || !pathPart) return null;
  host = stripCredentials(host).toLowerCase().replace(/^\/+/, "");
  // Drop any port (host:1234) — identity is host-name only.
  host = host.replace(/:\d+$/, "");

  const segments = stripGitSuffix(pathPart)
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;

  // owner is the first segment, repo is the second; deeper paths are ignored so
  // that PR/compare URLs still normalize to their repo identity.
  const owner = segments[0]!.toLowerCase();
  const repo = segments[1]!.toLowerCase();
  if (!owner || !repo) return null;

  return { host, owner, repo, slug: `${host}/${owner}/${repo}` };
}

/**
 * Match a normalized slug against a single allowlist pattern. Supported pattern
 * forms (case-insensitive):
 *   - glob over the full `host/owner/repo` slug, with `*` matching any run of
 *     non-`/` characters and `**` matching across `/` (e.g. `github.com/acme/* `,
 *     `**\/*-test`).
 *   - bare `owner/repo` glob (host defaults to github.com), e.g. `acme/*-test`.
 *   - `/regex/` — a slash-delimited regular expression matched against the slug.
 */
function matchesPattern(slug: RemoteSlug, rawPattern: string): boolean {
  const pattern = rawPattern.trim();
  if (pattern.length === 0) return false;

  // Regex form: /.../ (optionally with a trailing flag set we ignore beyond `i`).
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const lastSlash = pattern.lastIndexOf("/");
    const body = pattern.slice(1, lastSlash);
    try {
      const re = new RegExp(body, "i");
      return re.test(slug.slug);
    } catch {
      return false;
    }
  }

  // Glob form. Normalize the pattern's identity the same way as the slug so that
  // `acme/widget-test`, `github.com/acme/widget-test` and `*-test` all behave.
  const normalizedPattern = normalizeGlobPattern(pattern);
  const regex = globToRegExp(normalizedPattern);
  return regex.test(slug.slug);
}

function normalizeGlobPattern(pattern: string): string {
  const lower = stripGitSuffix(pattern.trim()).toLowerCase().replace(/\.git$/i, "");
  // Count "real" path separators (ignore those inside ** which we treat literally
  // for counting purposes — a `**` is still 0 separators for host detection).
  const withoutDoubleStar = lower.replace(/\*\*/g, "");
  const separatorCount = (withoutDoubleStar.match(/\//g) ?? []).length;
  if (separatorCount >= 2) {
    // Already host/owner/repo shaped.
    return lower;
  }
  if (separatorCount === 1) {
    // owner/repo — default the host.
    return `${DEFAULT_HOST}/${lower}`;
  }
  // Single token like `*-test` — match it against the repo segment only.
  return `${DEFAULT_HOST}/*/${lower}`;
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += "[^/]*(?:/[^/]*)*"; // ** crosses path separators
        i += 1;
      } else {
        out += "[^/]*"; // * stays within a segment
      }
      continue;
    }
    // Escape regex metacharacters.
    if (/[.+?^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out, "i");
}

/**
 * STRICT allowlist check. Returns true only when `remote` parses to a known slug
 * AND that slug matches at least one pattern. Unknown/unparseable remotes and an
 * empty pattern list are always blocked.
 */
export function isRemoteAllowed(
  remote: string | null | undefined,
  patterns: readonly string[],
): boolean {
  const slug = parseRemoteSlug(remote);
  if (!slug) return false;
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => matchesPattern(slug, pattern));
}

/** Parse the comma-separated env value into a clean list of patterns. */
export function parseAllowedRemotePatterns(rawEnv: string | null | undefined): string[] {
  if (typeof rawEnv !== "string") return [];
  return rawEnv
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Derive the SAFE default allowlist for a project from its configured repo
 * URLs. For each repo we permit:
 *   - the repo's own `owner/repo` (so the agent can push the same repo it was
 *     given — typically already a sandbox/test target), and
 *   - the `*-test` fork convention under the same owner (`owner/repo-test`,
 *     `owner/*-test`).
 *
 * We deliberately do NOT widen this to the whole owner; unknown repos under a
 * known owner stay blocked unless an operator opts in via the env allowlist.
 */
export function deriveDefaultAllowedPatterns(
  repoUrls: readonly (string | null | undefined)[],
): string[] {
  const patterns = new Set<string>();
  for (const repoUrl of repoUrls) {
    const slug = parseRemoteSlug(repoUrl);
    if (!slug) continue;
    patterns.add(`${slug.host}/${slug.owner}/${slug.repo}`);
    patterns.add(`${slug.host}/${slug.owner}/${slug.repo}-test`);
    patterns.add(`${slug.host}/${slug.owner}/*-test`);
  }
  return Array.from(patterns);
}

/**
 * Resolve the effective allowlist for a workspace: operator-provided env
 * patterns take precedence; when none are set we fall back to the patterns
 * derived from the project's repo URLs. The result may be empty (which means
 * "block everything" under strict matching) — that is the intended safe default
 * when neither source yields anything.
 */
export function resolveAllowedRemotePatterns(input: {
  envValue?: string | null;
  repoUrls?: readonly (string | null | undefined)[];
}): string[] {
  const fromEnv = parseAllowedRemotePatterns(input.envValue);
  if (fromEnv.length > 0) return fromEnv;
  return deriveDefaultAllowedPatterns(input.repoUrls ?? []);
}
