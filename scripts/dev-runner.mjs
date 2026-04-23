#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "watch" ? "watch" : "dev";
const cliArgs = process.argv.slice(3);

const tailscaleAuthFlagNames = new Set([
  "--tailscale-auth",
  "--authenticated-private",
]);

let tailscaleAuth = false;
const forwardedArgs = [];

for (const arg of cliArgs) {
  if (tailscaleAuthFlagNames.has(arg)) {
    tailscaleAuth = true;
    continue;
  }
  forwardedArgs.push(arg);
}

if (process.env.npm_config_tailscale_auth === "true") {
  tailscaleAuth = true;
}
if (process.env.npm_config_authenticated_private === "true") {
  tailscaleAuth = true;
}

const env = {
  ...process.env,
  COMBYNE_UI_DEV_MIDDLEWARE: "true",
};

if (tailscaleAuth) {
  env.COMBYNE_DEPLOYMENT_MODE = "authenticated";
  env.COMBYNE_DEPLOYMENT_EXPOSURE = "private";
  env.COMBYNE_AUTH_BASE_URL_MODE = "auto";
  env.HOST = "0.0.0.0";
  console.log("[combyne] dev mode: authenticated/private (tailscale-friendly) on 0.0.0.0");
} else {
  console.log("[combyne] dev mode: local_trusted (default)");
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

// Preflight: detect stale workspace installs. When a teammate pulls code that
// introduces a new workspace package (e.g. @combyne/context-budget) and runs
// `pnpm dev` without first running `pnpm install`, node fails with a cryptic
// `ERR_MODULE_NOT_FOUND`. Scan the server's workspace:* deps against the
// linked node_modules and auto-heal if anything is missing or outdated.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collectMissingWorkspaceLinks() {
  const pkgPath = resolve(repoRoot, "server/package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return [];
  }
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const missing = [];
  for (const [name, spec] of Object.entries(allDeps)) {
    if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
    const linkPath = resolve(repoRoot, "server/node_modules", name);
    try {
      statSync(linkPath);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

function lockfileNewerThanInstall() {
  try {
    const lock = statSync(resolve(repoRoot, "pnpm-lock.yaml")).mtimeMs;
    const marker = statSync(resolve(repoRoot, "node_modules/.modules.yaml")).mtimeMs;
    return lock > marker + 1000;
  } catch {
    return false;
  }
}

const missingLinks = collectMissingWorkspaceLinks();
const staleInstall = lockfileNewerThanInstall();

if (missingLinks.length > 0 || staleInstall) {
  if (missingLinks.length > 0) {
    console.log(
      `[combyne] missing workspace deps: ${missingLinks.join(", ")} — running pnpm install…`,
    );
  } else {
    console.log("[combyne] pnpm-lock.yaml changed since last install — running pnpm install…");
  }
  const install = spawnSync(pnpmBin, ["install"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (install.status !== 0) {
    console.error("[combyne] pnpm install failed — aborting dev start.");
    process.exit(install.status ?? 1);
  }
}

const serverScript = mode === "watch" ? "dev:watch" : "dev";
const child = spawn(
  pnpmBin,
  ["--filter", "@combyne/server", serverScript, ...forwardedArgs],
  { stdio: "inherit", env, shell: process.platform === "win32" },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
