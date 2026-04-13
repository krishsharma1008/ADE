import type { TranscriptEntry } from "@combyne/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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

export function parseBrowserUseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "system" && asString(parsed.subtype) === "init") {
    return [
      {
        kind: "init",
        ts,
        model: asString(parsed.model, "browser-use"),
        sessionId: "",
      },
    ];
  }

  if (type === "assistant") {
    const step = asNumber(parsed.step);
    const action = asString(parsed.action);
    const result = asString(parsed.result);
    const parts: string[] = [];
    if (step > 0) parts.push(`[Step ${step}]`);
    if (action) parts.push(action);
    if (result) parts.push(result);
    const text = parts.join(" ");
    if (text) {
      return [{ kind: "assistant", ts, text }];
    }
    return [{ kind: "stdout", ts, text: line }];
  }

  if (type === "result") {
    const isError = parsed.is_error === true;
    const text = asString(parsed.result);
    const subtype = asString(parsed.subtype, "result");
    const errors = isError ? [text].filter(Boolean) : [];
    return [
      {
        kind: "result",
        ts,
        text,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype,
        isError,
        errors,
      },
    ];
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
    return [{ kind: "stderr", ts, text: text || "error" }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
