#!/usr/bin/env python3
"""
Combyne browser-use adapter runner.

Reads a JSON configuration from stdin, runs a browser-use Agent, and emits
structured JSON events to stdout for the adapter to parse.

Expected stdin JSON fields:
  - task (str): The task description for the browser agent.
  - model (str, optional): LLM model name (default: "gpt-4o").
  - llmProvider (str, optional): "openai" or "anthropic" (default: "openai").
  - browserType (str, optional): "chromium", "firefox", or "webkit" (default: "chromium").
  - headless (bool, optional): Whether to run headless (default: true).
  - maxSteps (int, optional): Maximum automation steps (default: 50).

Stdout protocol (one JSON object per line):
  {"type": "system", "subtype": "init", "adapter": "browser_use", "model": "<model>"}
  {"type": "assistant", "subtype": "step", "step": <n>, "action": "<desc>", "result": "<text>"}
  {"type": "result", "result": "<final text>", "is_error": false, "subtype": "success"}
  or on error:
  {"type": "result", "result": "<error message>", "is_error": true, "subtype": "error"}
"""

import json
import sys
import asyncio
import traceback


def emit(event: dict) -> None:
    """Write a JSON event line to stdout and flush immediately."""
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def build_llm(provider: str, model: str, api_key: str | None):
    """Instantiate the appropriate LangChain chat model."""
    if provider == "anthropic":
        try:
            from langchain_anthropic import ChatAnthropic
        except ImportError:
            emit({
                "type": "result",
                "result": "langchain-anthropic is not installed. Run: pip install langchain-anthropic",
                "is_error": True,
                "subtype": "error",
            })
            sys.exit(1)
        kwargs = {"model": model}
        if api_key:
            kwargs["api_key"] = api_key
        return ChatAnthropic(**kwargs)
    else:
        # Default to OpenAI
        try:
            from langchain_openai import ChatOpenAI
        except ImportError:
            emit({
                "type": "result",
                "result": "langchain-openai is not installed. Run: pip install langchain-openai",
                "is_error": True,
                "subtype": "error",
            })
            sys.exit(1)
        kwargs = {"model": model}
        if api_key:
            kwargs["api_key"] = api_key
        return ChatOpenAI(**kwargs)


async def run_agent(config: dict) -> None:
    """Run the browser-use agent with the given configuration."""
    try:
        from browser_use import Agent, BrowserConfig, Browser
    except ImportError:
        emit({
            "type": "result",
            "result": "browser-use is not installed. Run: pip install browser-use",
            "is_error": True,
            "subtype": "error",
        })
        return

    task = config.get("task", "")
    if not task:
        emit({
            "type": "result",
            "result": "No task provided in configuration.",
            "is_error": True,
            "subtype": "error",
        })
        return

    model_name = config.get("model", "gpt-4o")
    provider = config.get("llmProvider", "openai")
    api_key = config.get("apiKey") or None
    browser_type = config.get("browserType", "chromium")
    headless = config.get("headless", True)
    max_steps = config.get("maxSteps", 50)

    llm = build_llm(provider, model_name, api_key)

    # Emit init event
    emit({
        "type": "system",
        "subtype": "init",
        "adapter": "browser_use",
        "model": model_name,
        "browser_type": browser_type,
        "headless": headless,
    })

    # Configure browser
    browser_config = BrowserConfig(
        browser_type=browser_type,
        headless=headless,
    )
    browser = Browser(config=browser_config)

    step_count = 0

    def on_step(step_info):
        """Callback to emit step events."""
        nonlocal step_count
        step_count += 1
        action_desc = ""
        result_text = ""
        if hasattr(step_info, "action") and step_info.action:
            action_desc = str(step_info.action)
        if hasattr(step_info, "result") and step_info.result:
            result_text = str(step_info.result)
        emit({
            "type": "assistant",
            "subtype": "step",
            "step": step_count,
            "action": action_desc,
            "result": result_text,
        })

    try:
        agent = Agent(
            task=task,
            llm=llm,
            browser=browser,
        )

        result = await agent.run(max_steps=max_steps)

        # Extract final result text
        final_text = ""
        if result is not None:
            if hasattr(result, "final_result") and result.final_result:
                final_text = str(result.final_result())
            elif hasattr(result, "history") and result.history:
                # Emit step events for history entries
                for i, history_item in enumerate(result.history):
                    step_count += 1
                    action_desc = ""
                    result_text = ""
                    if hasattr(history_item, "model_output") and history_item.model_output:
                        mo = history_item.model_output
                        if hasattr(mo, "current_state") and mo.current_state:
                            cs = mo.current_state
                            if hasattr(cs, "next_goal"):
                                action_desc = str(cs.next_goal)
                        if hasattr(mo, "action") and mo.action:
                            for action in mo.action:
                                action_desc += f" {action}"
                    if hasattr(history_item, "result") and history_item.result:
                        for r in history_item.result:
                            if hasattr(r, "extracted_content") and r.extracted_content:
                                result_text += str(r.extracted_content)
                    emit({
                        "type": "assistant",
                        "subtype": "step",
                        "step": step_count,
                        "action": action_desc.strip(),
                        "result": result_text.strip(),
                    })

                # Try to get final result from last history entry
                if result.history:
                    last = result.history[-1]
                    if hasattr(last, "result") and last.result:
                        parts = []
                        for r in last.result:
                            if hasattr(r, "extracted_content") and r.extracted_content:
                                parts.append(str(r.extracted_content))
                        if parts:
                            final_text = "\n".join(parts)
            else:
                final_text = str(result)

        emit({
            "type": "result",
            "result": final_text or "Browser automation completed.",
            "is_error": False,
            "subtype": "success",
            "steps": step_count,
        })

    except Exception as exc:
        emit({
            "type": "result",
            "result": f"Browser-use agent error: {exc}",
            "is_error": True,
            "subtype": "error",
            "traceback": traceback.format_exc(),
        })
    finally:
        try:
            await browser.close()
        except Exception:
            pass


def main() -> None:
    """Entry point: read config from stdin and run the agent."""
    try:
        raw = sys.stdin.read()
        config = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        emit({
            "type": "result",
            "result": f"Invalid JSON input: {exc}",
            "is_error": True,
            "subtype": "error",
        })
        sys.exit(1)

    asyncio.run(run_agent(config))


if __name__ == "__main__":
    main()
