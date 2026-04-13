import type { CLIAdapterModule } from "@combyne/adapter-utils";
import { printClaudeStreamEvent } from "@combyne/adapter-claude-local/cli";
import { printCodexStreamEvent } from "@combyne/adapter-codex-local/cli";
import { printCursorStreamEvent } from "@combyne/adapter-cursor-local/cli";
import { printOpenCodeStreamEvent } from "@combyne/adapter-opencode-local/cli";
import { printPiStreamEvent } from "@combyne/adapter-pi-local/cli";
import { printOpenClawGatewayStreamEvent } from "@combyne/adapter-openclaw-gateway/cli";
import { printBrowserUseStreamEvent } from "@combyne/adapter-browser-use/cli";
import { processCLIAdapter } from "./process/index.js";
import { httpCLIAdapter } from "./http/index.js";

const claudeLocalCLIAdapter: CLIAdapterModule = {
  type: "claude_local",
  formatStdoutEvent: printClaudeStreamEvent,
};

const codexLocalCLIAdapter: CLIAdapterModule = {
  type: "codex_local",
  formatStdoutEvent: printCodexStreamEvent,
};

const openCodeLocalCLIAdapter: CLIAdapterModule = {
  type: "opencode_local",
  formatStdoutEvent: printOpenCodeStreamEvent,
};

const piLocalCLIAdapter: CLIAdapterModule = {
  type: "pi_local",
  formatStdoutEvent: printPiStreamEvent,
};

const cursorLocalCLIAdapter: CLIAdapterModule = {
  type: "cursor",
  formatStdoutEvent: printCursorStreamEvent,
};

const openclawGatewayCLIAdapter: CLIAdapterModule = {
  type: "openclaw_gateway",
  formatStdoutEvent: printOpenClawGatewayStreamEvent,
};

const browserUseCLIAdapter: CLIAdapterModule = {
  type: "browser_use",
  formatStdoutEvent: printBrowserUseStreamEvent,
};

const adaptersByType = new Map<string, CLIAdapterModule>(
  [
    claudeLocalCLIAdapter,
    codexLocalCLIAdapter,
    openCodeLocalCLIAdapter,
    piLocalCLIAdapter,
    cursorLocalCLIAdapter,
    openclawGatewayCLIAdapter,
    browserUseCLIAdapter,
    processCLIAdapter,
    httpCLIAdapter,
  ].map((a) => [a.type, a]),
);

export function getCLIAdapter(type: string): CLIAdapterModule {
  return adaptersByType.get(type) ?? processCLIAdapter;
}
