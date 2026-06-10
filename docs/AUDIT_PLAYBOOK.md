# ADE Audit Playbook

Why this exists: the 2026-06-10 pre-handoff audit (4 parallel sweeps, 11 fixes) still missed 5 bugs that live use found within hours. Each miss maps to a coverage class the audit didn't have. Future audits run ALL of these classes.

## Hard rules

1. **Never downgrade a finding without an empirical test.** The merge-button bug (#16) was *found* by the audit and triaged away untested. If a finding is demoted to "note", the demotion must cite the command/test that proved it benign.
2. **Every audit claim is verified against live behavior, not just code.** Code-reading finds structure; only oracle-based probes (expected vs. actual on real data) find ranking, ordering, and staleness bugs (cf. both memory-recall bugs).

## Coverage classes (run every one)

### A. Flow audits (what we already did)
Per flow: transitions, side effects, failure-swallowing, UI surfacing. Four lenses: wake/notification delivery, PR/approval lifecycle, memory/context flows, UI state surfacing.

### B. State-machine lifecycle audits (missed → #20)
For EVERY status-like field (`agents.status`, `issues.status`, `heartbeat_runs.status`, `issue_pull_requests.mergeStatus/feedbackStatus`, `approvals.status`, `memory_entries.verificationState`):
- Enumerate every SET site and every CLEAR/overwrite site.
- For each value: what re-enters the normal state? Flag any value that can be set but is only cleared by an unrelated/late checkpoint ("set-without-clear asymmetry").
- For each pair of concurrent writers: who wins, and is that intended?

### C. Idempotency & retry matrix (missed → #18)
For every mutating endpoint agents or automations call (delegate, create issue, track PR, wakeup, comment, approvals): what happens when the call is retried after an ambiguous failure? Required answer per endpoint: idempotent / duplicate-safe / DUPLICATES (bug). Anything in the third bucket gets an idempotency key or a natural-key guard.

### D. Process-lifecycle (chaos) audits (missed → #15)
Restart the server mid-run (dev tsx reload counts) and verify: in-flight runs are recovered or requeued, queued wakes survive, no issue is stranded in a working status with no run. Also: what does boot do with rows left `running`/`queued` by the previous process?

### E. Environment/identity constraints (missed → #19)
Audit assumptions about external identities: single vs. multiple GitHub identities (self-review is forbidden), token scopes, CI presence, default branches, rate limits. Each assumption gets a documented degraded-mode behavior.

### F. Oracle-based behavioral probes (caught the recall bugs — keep doing it)
For ranking/retrieval/scheduling logic: design inputs with KNOWN expected outputs before reading the code (e.g. "this ticket must recall that memory entry"), run live, then explain any divergence down to the line. A probe that passes is a regression test candidate.

## Triage discipline

- Findings close in exactly one of three ways: **fixed (with test)** / **proven benign (with evidence command)** / **deferred (with owner + written risk)**.
- A "deferred" finding that a user later hits is a process failure — review why at the next audit.

## Cadence

Run the full class set before any handoff/release; run class B+C on any PR that adds a status value or a mutating endpoint.
