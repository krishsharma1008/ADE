// gh CLI detection for the integrations Test flow. Local adapters run on this
// host, so the agents' `gh` is THIS machine's `gh` — checking `gh auth status`
// server-side tells the operator whether agent git/PR flows will actually work,
// not just whether the REST token is valid. Best-effort by design: a missing or
// unauthenticated CLI is reported, never thrown into the route.

import { execFile } from "node:child_process";

export interface GhCliStatus {
  available: boolean;
  authenticated: boolean;
  /** First "Logged in to <host> account <login>" account, when authenticated. */
  login: string | null;
  error: string | null;
}

const GH_TIMEOUT_MS = 5000;

function runGh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      { timeout: GH_TIMEOUT_MS, env: process.env },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as NodeJS.ErrnoException).code as unknown as number)
            : err
              ? 1
              : 0;
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ code: -1, stdout: "", stderr: "ENOENT" });
          return;
        }
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

export async function testGhCli(): Promise<GhCliStatus> {
  try {
    const result = await runGh(["auth", "status"]);
    if (result.stderr === "ENOENT" && result.code === -1) {
      return {
        available: false,
        authenticated: false,
        login: null,
        error: "gh CLI not found on the server host (agents will not be able to push or open PRs via gh)",
      };
    }
    const output = `${result.stdout}\n${result.stderr}`;
    const loginMatch = /account\s+(\S+)/.exec(output);
    if (result.code === 0) {
      return {
        available: true,
        authenticated: true,
        login: loginMatch?.[1] ?? null,
        error: null,
      };
    }
    return {
      available: true,
      authenticated: false,
      login: null,
      error: output.trim().slice(0, 300) || "gh auth status reported no authenticated account",
    };
  } catch (err) {
    return {
      available: false,
      authenticated: false,
      login: null,
      error: (err as Error).message,
    };
  }
}
