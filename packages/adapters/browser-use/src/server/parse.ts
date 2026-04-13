import { parseJson, asString } from "@combyne/adapter-utils/server-utils";

export interface BrowserUseOutputResult {
  initEvent: Record<string, unknown> | null;
  stepEvents: Record<string, unknown>[];
  resultEvent: Record<string, unknown> | null;
  summary: string;
  errorMessage: string | null;
}

/**
 * Parse the newline-delimited JSON output from the browser-use Python runner.
 * Each line is a JSON object with a `type` field.
 */
export function parseBrowserUseOutput(stdout: string): BrowserUseOutputResult {
  let initEvent: Record<string, unknown> | null = null;
  const stepEvents: Record<string, unknown>[] = [];
  let resultEvent: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");

    if (type === "system" && asString(event.subtype, "") === "init") {
      initEvent = event;
      continue;
    }

    if (type === "assistant") {
      stepEvents.push(event);
      const action = asString(event.action, "");
      const result = asString(event.result, "");
      if (action || result) {
        assistantTexts.push([action, result].filter(Boolean).join(": "));
      }
      continue;
    }

    if (type === "result") {
      resultEvent = event;
    }
  }

  const isError = resultEvent?.is_error === true;
  const resultText = resultEvent ? asString(resultEvent.result, "") : "";

  return {
    initEvent,
    stepEvents,
    resultEvent,
    summary: isError ? "" : (resultText || assistantTexts.join("\n")).trim(),
    errorMessage: isError ? resultText : null,
  };
}
