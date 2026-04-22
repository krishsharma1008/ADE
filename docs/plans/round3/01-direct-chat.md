# Item #1 — Direct Chat with Agents (DEFERRED to Round 4)

Filed by Anurag: "For a system positioned as an 'agent operating system,' this interaction model is unintuitive. Ideally, users should be able to directly communicate with an agent without navigating through issues and comments."

## Status

Deferred. Round 3 keeps the existing `QuestionAnswerCard` + `ReplyAndWakeCard` on IssueDetail as the only reply surface. Round 4 will design and ship a proper chat affordance.

## Open questions for Round 4

- Ephemeral-issue backing vs a dedicated `agent_chat_sessions` table?
- Per-agent chat persistence vs per-issue thread vs both?
- Does a chat message route through the wake/heartbeat pipeline, or a new realtime path (SSE/WebSocket)?
- How do chat messages interact with the focus directive (Item #2)?
- Storage: reuse `agent_transcripts` with `kind='chat'`, or new table?

## References

- Existing reply surface: `ui/src/pages/IssueDetail.tsx:865-878` (ReplyAndWakeCard), `:1456-1506` (QuestionAnswerCard).
- Existing wake path: `POST /issues/:id/answer-question` in `server/src/routes/issues.ts:743-810`.
