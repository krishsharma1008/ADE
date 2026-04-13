export const type = "browser_use";
export const label = "Browser Use (AI browser automation)";
export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# browser_use agent configuration

Adapter: browser_use

Core fields:
- pythonCommand (string, optional): Python executable path (default: "python3")
- browserType (string, optional): Browser to use: chromium, firefox, webkit (default: "chromium")
- headless (boolean, optional): Run browser headless (default: true)
- model (string, optional): LLM model to use for browser agent decisions
- apiKey (string, optional): API key for the LLM provider
- llmProvider (string, optional): LLM provider (openai, anthropic, etc.)
- maxSteps (number, optional): Maximum steps for browser automation (default: 50)
- cwd (string, optional): Working directory
- env (object, optional): KEY=VALUE environment variables
- timeoutSec (number, optional): Execution timeout in seconds (default: 300)
- graceSec (number, optional): SIGTERM grace period in seconds
`;
