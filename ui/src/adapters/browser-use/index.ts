import type { UIAdapterModule } from "../types";
import { parseBrowserUseStdoutLine } from "@combyne/adapter-browser-use/ui";
import { BrowserUseConfigFields } from "./config-fields";
import { buildBrowserUseConfig } from "@combyne/adapter-browser-use/ui";

export const browserUseUIAdapter: UIAdapterModule = {
  type: "browser_use",
  label: "Browser Use (AI browser automation)",
  parseStdoutLine: parseBrowserUseStdoutLine,
  ConfigFields: BrowserUseConfigFields,
  buildAdapterConfig: buildBrowserUseConfig,
};
