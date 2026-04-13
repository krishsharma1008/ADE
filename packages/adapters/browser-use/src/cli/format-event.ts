import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function printBrowserUseStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);

  if (type === "system" && asString(parsed.subtype) === "init") {
    const model = asString(parsed.model, "unknown");
    const browserType = asString(parsed.browser_type, "chromium");
    const headless = parsed.headless !== false;
    console.log(
      pc.blue(
        `Browser Use initialized (model: ${model}, browser: ${browserType}, headless: ${headless})`,
      ),
    );
    return;
  }

  if (type === "assistant") {
    const step = asNumber(parsed.step);
    const action = asString(parsed.action);
    const result = asString(parsed.result);
    const prefix = step > 0 ? `[Step ${step}] ` : "";
    if (action) {
      console.log(pc.yellow(`${prefix}action: ${action}`));
    }
    if (result) {
      console.log(pc.green(`${prefix}result: ${result}`));
    }
    return;
  }

  if (type === "result") {
    const isError = parsed.is_error === true;
    const resultText = asString(parsed.result);
    const subtype = asString(parsed.subtype, "result");
    const steps = asNumber(parsed.steps);

    if (isError) {
      console.log(pc.red(`browser_use_error: ${subtype}`));
      if (resultText) console.log(pc.red(resultText));
    } else {
      if (resultText) {
        console.log(pc.green("result:"));
        console.log(resultText);
      }
      if (steps > 0) {
        console.log(pc.blue(`completed in ${steps} steps`));
      }
    }
    return;
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
    if (text) console.log(pc.red(`error: ${text}`));
    return;
  }

  console.log(line);
}
