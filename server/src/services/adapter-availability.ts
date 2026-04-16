import { findCommandOnPath } from "@combyne/adapter-utils/server-utils";
import type { AgentAdapterType } from "@combyne/shared";

export interface AdapterProbe {
  available: boolean;
  binary: string;
  resolvedPath: string | null;
  installHint: string;
  docsUrl: string | null;
  requiresCli: boolean;
}

interface AdapterProbeDef {
  adapterType: AgentAdapterType;
  binaries: string[];
  installHint: string;
  docsUrl: string | null;
  requiresCli: boolean;
}

const PROBE_DEFS: AdapterProbeDef[] = [
  {
    adapterType: "claude_local",
    binaries: ["claude"],
    installHint: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.claude.com/claude-code",
    requiresCli: true,
  },
  {
    adapterType: "codex_local",
    binaries: ["codex"],
    installHint: "npm install -g @openai/codex",
    docsUrl: "https://github.com/openai/codex",
    requiresCli: true,
  },
  {
    adapterType: "cursor",
    binaries: ["cursor-agent", "agent"],
    installHint: "curl https://cursor.com/install -fsS | bash",
    docsUrl: "https://docs.cursor.com/cli",
    requiresCli: true,
  },
  {
    adapterType: "gemini_local",
    binaries: ["gemini"],
    installHint: "npm install -g @google/gemini-cli",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    requiresCli: true,
  },
  {
    adapterType: "opencode_local",
    binaries: ["opencode"],
    installHint: "curl -fsSL https://opencode.ai/install | bash",
    docsUrl: "https://opencode.ai",
    requiresCli: true,
  },
  {
    adapterType: "pi_local",
    binaries: ["pi"],
    installHint: "Install the Pi CLI (see vendor docs).",
    docsUrl: null,
    requiresCli: true,
  },
  {
    adapterType: "process",
    binaries: [],
    installHint: "Built-in — no external CLI required.",
    docsUrl: null,
    requiresCli: false,
  },
  {
    adapterType: "http",
    binaries: [],
    installHint: "Built-in — no external CLI required.",
    docsUrl: null,
    requiresCli: false,
  },
  {
    adapterType: "openclaw_gateway",
    binaries: [],
    installHint: "Built-in HTTP gateway — no external CLI required.",
    docsUrl: null,
    requiresCli: false,
  },
];

export type AdapterAvailabilityMap = Record<string, AdapterProbe>;

let cached: { at: number; map: AdapterAvailabilityMap } | null = null;
const TTL_MS = 30_000;

async function probeOne(def: AdapterProbeDef): Promise<AdapterProbe> {
  if (!def.requiresCli) {
    return {
      available: true,
      binary: "",
      resolvedPath: null,
      installHint: def.installHint,
      docsUrl: def.docsUrl,
      requiresCli: false,
    };
  }

  for (const binary of def.binaries) {
    const resolved = await findCommandOnPath(binary);
    if (resolved) {
      return {
        available: true,
        binary,
        resolvedPath: resolved,
        installHint: def.installHint,
        docsUrl: def.docsUrl,
        requiresCli: true,
      };
    }
  }

  return {
    available: false,
    binary: def.binaries[0] ?? "",
    resolvedPath: null,
    installHint: def.installHint,
    docsUrl: def.docsUrl,
    requiresCli: true,
  };
}

export async function probeAdapterAvailability(
  opts: { forceRefresh?: boolean } = {},
): Promise<AdapterAvailabilityMap> {
  const now = Date.now();
  if (!opts.forceRefresh && cached && now - cached.at < TTL_MS) {
    return cached.map;
  }

  const entries = await Promise.all(
    PROBE_DEFS.map(async (def) => [def.adapterType, await probeOne(def)] as const),
  );
  const map = Object.fromEntries(entries) as AdapterAvailabilityMap;
  cached = { at: now, map };
  return map;
}

export function clearAdapterAvailabilityCache() {
  cached = null;
}
