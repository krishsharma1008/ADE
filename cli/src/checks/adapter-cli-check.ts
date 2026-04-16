import { findCommandOnPath } from "@combyne/adapter-utils/server-utils";
import type { CheckResult } from "./index.js";

interface AdapterDef {
  label: string;
  binaries: string[];
  installHint: string;
}

const ADAPTERS: AdapterDef[] = [
  {
    label: "Claude Code",
    binaries: ["claude"],
    installHint: "npm install -g @anthropic-ai/claude-code",
  },
  {
    label: "Codex",
    binaries: ["codex"],
    installHint: "npm install -g @openai/codex",
  },
  {
    label: "Cursor",
    binaries: ["cursor-agent", "agent"],
    installHint: "curl https://cursor.com/install -fsS | bash",
  },
  {
    label: "Gemini",
    binaries: ["gemini"],
    installHint: "npm install -g @google/gemini-cli",
  },
  {
    label: "OpenCode",
    binaries: ["opencode"],
    installHint: "curl -fsSL https://opencode.ai/install | bash",
  },
  {
    label: "Pi",
    binaries: ["pi"],
    installHint: "Install the Pi CLI from vendor docs",
  },
];

export async function adapterCliCheck(): Promise<CheckResult> {
  const results = await Promise.all(
    ADAPTERS.map(async (def) => {
      for (const binary of def.binaries) {
        const resolved = await findCommandOnPath(binary);
        if (resolved) {
          return { def, binary, resolved };
        }
      }
      return { def, binary: def.binaries[0], resolved: null };
    }),
  );

  const installed = results.filter((r) => r.resolved !== null);
  const missing = results.filter((r) => r.resolved === null);

  const installedSummary = installed
    .map((r) => `${r.def.label} (${r.binary})`)
    .join(", ");
  const missingSummary = missing
    .map((r) => `${r.def.label} [${r.def.installHint}]`)
    .join(" · ");

  if (installed.length === 0) {
    return {
      name: "Adapter CLIs",
      status: "fail",
      message: "No agent adapter CLIs found on PATH — agents cannot run until at least one is installed",
      canRepair: false,
      repairHint: `Install one of: ${missingSummary}`,
    };
  }

  if (missing.length === 0) {
    return {
      name: "Adapter CLIs",
      status: "pass",
      message: `All adapter CLIs available: ${installedSummary}`,
    };
  }

  return {
    name: "Adapter CLIs",
    status: "warn",
    message: `Installed: ${installedSummary}. Missing (optional): ${missing.map((r) => r.def.label).join(", ")}`,
    canRepair: false,
    repairHint: `Install missing CLIs if needed: ${missingSummary}`,
  };
}
