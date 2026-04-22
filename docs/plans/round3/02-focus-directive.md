# Item #2 — Focus Directive + Queue Digest

Phase 2 of Round 3. Addresses "agent context bleeds across issues."

## Problem

`loadAssignedIssueQueue` (`server/src/services/agent-queue.ts`) returns every open issue the agent owns, concatenated into a single markdown blob capped at 8KB. The currently-woken issue is only marked `**current**`. Adapters emit this blob in the preamble without any directive that tells the model to focus on the current issue. Anurag's agents cross-referenced BUK-13, BUK-16, BUK-23 in a single run.

## Fix

1. Split queue rendering into:
   - `focusIssueMarkdown(currentId)` — full identifier + title + status + priority + updatedAt + body truncated to 512 chars. Leads with `## 🎯 Current focus: <id> — <title>` followed by `> Respond only to this issue. Other items below are context for awareness only.`
   - `queueDigestMarkdown(otherItems, limit=10)` — one-line summary per issue (drops the `**current**` marker), headed `## Other open issues (do not work on these unless explicitly reassigned)`.
   - Fallback when `currentIssueId` is null: digest only, no directive.

2. Plumb `currentIssueId` at `server/src/services/heartbeat.ts:1311`; if it doesn't resolve to a queue row, log `agent_queue.current_issue_missing` and fall back to digest-only.

3. Per-agent `focusMode` config on `agents.adapterConfig` (default `true`). When `false`, old behavior preserved.

4. New shared helper `packages/adapter-utils/src/preamble.ts` exposes `composeFocusPreamble(segments)` so all six adapters inject the focus directive as the FIRST segment (before company/skills/projects).

## Files

- Modify: `server/src/services/agent-queue.ts`, `server/src/services/heartbeat.ts`, all six `packages/adapters/*/src/server/execute.ts`, `server/src/services/__tests__/agent-queue.test.ts`.
- New: `packages/adapter-utils/src/preamble.ts`.

## Tests

- Unit: focus heading present; digest excludes current; fallback when `currentIssueId` null.
- Integration: stub-adapter run → inspect `heartbeat_run_events.payload.prompt` for the focus heading + directive.
- Playwright: assign 3 issues, wake middle → first 2000 chars contain focus id only.

## Prereq

Phase 0 `OPEN_STATUSES` fix must land first, otherwise todo/in_review issues remain invisible regardless of the focus directive.
