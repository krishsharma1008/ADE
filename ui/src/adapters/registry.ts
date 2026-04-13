import type { UIAdapterModule } from "./types";
import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { cursorLocalUIAdapter } from "./cursor";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { piLocalUIAdapter } from "./pi-local";
import { openClawGatewayUIAdapter } from "./openclaw-gateway";
import { processUIAdapter } from "./process";
import { httpUIAdapter } from "./http";
import { geminiLocalUIAdapter } from "./gemini-local";
import { browserUseUIAdapter } from "./browser-use";

const adaptersByType = new Map<string, UIAdapterModule>(
  [
    claudeLocalUIAdapter,
    codexLocalUIAdapter,
    openCodeLocalUIAdapter,
    piLocalUIAdapter,
    cursorLocalUIAdapter,
    openClawGatewayUIAdapter,
    geminiLocalUIAdapter,
    browserUseUIAdapter,
    processUIAdapter,
    httpUIAdapter,
  ].map((a) => [a.type, a]),
);

export function getUIAdapter(type: string): UIAdapterModule {
  return adaptersByType.get(type) ?? processUIAdapter;
}

export function listUIAdapters(): UIAdapterModule[] {
  return Array.from(adaptersByType.values());
}
