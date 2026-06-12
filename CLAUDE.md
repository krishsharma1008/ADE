# CLAUDE.md

**Start with `docs/HANDOFF.md`** — it is the first-sweep document: current state, the code map, and the hard rules (each learned from a live incident). System reference with diagrams: `docs/ARCHITECTURE.md`. Setup: `docs/DEVELOPER_SETUP.md`.

## Non-negotiables

- Do NOT edit `server/src` while agent runs are in flight — tsx watch restarts orphan them. Check first: `node scripts/db-query.mjs "SELECT count(*) FROM heartbeat_runs WHERE status IN ('queued','running')"`. UI edits are always safe.
- The server reads env from `~/.combyne/instances/default/.env` ONLY (template: `docs/instance.env.example`). A repo-root `.env` is ignored.
- Agents must never merge PRs, close issues with open tracked PRs, or author verified memory — these invariants are enforced in code; never weaken them.
- The central context DB is the LIVE shared team rail — back up before any destructive change; archive over delete.
- Run vitest from the repo root. Gates before any commit: targeted tests green, `pnpm typecheck`, `pnpm --filter ui build`.
- Findings/bugs close as fixed-with-test, proven-benign-with-evidence, or deferred-with-owner (`docs/AUDIT_PLAYBOOK.md`).

## Commands

```bash
pnpm dev          # full stack on 127.0.0.1:3100 (embedded PG :54329)
pnpm test:run     # full suite
node scripts/db-query.mjs "<sql>"        # local ops DB
node scripts/context-query.mjs "<sql>"   # shared rail — careful
```
