# Agent Adapter Implementation Instructions

Use this file when asking another Codex or engineer to add a new Combyne/ADE agent adapter. It explains how the current Claude and Codex adapters are wired, what to copy, and what to be careful about.

## How ADE Uses An Adapter

An adapter is the boundary between the Combyne control plane and an external agent runtime such as Claude Code, Codex CLI, Cursor, OpenCode, or a custom process.

The runtime path is:

1. A heartbeat or manual wake creates a run in the server.
2. `server/src/services/heartbeat.ts` resolves the issue, context sections, task session, and execution workspace.
3. The server looks up the adapter in `server/src/adapters/registry.ts`.
4. The server calls `adapter.execute(ctx)` with:
   - `runId`
   - `agent`
   - `runtime.sessionParams`
   - `agent.adapterConfig`
   - `context`
   - `authToken`
   - `onLog(...)` for live transcript output
   - `onMeta(...)` for command/prompt/runtime metadata
5. The adapter builds a prompt and environment, runs the external command, parses output, and returns `AdapterExecutionResult`.
6. The server stores logs, summary, usage, cost metadata, session params, and issue finalization state.

The UI and CLI use the same adapter package for display:

- Server registry: `server/src/adapters/registry.ts`
- UI registry: `ui/src/adapters/registry.ts`
- CLI registry: `cli/src/adapters/registry.ts`

## Existing Claude And Codex Adapter Shape

Both adapters live under `packages/adapters/` and expose the same four package entry points:

```text
packages/adapters/<adapter-name>/
  package.json
  src/index.ts
  src/server/index.ts
  src/server/execute.ts
  src/server/parse.ts
  src/server/test.ts
  src/ui/index.ts
  src/ui/build-config.ts
  src/ui/parse-stdout.ts
  src/cli/index.ts
  src/cli/format-event.ts
```

The package export convention is:

```json
{
  "name": "@combyne/adapter-<name>",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server/index.ts",
    "./ui": "./src/ui/index.ts",
    "./cli": "./src/cli/index.ts"
  }
}
```

The root `src/index.ts` must stay browser-safe and dependency-light. It exports:

- `type`
- `label`
- `models`
- defaults, if useful
- `agentConfigurationDoc`

## Fast Path For A New Codex-Like Adapter

If the new adapter is another local CLI agent, start by copying `packages/adapters/codex-local` rather than Claude. Codex is the simpler base because it already uses stdin prompts, JSONL output parsing, model reasoning effort config, local skill injection, and session retry behavior.

1. Copy the package:

```sh
cp -R packages/adapters/codex-local packages/adapters/<new-name>
```

2. Rename package metadata:

- `packages/adapters/<new-name>/package.json`
- `src/index.ts`
- exported `type`
- UI label
- model defaults

3. Add the package dependency where needed:

- `server/package.json`
- `ui/package.json`
- `cli/package.json`

4. Register server execution:

Edit `server/src/adapters/registry.ts`.

Add imports from `@combyne/adapter-<new-name>` and `@combyne/adapter-<new-name>/server`, then add a `ServerAdapterModule`:

```ts
const newAdapter: ServerAdapterModule = {
  type: "<new_type>",
  execute: newExecute,
  testEnvironment: newTestEnvironment,
  sessionCodec: newSessionCodec,
  models: newModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: newAgentConfigurationDoc,
};
```

Add it to `adaptersByType`.

5. Register UI:

Create `ui/src/adapters/<new-name>/index.ts` and optional `config-fields.tsx`, or mirror `ui/src/adapters/codex-local`.

Add it to `ui/src/adapters/registry.ts`.

6. Register CLI formatting:

Add imports and a module entry in `cli/src/adapters/registry.ts`.

7. Add shared adapter type if the adapter appears in API validators/constants:

Check `packages/shared/src/constants.ts` and any validator that enumerates adapter types.

8. Implement command execution in `src/server/execute.ts`:

- Resolve `command` from config, defaulting to the CLI binary name.
- Resolve cwd from `context.combyneWorkspace.cwd`, then `config.cwd`, then `process.cwd()`.
- Call `ensureAbsoluteDirectory(cwd, { createIfMissing: true })`.
- Build Combyne env with `buildCombyneEnv(agent)`.
- Set `COMBYNE_RUN_ID`.
- Set task/wake env values when present:
  - `COMBYNE_TASK_ID`
  - `COMBYNE_WAKE_REASON`
  - `COMBYNE_WAKE_COMMENT_ID`
  - `COMBYNE_APPROVAL_ID`
  - `COMBYNE_APPROVAL_STATUS`
  - `COMBYNE_LINKED_ISSUE_IDS`
  - `COMBYNE_WORKSPACE_CWD`
  - `COMBYNE_WORKSPACE_SOURCE`
  - `COMBYNE_WORKSPACE_ID`
  - `COMBYNE_WORKSPACE_REPO_URL`
  - `COMBYNE_WORKSPACE_REPO_REF`
  - `COMBYNE_WORKSPACES_JSON`
- Merge adapter `config.env` after default Combyne env.
- Inject `authToken` as `COMBYNE_API_KEY` only when the adapter config did not explicitly set one.
- Use `ensurePathInEnv` and `ensureCommandResolvable`.
- Run the child process with `runChildProcess`.
- Send live output through `onLog`.
- Send command metadata through `onMeta`.

9. Preserve session behavior:

The session params must include cwd. Resume only when the saved session cwd matches the current resolved cwd. If the external runtime reports an unknown session/thread, retry once with a fresh session and clear the old session.

Use this shape:

```ts
sessionParams: {
  sessionId,
  cwd,
  workspaceId,
  repoUrl,
  repoRef,
}
```

10. Implement output parsing:

Create `src/server/parse.ts` with a small parser that returns:

- `sessionId`
- `summary`
- `usage`
- `errorMessage`

Avoid dumping raw logs as the summary. The summary should be readable agent output only.

11. Implement `testEnvironment`.

This powers the UI "Test environment" button. Do not throw for expected missing setup. Return structured checks:

- `pass` when usable
- `warn` for non-blocking oddities
- `fail` for missing command, invalid cwd, or unusable auth/runtime

12. Add tests.

Minimum tests:

- parse output
- unknown session detection
- session codec
- command args/env metadata
- environment test
- UI stdout parser
- CLI event formatter, if non-trivial
- registry/model listing if needed

Run:

```sh
pnpm --filter @combyne/adapter-<new-name> typecheck
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Prompt And Context Rules

Both Claude and Codex adapters construct a prompt from context sections before appending `promptTemplate`.

Keep this ordering pattern:

1. `combyneFocusDirective`
2. bootstrap or handoff
3. memory
4. coordinator guidance
5. governance, if any
6. assigned issue queue
7. git state
8. company projects
9. hire playbook
10. rendered prompt template

This ordering matters. The focus directive must stay first so an agent with many assignments works on the intended issue.

When using isolated issue worktrees, do not expose primary checkout paths as writable paths. The heartbeat service redacts project workspace cwd hints for isolated runs; do not reintroduce those paths in adapter metadata or prompt text.

## Codex Adapter Notes

Current Codex command shape:

```sh
codex exec --json [--search] [--dangerously-bypass-approvals-and-sandbox] [--model <model>] [-c model_reasoning_effort="<effort>"] -
```

For resume:

```sh
codex exec --json ... resume <session-id> -
```

Important details:

- Prompt is piped on stdin.
- The final prompt arg is `-`.
- Skills are symlinked into `$CODEX_HOME/skills` or `~/.codex/skills`.
- `OPENAI_API_KEY` means API billing/auth; otherwise local Codex login/subscription is used.
- `stripCodexRolloutNoise` filters known non-fatal Codex stderr lines so successful runs do not show scary red errors.
- Parser reads JSONL events:
  - `thread.started` for session id
  - `item.completed` with `agent_message` for summary
  - `turn.completed` for usage
  - `turn.failed` or `error` for error messages
- Some model/search/effort combinations are invalid. Treat these as environment/config warnings or clear runtime errors.

## Claude Adapter Notes And Gotchas

Current Claude command shape:

```sh
claude --print - --output-format stream-json --verbose [--resume <session-id>] [--dangerously-skip-permissions] [--chrome] [--model <model>] [--effort <effort>] [--max-turns <n>]
```

Important Claude-specific behavior:

- Claude uses `--print -`, not `exec --json`.
- Claude output is stream JSON, not Codex JSONL.
- Claude session id comes from `system/init`, assistant events, or final `result`.
- Usage fields differ from Codex:
  - `input_tokens`
  - `cache_read_input_tokens`
  - `output_tokens`
- Claude can return `error_max_turns` or `stop_reason=max_turns`; treat that as an actionable run outcome, not as random log text.
- Claude login handling is special. The adapter can detect login-required output and expose a login URL.
- `ANTHROPIC_API_KEY` means API-key auth and should generally be a warning in environment tests, not a hard failure, because local subscription auth may still be valid without it.
- `instructionsFilePath` is injected through `--append-system-prompt-file`. Claude does not allow every prompt flag combination, so the adapter writes a combined temporary instructions file that includes the path directive.
- Claude skills are exposed through a temporary `.claude/skills` directory and `--add-dir`.
- Claude also uses `--add-dir` for allowed project workspace dirs when Combyne provides them. Be careful: with isolated worktrees, do not pass shared primary repo dirs as extra writeable dirs.
- Claude `--dangerously-skip-permissions` is not the same flag as Codex's sandbox bypass flag. Keep config names distinct:
  - Claude: `dangerouslySkipPermissions`
  - Codex: `dangerouslyBypassApprovalsAndSandbox`
- Claude parser should never surface raw stdout tails as user-facing messages. Keep summaries to assistant/result text.

## Cross-Adapter Safety Requirements

Every local coding adapter should keep these protections:

- Use the Combyne merge guard PATH shim to block direct protected-branch merges via `git merge` and `gh pr merge`.
- Respect resolved execution workspace cwd, especially isolated issue worktrees.
- Do not resume sessions across different cwd values.
- Do not leak secrets in `onMeta`; use `redactEnvForLogs`.
- Prefer structured summaries over raw logs.
- Preserve `COMBYNE_API_KEY` injection so agents can call Combyne APIs.
- Return usage and session info whenever the runtime exposes them.
- Keep error messages short and actionable.

## Files To Check Before Hand-Off

For a new adapter, inspect or update:

- `packages/adapters/<new-name>/src/index.ts`
- `packages/adapters/<new-name>/src/server/execute.ts`
- `packages/adapters/<new-name>/src/server/parse.ts`
- `packages/adapters/<new-name>/src/server/test.ts`
- `packages/adapters/<new-name>/src/ui/build-config.ts`
- `packages/adapters/<new-name>/src/ui/parse-stdout.ts`
- `packages/adapters/<new-name>/src/cli/format-event.ts`
- `server/src/adapters/registry.ts`
- `ui/src/adapters/registry.ts`
- `cli/src/adapters/registry.ts`
- `packages/shared/src/constants.ts`
- package dependencies in `server/package.json`, `ui/package.json`, and `cli/package.json`

## Definition Of Done

The adapter is ready when:

- It appears in the UI adapter selector.
- The environment test gives useful structured diagnostics.
- A run can start, stream logs, finish, and persist a readable summary.
- Session resume works for the same cwd.
- Session resume is skipped or retried cleanly for a different/missing cwd.
- Usage metadata is captured when available.
- It works in isolated issue worktrees without touching the primary checkout.
- `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` pass.
