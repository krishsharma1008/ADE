# 2-DB Hardening — Testing Playbook

Read after `doc/LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md` (the architecture) and alongside
`doc/TEST_TICKETS.md` (the copy-paste hiring + T1–T5 tickets). This file is the **test procedure
for the hardened 2-DB context rail**: what was fixed, how to verify it, how to read the per-hop trace
logs, and how to delete that instrumentation when you're done.

The deep-analysis workflow found **33 issues** (5 blocker / 17 major / 11 minor) in how the local-ops
⟷ shared-remote-context split behaves under real code paths. The fixes are landed and the full server
suite is green (859 passed). This playbook lets you confirm them end-to-end through the UI.

---

## 0. What changed (so you know what you're testing)

| Area | Before (bug) | After (fix) |
|---|---|---|
| **Boot wiring** | Silent fail-open to the ops DB if the context URL didn't load | Fail-loud probe: boot logs whether the rail is **separate + reachable + schema-present**; `COMBYNE_CONTEXT_REQUIRED=true` refuses to boot otherwise |
| **Config resolution** | UI-saved context URL silently dropped; a stale/empty env shadowed the `.env` | config.json fallback + `.env` shadow reconcile (loud warn) |
| **Migrations** | Every teammate auto-migrated the shared remote DB on every boot (race); a failure crashed boot | Teammate boots are **inspect-only**; only `COMBYNE_CONTEXT_DB_MIGRATE=true pnpm db:migrate:context` applies, under a **pg advisory lock**; a context-DB blip no longer crashes boot |
| **Human answers / PR approvals** | Silently **dropped** if the remote context DB was unreachable | **Durable outbox**: enqueued to the local ops DB and **replayed** on the heartbeat tick — never lost |
| **Cross-machine identity** | Local random `company_id` + local-UUID source keys → duplicate/disjoint shared rows | Stable, content/GitHub-derived source keys in shared mode → same answer/PR dedups to one row |
| **Remote pool** | No SSL/timeout tuning; a stalled query could hang the heartbeat | TLS + bounded `connect_timeout`/`idle_timeout`/`statement_timeout` for remote hosts |
| **Embeddings** | A teammate on a different model silently forked the corpus | Drift **detected + warned**; `corpusVersionMismatch` on the status surface; gap-only re-embed (no ping-pong) |
| **Promotion** | Two non-atomic writes could leave a stuck promotion | Single context transaction + idempotent insert |
| **Tenant isolation** | `agent_memory` had no RLS policy | RLS policy added (dormant like the rest until the FORCE flip) |
| **ETL** | `import`/`reembed` silently ignored the operator's `--db` | Honor the destination; default to the context DB; warn on ambiguity |

> **Deferred (documented, infra in place):** the full RLS **FORCE-flip GUC wiring** across every
> `memory.ts` read path is the deliberate team-onboarding hard gate — it's a no-op today (owner
> connection bypasses ENABLE-not-FORCE RLS; app-layer `WHERE company_id` already isolates). The
> enabling pieces are landed: `withContextScope`, `withCompanyScope` rebound to the context DB, and the
> `agent_memory` policy. Also deferred: opportunistic heartbeat re-embed backfill (the read-side
> cross-version guard already neutralizes the corruption risk).

---

## 1. Pre-test setup (env + DB connections)

### 1a. Where the env lives
The server loads the **instance** env file — confirm the real path with the app's own resolver:
```bash
cd server && npx tsx -e "import {resolveCombyneEnvPath} from './src/paths.js'; console.log(resolveCombyneEnvPath())"
# → /Users/<you>/.combyne/instances/default/.env   (NOT the repo ./.env)
```
That file (gitignored, chmod 0600) must contain — **secrets only here, never committed**:
```bash
# The shared rail (the ONLY shared resource). Keep the URL-encoded password.
COMBYNE_CONTEXT_DATABASE_URL=postgres://postgres:<url-encoded-pw>@34.171.242.104:5432/postgres?sslmode=require
# Real semantic embeddings (team-shared key; bodies egress POST-redaction)
OPENAI_API_KEY=sk-...
COMBYNE_EMBEDDING_API_KEY=sk-...
COMBYNE_EMBEDDING_PROVIDER=openai
COMBYNE_EMBEDDING_MODEL=text-embedding-3-small
COMBYNE_EMBEDDING_DIM=1536            # MUST match the shared vector(1536) column
COMBYNE_VECTOR_SEARCH_ENABLED=true
# Testing knobs
COMBYNE_CONTEXT_TRACE=1               # end-to-end per-hop trace (§3); unset = no-op
COMBYNE_CONTEXT_REQUIRED=true         # refuse to boot if the rail is unreachable (fail-loud)
```
> The ops DB needs no config — it's the embedded Postgres at `127.0.0.1:54329`, data dir
> `~/.combyne/instances/default/db`, created + migrated automatically on first boot.

### 1b. Two DB connections — what to verify
| | OPS DB (local, throwaway) | CONTEXT DB (shared, Cloud SQL) |
|---|---|---|
| Connection | embedded PG `:54329` (auto) | `COMBYNE_CONTEXT_DATABASE_URL` |
| Reachability | always (loopback) | your machine's public IP must be in the Cloud SQL **Authorized networks**; TLS (`sslmode=require`) |
| Schema | auto-migrated on `pnpm dev` boot | provisioned by the one-shot operator command below |

**Provision / update the shared context schema** (one-shot, only the designated operator; advisory-locked
so concurrent runs are safe). This also *verifies the connection*:
```bash
COMBYNE_CONTEXT_DB_MIGRATE=true \
COMBYNE_CONTEXT_DATABASE_URL="postgres://…:5432/postgres?sslmode=require" \
  pnpm db:migrate:context
# → prints "after: upToDate" + "CONTEXT DB OK" on success.
# A CONNECT_TIMEOUT here = your IP isn't in Cloud SQL Authorized networks — add <your-ip>/32.
```
Teammate machines do **not** run this — their boots are inspect-only and warn if the schema is behind.

### 1c. Start / stop the webapp
```bash
pnpm dev                      # builds UI + boots server on http://localhost:3100
# stop:
lsof -ti tcp:3100 | xargs kill -9 ; lsof -ti tcp:54329 | xargs kill -9 ; pkill -f dev-runner
```
**Recovery — if boot fails on an ops-DB migration** (e.g. `policy … already exists` from an inconsistent
local journal): the ops DB is throwaway, so reset it and let it migrate fresh —
```bash
lsof -ti tcp:54329 | xargs kill -9
rm -rf ~/.combyne/instances/default/db          # (or `mv` it aside to keep a backup)
pnpm dev                                         # re-inits + migrates 0001→latest cleanly
```
The shared context DB is **never** touched by this.

---

## 2. Smoke test the wiring (before any ticket)

`pnpm dev`, then confirm in the **server logs** (these are permanent, not the trace):

1. `Shared context DB reachable; memory layer routing to the shared rail` with the Cloud SQL host —
   **not** the embedded `:54329`. (If `COMBYNE_CONTEXT_REQUIRED=true` and it can't reach the rail, boot
   **refuses** — that's the point.)
2. `embedding/vector retrieval posture` with `hasKey:true`, `embeddingModel:text-embedding-3-small`,
   `embeddingDim:1536`. If you see the `VECTOR_SEARCH_ENABLED=true but no embedding API key` warn, the
   key didn't load.
3. With `COMBYNE_CONTEXT_TRACE=1`: a `ctxtrace:context_db_route` line with `sameAsOperational:false`.

If routing shows the embedded DB or the embedder is on hash-64, **stop and fix** — every ticket depends
on it. The new boot logs make this a 5-second check instead of a mystery.

---

## 3. Run the tickets, watch the trace

Use the hiring + T1–T5 tickets in `doc/TEST_TICKETS.md`. With `COMBYNE_CONTEXT_TRACE=1`, every hop emits
a `ctxtrace:<event>` line carrying the `issueId`, so you can follow one ticket end-to-end:

```bash
pnpm dev 2>&1 | grep ctxtrace                     # all context-flow events
pnpm dev 2>&1 | grep '"issueId":"<TICKET_ID>"'    # one ticket's whole lifecycle across both DBs
```

| Ticket | Hop it proves | Trace event to expect |
|---|---|---|
| **T1** small | human answer → context DB | `context_write` `{provenance:"human-answer", entryId, shared:true}` |
| **T2** | prior answer **flows** into new ticket | `context_retrieve` `{returned:>0, topScores:[…]}` citing T1 |
| **T3** medium | PR approval → context DB | `context_write` `{provenance:"pr-approval", entryId}` |
| **T4** large | decision conditions later work, **wider tier** | `context_passdown` `{tier:"large", layers:["shared","workspace"], entriesCited:>0}` |
| **T5** edge | no bleed + conflict | every `context_retrieve.companyId == <COMPANY_ID>`; conflict in **Memory → Conflicts** |

**Resilience check (the headline fix).** Mid-test, briefly make the rail unreachable (remove your IP
from Cloud SQL Authorized networks, or stop the instance) and answer a question:
- The answer **still posts** (HTTP 201) — the flow isn't broken.
- You'll see `ctxtrace:context_capture_enqueue` (not a `context_write`) — the answer was **queued, not
  lost**.
- Restore connectivity; on the next heartbeat tick you'll see `ctxtrace:context_capture_drain` and the
  entry appears in **Memory → Browse**. This is RDB-2/3/4 — no silent drop.

### Failure-localization (grep one `issueId`, find the first missing/wrong event)

| Symptom | First trace/log to check | Likely cause |
|---|---|---|
| Answer never in Memory | no `context_write{human-answer}`; is there `context_capture_enqueue`? | rail down → it's queued (drains later), or HOOK didn't fire |
| Answer queued but never drains | `context_capture_drain` absent across ticks | rail still unreachable / outbox row exhausted retries (logged at error) |
| Answer in Memory, not retrieved later | `context_retrieve.returned:0` | `requireVerified` excluded it / embedding mismatch / wrong companyId |
| Context "leaks" wrong company | `context_retrieve.companyId` ≠ `<COMPANY_ID>` | scope bug / wrong company selected |
| PR approval captured nothing | no `context_write{pr-approval}` | HOOK 2 / approval actor identity |
| Passdown empty for big ticket | `context_passdown.entriesCited:0` | nothing verified yet / tier budget |
| Writes hit the wrong DB | `context_db_route.sameAsOperational:true` | context URL didn't load (check boot warn) |
| Embeddings degraded | boot warn `falling back to hash-64`, or `embedding_version_drift` | key didn't load / a teammate's model drifted |

Permanent (non-trace) signals also surface: `context_db_unreachable` (warn) when the rail drops mid-run,
`embedding_version_drift` / `embedding_vec_dim_mismatch` (warn) for embedding config problems, and the
context-capture outbox `drained {flushed,failed}` info line.

---

## 4. Remove the trace after testing

The trace is **off by default** (no-op unless `COMBYNE_CONTEXT_TRACE` is set), so the simplest cleanup
is to just unset the flag. To delete the instrumentation entirely:

```bash
grep -rn "CONTEXT-TRACE" server/src      # every call site + the helper module
```

Delete those tagged lines and `server/src/services/context-trace.ts`. Nothing else depends on it. The
**permanent** observability (rail-down warnings, embedding drift, boot probe, outbox drain) is *not*
tagged `CONTEXT-TRACE` and should stay.

---

## 5. Acceptance

- [ ] Boot logs show the rail **separate + reachable** (or refuse to boot under `CONTEXT_REQUIRED`).
- [ ] T1 answer → `context_write{human-answer}` in the **Cloud SQL** DB.
- [ ] T2 retrieval **cites** T1.
- [ ] T3 approval → `context_write{pr-approval}`.
- [ ] T4 passdown is **wider tier** and uses T3's decision.
- [ ] T5 shows **zero** cross-company bleed + a surfaced conflict.
- [ ] Resilience: rail-down answer is **queued then drained**, never lost.
- [ ] Every hop is greppable by one `issueId`.

When these pass, the 2-DB rail is proven hardened end-to-end. Then unset `COMBYNE_CONTEXT_TRACE` (or
delete the marker lines) and you're back to production-grade logging only.
