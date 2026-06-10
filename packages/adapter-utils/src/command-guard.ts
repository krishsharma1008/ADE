// Shared per-run gh/git command guard (WS-B, e2e-run-2026-06-10). Replaces the
// byte-identical buildMergeGuardDir copies in claude-local and codex-local and
// extends them with capability-driven blocks: the server resolves the company's
// GitHub agentCapabilities, injects COMBYNE_GH_CAN_* env flags into the run, and
// this generator turns flags into PATH-shim blocks. Absent flags reproduce the
// historical script exactly (merge blocked, push/PR-create allowed).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CommandGuardCapabilities {
  canPush: boolean;
  canRaisePr: boolean;
  canMergePr: boolean;
}

export const COMMAND_GUARD_ENV_KEYS = {
  canPush: "COMBYNE_GH_CAN_PUSH",
  canRaisePr: "COMBYNE_GH_CAN_RAISE_PR",
  canMergePr: "COMBYNE_GH_CAN_MERGE_PR",
} as const;

function readFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

/** Defaults preserve current behavior: push/raise-PR allowed, merge blocked. */
export function readCommandGuardCapabilitiesFromEnv(
  env: Record<string, string | undefined>,
): CommandGuardCapabilities {
  return {
    canPush: readFlag(env[COMMAND_GUARD_ENV_KEYS.canPush], true),
    canRaisePr: readFlag(env[COMMAND_GUARD_ENV_KEYS.canRaisePr], true),
    canMergePr: readFlag(env[COMMAND_GUARD_ENV_KEYS.canMergePr], false),
  };
}

/** Env record for the server to inject when it resolved company capabilities. */
export function commandGuardEnvFromCapabilities(
  caps: Partial<CommandGuardCapabilities>,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (caps.canPush !== undefined) env[COMMAND_GUARD_ENV_KEYS.canPush] = String(caps.canPush);
  if (caps.canRaisePr !== undefined) env[COMMAND_GUARD_ENV_KEYS.canRaisePr] = String(caps.canRaisePr);
  if (caps.canMergePr !== undefined) env[COMMAND_GUARD_ENV_KEYS.canMergePr] = String(caps.canMergePr);
  return env;
}

export function renderCommandGuardScript(
  tool: "gh" | "git",
  guardDir: string,
  caps: CommandGuardCapabilities,
): string {
  const ghMergeBlock = caps.canMergePr
    ? ""
    : `  if [[ "\${1:-}" == "pr" && "\${2:-}" == "merge" ]]; then
    echo "[combyne] Blocked gh pr merge. Request merge from the Combyne dashboard PR panel after checks pass." >&2
    exit 78
  fi
  if [[ "$*" == *"/pulls/"*"/merge"* ]]; then
    echo "[combyne] Blocked direct GitHub pull merge API call. Request dashboard merge instead." >&2
    exit 78
  fi
`;
  const ghCreatePrBlock = caps.canRaisePr
    ? ""
    : `  if [[ "\${1:-}" == "pr" && "\${2:-}" == "create" ]]; then
    echo "[combyne] Blocked gh pr create: raising PRs is disabled for agents by company policy (Integrations > Agent Capabilities)." >&2
    exit 78
  fi
`;
  const gitPushBlock = caps.canPush
    ? ""
    : `if [[ "$tool" == "git" && "\${1:-}" == "push" ]]; then
  echo "[combyne] Blocked git push: pushing is disabled for agents by company policy (Integrations > Agent Capabilities)." >&2
  exit 78
fi
`;
  const gitMergeBlock = caps.canMergePr
    ? ""
    : `if [[ "$tool" == "git" && "\${1:-}" == "merge" ]]; then
  for arg in "$@"; do
    case "$arg" in
      main|master|develop|development|origin/main|origin/master|origin/develop|origin/development)
        echo "[combyne] Blocked direct git merge into a protected base branch. Request dashboard merge instead." >&2
        exit 78
        ;;
    esac
  done
fi
`;
  return `#!/usr/bin/env bash
set -euo pipefail
COMBYNE_GUARD_DIR=${JSON.stringify(guardDir)}
tool=${JSON.stringify(tool)}
if [[ "$tool" == "gh" ]]; then
${ghMergeBlock}${ghCreatePrBlock}fi
${gitMergeBlock}${gitPushBlock}export PATH="\${PATH#$COMBYNE_GUARD_DIR:}"
command "$tool" "$@"
`;
}

/**
 * Materialize the guard dir for a run. Prepend the returned path to PATH so the
 * shims intercept gh/git; each shim strips the dir before delegating so nested
 * invocations hit the real binaries.
 */
export async function buildCommandGuardDir(
  runId: string,
  caps: CommandGuardCapabilities,
): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-merge-guard-"));
  for (const tool of ["gh", "git"] as const) {
    const target = path.join(tmp, tool);
    await fs.writeFile(target, renderCommandGuardScript(tool, tmp, caps), "utf8");
    await fs.chmod(target, 0o755);
  }
  await fs.writeFile(
    path.join(tmp, "README.txt"),
    `Combyne command guard for run ${runId}\n`,
    "utf8",
  );
  return tmp;
}
