import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

const platform = os.platform();

export interface IDE {
  id: string;
  name: string;
  command: string;
}

const IDE_CANDIDATES: IDE[] = [
  { id: "vscode", name: "Visual Studio Code", command: "code" },
  { id: "cursor", name: "Cursor", command: "cursor" },
  { id: "zed", name: "Zed", command: "zed" },
  { id: "sublime", name: "Sublime Text", command: "subl" },
  { id: "vim", name: "Vim", command: "vim" },
];

async function commandExists(command: string): Promise<boolean> {
  const whichCmd = platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(whichCmd, [command]);
    return true;
  } catch {
    return false;
  }
}

export async function listAvailableIDEs(): Promise<IDE[]> {
  const results = await Promise.all(
    IDE_CANDIDATES.map(async (ide) => ({
      ide,
      available: await commandExists(ide.command),
    })),
  );
  return results.filter((r) => r.available).map((r) => r.ide);
}

export async function openInIDE(filePath: string, ideId?: string): Promise<void> {
  const resolved = validateFilePath(filePath);
  let ide: IDE | undefined;

  if (ideId) {
    ide = IDE_CANDIDATES.find((c) => c.id === ideId);
    if (!ide) throw new Error(`Unknown IDE: ${ideId}`);
    const available = await commandExists(ide.command);
    if (!available) throw new Error(`IDE command not found on PATH: ${ide.command}`);
  } else {
    const available = await listAvailableIDEs();
    ide = available[0];
    if (!ide) throw new Error("No supported IDE found on PATH");
  }

  await execFileAsync(ide.command, [resolved]);
}

export async function revealInFinder(filePath: string): Promise<void> {
  const resolved = validateFilePath(filePath);

  if (platform === "darwin") {
    await execFileAsync("open", ["-R", resolved]);
  } else if (platform === "win32") {
    await execFileAsync("explorer", [`/select,${resolved}`]);
  } else {
    // Linux: open the containing directory
    await execFileAsync("xdg-open", [dirname(resolved)]);
  }
}

export function validateFilePath(filePath: string): string {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
  return resolved;
}
