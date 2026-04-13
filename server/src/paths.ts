import fs from "node:fs";
import path from "node:path";
import { resolveDefaultConfigPath } from "./home-paths.js";

const COMBYNE_CONFIG_BASENAME = "config.json";
const COMBYNE_ENV_FILENAME = ".env";

function findConfigFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".combyne", COMBYNE_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveCombyneConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.COMBYNE_CONFIG)
    return path.resolve(process.env.COMBYNE_CONFIG);
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath();
}

export function resolveCombyneEnvPath(overrideConfigPath?: string): string {
  return path.resolve(path.dirname(resolveCombyneConfigPath(overrideConfigPath)), COMBYNE_ENV_FILENAME);
}
