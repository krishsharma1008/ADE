import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono";

export function BrowserUseConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Python command" hint="Path to the Python 3 executable (default: python3).">
        <DraftInput
          value={
            isCreate
              ? values!.command ?? ""
              : eff("adapterConfig", "pythonCommand", String(config.pythonCommand ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ command: v })
              : mark("adapterConfig", "pythonCommand", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="python3"
        />
      </Field>

      <Field label="Browser type" hint="Browser engine to use: chromium, firefox, or webkit.">
        <select
          className={selectClass}
          value={
            isCreate
              ? "chromium"
              : eff("adapterConfig", "browserType", String(config.browserType ?? "chromium"))
          }
          onChange={(e) => mark("adapterConfig", "browserType", e.target.value)}
        >
          <option value="chromium">Chromium</option>
          <option value="firefox">Firefox</option>
          <option value="webkit">WebKit</option>
        </select>
      </Field>

      <Field label="Headless mode" hint="Run the browser without a visible window (default: on).">
        <select
          className={selectClass}
          value={
            isCreate
              ? "true"
              : eff("adapterConfig", "headless", config.headless !== false) ? "true" : "false"
          }
          onChange={(e) => mark("adapterConfig", "headless", e.target.value === "true")}
        >
          <option value="true">Yes (headless)</option>
          <option value="false">No (visible browser)</option>
        </select>
      </Field>

      <Field label="LLM provider" hint="LLM provider for browser agent decisions.">
        <select
          className={selectClass}
          value={
            isCreate
              ? "openai"
              : eff("adapterConfig", "llmProvider", String(config.llmProvider ?? "openai"))
          }
          onChange={(e) => mark("adapterConfig", "llmProvider", e.target.value)}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </Field>

      <Field label="Model" hint="LLM model name (e.g. gpt-4o, claude-sonnet-4-20250514).">
        <DraftInput
          value={
            isCreate
              ? values!.model ?? ""
              : eff("adapterConfig", "model", String(config.model ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ model: v })
              : mark("adapterConfig", "model", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="gpt-4o"
        />
      </Field>

      <Field label="Max steps" hint="Maximum number of browser automation steps (default: 50).">
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={50}
            readOnly
          />
        ) : (
          <DraftNumberInput
            value={eff("adapterConfig", "maxSteps", Number(config.maxSteps ?? 50))}
            onCommit={(v) => mark("adapterConfig", "maxSteps", v || 50)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
    </>
  );
}
