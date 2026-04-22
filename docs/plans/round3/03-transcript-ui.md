# Item #3 — Transcript UI

Phase 9 of Round 3.

## Problem

Prompts + responses are persisted (`heartbeat_run_events.payload` when `eventType='adapter.invoke'`, and `agent_transcripts` for per-role entries), but no UI reads them. Operators query the DB directly.

## Fix

1. New server route: `GET /heartbeat-runs/:runId/transcript` — paginated rows from `agent_transcripts` filtered by `runId`, ordered `seq ASC`. Company-scope via run lookup (Codex P3), NOT query params.

2. New React pages/tabs:
   - `/runs/:runId` — full-page transcript viewer with event timeline (left) + transcript entries (right).
   - `/issues/:issueId/runs` — tab on IssueDetail listing all runs for that issue.
   - `/agents/:agentId/runs` — tab on AgentDetail.

3. When an event is `adapter.invoke`, render `payload.prompt` in a collapsible monospace panel with search. Client-side redaction of `payload.env` keys matching `/TOKEN|KEY|SECRET|PASSWORD/i`.

4. Multi-turn: wrap adapter re-prompts with `onMeta({ turnIndex })` so each turn writes its own `adapter.invoke` event.

## Files

- Modify: `server/src/routes/heartbeats.ts`, `ui/src/api/heartbeats.ts`, `ui/src/App.tsx`, `ui/src/pages/IssueDetail.tsx`, `ui/src/pages/AgentDetail.tsx`, all six `packages/adapters/*/src/server/execute.ts`.
- New: `ui/src/pages/RunDetail.tsx`, `ui/src/components/transcript/{RoleBadge,TranscriptEntry,EventTimelineItem}.tsx`.

## Migrations

None — data already captured.

## Tests

- Cross-company transcript request → 403.
- Stub adapter emits 2 invoke turns → UI renders 2 panels with `turnIndex` labels.
- Playwright: expand `payload.env`, confirm secrets redacted.
