# Local-First ADE + Shared Context DB — Stand-Up & Test Playbook

**Goal:** stand up a **fresh** ADE instance on your own machine (localhost), create a **brand-new company**, hire a full agent org, connect a real GitHub repo as a project, and drive the whole loop end-to-end —
**tickets → agents work → agents ask questions → you answer → answers captured to the shared Cloud SQL context DB → agents open PRs → you (human EM) approve → captured decisions flow as context into the next tickets** — with enough logging that when something breaks you can pinpoint *which hop* failed.

> Companion file: **`doc/TEST_TICKETS.md`** — copy-paste hiring tickets + the small/medium/large test tickets to assign. This file is the *why/how*; that file is the *what to paste*.

---

## Part 0 — The architecture you're actually deploying

This is **not** a web deployment. ADE stays local-first. Every teammate runs their own ADE against their own CLI subscription; the **context DB is the only shared rail**.

```
  Your Mac (now)                         Teammate B's machine (later)
  ┌───────────────────────────┐          ┌───────────────────────────┐
  │ ADE @ http://localhost:3100│          │ ADE @ http://localhost:3100│
  │ mode: local_trusted (no auth)         │ mode: local_trusted        │
  │                            │          │                            │
  │ OPS DB  ── embedded PG     │          │ OPS DB  ── embedded PG     │
  │   :54329 (issues, agents,  │          │   (their issues/agents/PRs)│
  │    PRs, approvals, auth,   │          │                            │
  │    heartbeat state)        │          │                            │
  │                            │          │                            │
  │ Agents ── YOUR claude/codex│          │ Agents ── THEIR claude/codex│
  │   CLI (your subscription)  │          │   CLI (their subscription) │
  └─────────────┬──────────────┘          └─────────────┬──────────────┘
                │  COMBYNE_CONTEXT_DATABASE_URL          │
                └──────────────────┬─────────────────────┘
                                   ▼
                 ┌──────────────────────────────────────┐
                 │ SHARED CONTEXT DB  (Cloud SQL, GCP)   │
                 │ bukuwarung-ai-dev:us-central1:        │
                 │ ade-context-db  ·  34.171.242.104     │
                 │ memory_entries · embeddings (pgvector)│
                 │ trust spine (provenance/verify/conf)  │
                 │ scoped by company_id  (NULL = global) │
                 └──────────────────────────────────────┘
```

**Two databases, two jobs:**

| | OPS DB (local, per-machine) | CONTEXT DB (shared, Cloud SQL) |
|---|---|---|
| Holds | companies, agents, issues, PRs, approvals, auth, heartbeat runs | `memory_entries`, embeddings, promotions, usage |
| Routed by | `DATABASE_URL` (unset → embedded PG :54329) | `COMBYNE_CONTEXT_DATABASE_URL` |
| Shared? | **No** — each teammate's is private | **Yes** — the rail context rides |
| Lifecycle | recreate freely; throwaway | durable; the source of shared truth |
| Code | `resolveContextDb(db)` returns the *ops* db when no context URL set | `resolveContextDb(db)` returns the context db when set (`memory.ts:479`) |

Because ops is local and throwaway, **you can blow it away and start fresh anytime** without touching shared context — exactly what you asked for ("start fresh, don't migrate local memory yet").

---

## Part 1 — THE 2-DB DEEP-THINK (read this before anything else)

You asked me to "give this a deep think from the 2-DB angle and having enough context." Here is the real problem and the design.

### 1.1 The problem: company identity is minted locally and randomly

- `companies.id` = `uuid("id").primaryKey().defaultRandom()` — `packages/db/src/schema/companies.ts:6`. **Every instance mints its own random UUID.**
- In the shared context DB, `memory_entries.company_id` is **always that local UUID** (or `NULL` for the cross-company global layer) — `server/src/services/memory.ts:551-553`.
- Retrieval, EM passdown, and RLS **all scope by that UUID** (`memory.ts:648-650`; passdown in `em-passdown.ts`; RLS migration 0055 keys off `app.current_company`).
- There is **no** `workspace_key`/`tenant` abstraction that decouples "the team's shared memory bucket" from "this machine's random company row." I checked — none exists.

**Consequence:** if you create "Acme Engineering" on your Mac and a teammate creates "Acme Engineering" on theirs, you get **two different `company_id` UUIDs**. Your writes land in partition `A`, theirs in partition `B`, in the *same* Cloud SQL DB — and **no context ever flows between you.** The only naturally-shared partition is `company_id IS NULL` (the global layer), which is admin-governed and cross-company, not your team's working memory.

This is invisible until a second machine joins — which is why it must be designed *now*, while you're still solo.

### 1.2 The options

**Option A — Pin a canonical `company_id` (shared UUID).** ✅ *Recommended now.*
One person creates the company once; its `company_id` UUID becomes the team's shared key. Every teammate's local instance is seeded so its `companies.id` equals that same UUID. All writes/reads to the shared context DB then align automatically.
- **Pros:** zero schema change to the memory layer we just shipped + audited; RLS already keys off the company UUID, so it "just works"; minimal glue (a seed-with-fixed-id step); reversible.
- **Cons:** the UUID must be distributed accurately (a typo silently splits context — the logs in Part 7 catch this); the operational rows (issues/agents) still differ per machine (intended — only context is shared); the same company "exists" in N local DBs with the same id but different ops contents (fine, by design).
- **Glue to build (small):** a `pnpm db:company-pin --id <uuid> --name "<name>"` seed that inserts/updates the local `companies` row with an *explicit* id instead of `defaultRandom()`. ~20 lines using the existing `createDb` + an upsert. Until then, for **solo testing you don't need it** — just create the company normally and read its UUID.

**Option B — Context-workspace key (decouple memory scope from the ops UUID).** 🔜 *The "better propagation" evolution, later.*
Add a stable, human-chosen `context_workspace_id` (e.g. `acme-eng`) that scopes `memory_entries` instead of the raw company UUID; each local instance maps its local company → that shared key.
- **Pros:** human-meaningful ("join workspace `acme-eng`"); no UUID coordination; survives local company re-creation; can map several local companies to one shared bucket.
- **Cons:** schema change to the just-shipped memory layer (new column + backfill + index + RLS policy rewrite to key off the new column); more code; a migration on top of 0048–0055.
- **When:** adopt this once you onboard real teammates and UUID-coordination proves brittle. It's a follow-up build, not needed for the first test.

**Option C — Promote a company registry into the context DB.** ❌ *Rejected.*
Make the shared DB the system of record for company identity.
- **Why no:** it re-couples the two DBs we *deliberately decoupled* (migration 0053 dropped cross-entity FKs for portability) and creates a write-dependency on the shared DB for ops CRUD — against the "ops fully local" principle.

### 1.3 Recommendation

- **Now (solo test):** create the company normally, **record its `company_id` UUID** (Part 3). That UUID *is* your shared key from day one.
- **Multi-teammate phase:** build the tiny `db:company-pin` seed (Option A) and distribute the UUID. Treat the UUID like a low-sensitivity tenant key (it's the RLS scope).
- **If coordination gets painful:** graduate to Option B (workspace key) as a planned migration.

> For the test in this playbook you're solo, so context flows **across tickets within one company on one machine**, through the shared Cloud SQL DB. That already exercises the entire write → embed → retrieve → passdown path across the 2-DB boundary. The cross-*machine* claim is proven by the pinned-UUID argument (and optionally a second local instance pointed at the same context DB + same UUID — see Part 6.6).

---

## Part 2 — Stand up a fresh local instance

### 2.1 Prerequisites (one-time)

- Node 20+, `pnpm` (repo uses pnpm workspaces).
- Your own agent CLI(s) already logged in on this Mac: `claude` (and/or `codex`). The local adapters shell out to these — they use **your** subscription. Verify: `claude --version` / `codex --version`.
- The Cloud SQL context DB reachable from this machine. Your current public IP must be in the instance's **Authorized networks** (you've added it before; re-add if your IP changed).

### 2.2 Environment

Both `~/.combyne/instances/default/.env` and `./.env` already hold (from the context-DB deployment) — confirm they contain:

```bash
# Shared context DB (Cloud SQL) — the only shared rail
COMBYNE_CONTEXT_DATABASE_URL=postgres://postgres:<url-encoded-pw>@34.171.242.104:5432/postgres?sslmode=require

# Managed embeddings (team-shared key) — bodies egress POST-redaction (see PRIVACY_DISCLOSURE.md)
COMBYNE_EMBEDDING_API_KEY=sk-...           # or OPENAI_API_KEY as fallback
COMBYNE_EMBEDDING_PROVIDER=openai
COMBYNE_EMBEDDING_MODEL=text-embedding-3-small
COMBYNE_EMBEDDING_DIM=1536
COMBYNE_VECTOR_SEARCH_ENABLED=true

# Keep the ask-don't-hallucinate gate DARK for the first runs (telemetry only); flip on after calibration
COMBYNE_SUFFICIENCY_GATE_ENABLED=false
```

**Leave unset** (defaults are what you want):
- `DATABASE_URL` → unset = **embedded Postgres on :54329** = your local ops DB (zero setup).
- `COMBYNE_DEPLOYMENT_MODE` → unset = **`local_trusted`** = no login, you are the implicit board.

> Security: these files are gitignored + `0600`. Never commit them, never echo the key/password into logs. (Reminder: the OpenAI key and the Cloud SQL password were shared in chat earlier — **rotate both** when convenient; update the two `.env` files after rotating.)

### 2.3 Boot it fresh

```bash
cd /Users/krishsharma/Desktop/ADE
pnpm install                  # if deps changed
pnpm dev                      # dev-runner: migrates the OPS embedded PG, builds UI, serves on :3100
```

The context DB is **already migrated + verified** (the deployment step), so nothing to do there. The ops embedded PG auto-migrates on first boot.

### 2.4 Verify the wiring BEFORE creating anything (the "two-DB smoke test")

Open `http://localhost:3100`, then confirm all four:

1. **Server health** — `GET /api/health` returns ok (note: it's `/api/health`, not `/health`).
2. **Context DB connected & is the *separate* Cloud SQL one** — UI **Memory → Database** tab (the DB-connection panel). It should show the Cloud SQL host, *not* the embedded `:54329`. The startup log should also emit a `context_db_route` line (added in Part 7) showing `sameAsOperational:false`.
3. **Embedder live** — UI **Memory → Embedding/Setup** tab (the embedding-status route): model `text-embedding-3-small`, dim `1536`, `enabled:true`. If it shows hash-64, the key didn't load — check `.env`.
4. **Agent CLI reachable** — adapter availability shows `claude_local` / `codex_local` as available (ADE probes the CLI on the box).

> If any of these is wrong, **stop and fix here** — every later step depends on them, and a silent mis-wire (e.g., context writes going to the embedded PG instead of Cloud SQL) is the #1 thing the Part 7 logs exist to catch.

---

## Part 3 — Create a fresh company + record its identity

1. In the UI, create a new company (e.g. **"Veefin Test Co"** or your repo's name). In `local_trusted` you are the implicit board — no invite/login needed.
2. **Immediately record the `company_id` UUID.** This is your shared context key (Part 1).
   - From the UI URL after selecting the company, or:
   - `psql "$DATABASE_URL_or_embedded" -c "select id, name from companies order by created_at desc limit 3;"`
   - Write it down: `COMPANY_ID = ________________________`. You'll reference it when grepping logs and (later) when pinning teammates.
3. Sanity: the new company has **no agents, no issues** — a clean slate. Good.

---

## Part 4 — Hire the agent org (the hiring tickets)

The governance model (from `doc/plans/ceo-agent-creation-and-hiring.md`):
- Agent creation is **board-only** by default; `requireBoardApprovalForNewAgents` defaults **true**, so non-CEO hires land in a **`pending_approval`** limbo until you approve them in the Approvals panel.
- Only agents with `can_create_agents` (the **CEO**) can initiate hires; everyone else is hired *by* the CEO/board.
- Adapter config is free-form JSON; for `claude_local`/`codex_local` the key field is `instructionsFilePath` (the agent's SOUL/role prompt) — `server/src/routes/agents.ts:48-49`.

**Recommended starting org (small but exercises every path):**

```
            (you = human board / "human EM")
                       │ approves PRs, answers questions
                 ┌─────▼─────┐
                 │    CEO     │  adapter: claude_local
                 │ Atlas      │  can_create_agents: true
                 └─────┬──────┘
                       │ hires (board-approved)
                 ┌─────▼──────┐
                 │ EM "Maya"  │  adapter: claude_local   ← the agent EM that does passdown
                 └─────┬──────┘
          ┌────────────┼────────────┐
     ┌────▼───┐   ┌────▼───┐   ┌────▼────┐
     │ Eng    │   │ Eng    │   │ QA      │
     │ "Rao"  │   │ "Lin"  │   │ "Tess"  │
     │claude_ │   │codex_  │   │claude_  │
     │ local  │   │ local  │   │ local   │
     └────────┘   └────────┘   └─────────┘
```

> Why one of each adapter: `claude_local` and `codex_local` exercise two different runtimes against the same context DB — a real cross-adapter "no embedding/context bleed" check.

**The exact hiring tickets (role, reporting, adapter config, capabilities, budget) are in `doc/TEST_TICKETS.md` §A.** Create them top-down: CEO first (board hire), then have the CEO hire the EM, then the EM hire the engineers — approving each in the Approvals panel. This itself is the first live test of the hire→approval flow.

---

## Part 5 — Connect your GitHub repo as a project

ADE talks to GitHub **outbound** via a per-company integration (`server/src/services/github.ts`, `server/src/routes/integrations.ts`): create branch, open PR, request review, comment, merge. A project carries the `repo_url` (`packages/db/src/schema/project_workspaces.ts:21`).

1. **Make a GitHub PAT** (fine-grained, scoped to the test repo): `contents:rw`, `pull_requests:rw`, `metadata:r`. (A throwaway repo is ideal so PRs are low-stakes.)
2. **Add the integration:** UI → company **Integrations** → GitHub → paste the PAT. (API: `POST /api/companies/:companyId/integrations` with `provider: "github"`.) Confirm it reads back via `GET /api/companies/:companyId/integrations/github`.
3. **Create the project / workspace** pointing at the repo (`repo_url`, default branch). Agents clone/work in an execution workspace against it.
4. **Webhooks: not needed for this test.** Agents push branches + open PRs outbound; you approve **inside the ADE PR panel** (in-app), which is what fires the context-capture hook. (Inbound GitHub→ADE webhooks are a later nicety for reacting to external merges; skip for now — no tunnel/ngrok required.)

---

## Part 6 — The end-to-end test flow (what to assign the EM, and what to watch)

Assign these **to the EM (Maya)**; she decomposes/passes down to engineers. Full ticket text in `doc/TEST_TICKETS.md` §B. Here's the *flow each ticket proves* and the *exact signal to watch* at each hop.

### 6.1 Ticket T1 (small) — proves: question → human answer → captured to context DB
A small ticket deliberately underspecified so the agent must **ask a question** (e.g. "which date format / which lib?").
- **You do:** answer the question in the ticket thread.
- **What must happen:** HOOK 1 fires → the answer is written to the **context DB** as `provenance: human-answer`, `verificationState: verified`, redacted-before-embed, embedded.
- **Watch:** a `context_write {hook:"qa_answer", companyId:<COMPANY_ID>, entryId, embedded:true}` log line (Part 7), and the entry appearing under **Memory → Browse** (verified, workspace layer). Grep: `grep '"issueId":"<T1-id>"' <logs>`.

### 6.2 Ticket T2 (small/medium) — proves: prior answer **flows** into a new ticket
A second ticket in the same area whose correct solution depends on T1's answer.
- **What must happen:** on the agent's heartbeat, retrieval pulls T1's verified answer from the context DB (requireVerified), and/or the EM passdown packet cites it.
- **Watch:** `context_retrieve {issueId:<T2>, returned:n>0, topScores:[...]}` including T1's entry, and `context_passdown {entriesCited:n>0}`. This is the **"context flows" proof.**

### 6.3 Ticket T3 (medium) — proves: agent → PR → human approval → captured decision
A self-contained change that yields a real PR.
- **What must happen:** agent creates branch + PR (outbound GitHub). You review in the **ADE PR panel**. By default PR-review feedback is **human-gated** (`COMBYNE_PR_FEEDBACK_AUTOPILOT=false`) — agents are *not* auto-woken to rewrite; you release rounds with **"Let agents fix."** On **approve**, HOOK 2 fires → the decision/accepted pattern is written to the context DB as `provenance: pr-approval`, `verified`.
- **Watch:** `context_write {hook:"pr_approval", prNumber, issueId:<T3>, entryId}` and the entry under **Memory → Browse**.

### 6.4 Ticket T4 (medium/large) — proves: approved decision from T3 **conditions** later work + tiered passdown
A larger ticket in the same subsystem as T3.
- **What must happen:** retrieval + passdown surface T3's approved decision; because it's **large**, the passdown tier widens (`PASSDOWN_TIERS`: large = `['shared','workspace']`, bigger budget) vs. T1/T2 small (`['shared']`, 1.5k).
- **Watch:** `context_passdown {tier:"large", layers:["shared","workspace"], bytes, truncated:false}` — and that the engineer's output respects T3's decision. This proves **right amount/quality of context per task size** (your "having enough context" requirement).

### 6.5 Ticket T5 (edge) — proves: no bleed + conflict handling
A ticket that (a) must **not** see another company's data, and (b) re-answers something from T1 *differently* to trigger conflict surfacing.
- **Watch:** retrieval for T5 returns only `company_id = <COMPANY_ID>` (+ global) rows — never another company's; a `context_conflict {subjectKey, existingId, incomingId}` log + the conflict appearing in **Memory → Conflicts** for you to override/merge.

### 6.6 (Optional) cross-machine proof
Point a **second** local instance (a second checkout, or a teammate) at the **same** `COMBYNE_CONTEXT_DATABASE_URL` **and the same `COMPANY_ID`** (via the `db:company-pin` glue from Part 1.2). Re-run a retrieval-only ticket there; it should surface entries written by the first machine. This is the literal "context across teammates" demonstration.

### Acceptance criteria (the test passes when…)
- [ ] T1 answer is in the **context DB** (Cloud SQL), verified, embedded — not the embedded ops PG.
- [ ] T2 retrieval/passdown **cites** T1's answer.
- [ ] T3 PR approval writes a `pr-approval` entry to the context DB.
- [ ] T4 retrieval/passdown **uses** T3's decision, with a **wider tier** than T1/T2.
- [ ] T5 shows **zero** cross-company bleed and a **surfaced conflict** you can resolve.
- [ ] Every hop above is **traceable by grepping one `issueId`** through the logs.

---

## Part 7 — Logging & observability (so a break is *findable*, not a mystery)

You asked for "the right logs so that when we test and something breaks we can identify and fix." The logger is pino (`server/src/middleware/logger.ts`, level `debug`). Some structured telemetry already exists (`sufficiency_verdict` at `heartbeat.ts:343-358`; the embedding-status route; the in-app activity feed via `logActivity`). What's missing is a **single correlation key threaded across the 2-DB boundary** so the whole context lifecycle of one ticket is greppable.

### 7.1 The instrumentation to ADD (proposed — I'll implement on your go)

Emit a structured line at **each hop**, all carrying `issueId` (+ `companyId`, + a `corrId`) so `grep <issueId>` reconstructs the lifecycle:

| # | Event name | Where | Key fields |
|---|---|---|---|
| 1 | `context_db_route` | startup + first memory op | `contextUrlHost`, `sameAsOperational:bool`, `vectorEnabled` |
| 2 | `context_write` (Q&A) | HOOK 1 capture path | `hook:"qa_answer"`, `companyId`, `issueId`, `source`, `layer`, `provenance`, `verificationState`, `redactions:n`, `embedded:bool`, `entryId` |
| 3 | `context_write` (PR) | HOOK 2 approval path | `hook:"pr_approval"`, `companyId`, `issueId`, `prNumber`, `source`, `entryId` |
| 4 | `embedding_op` | store + query | `op:"store"\|"query"`, `model`, `dim`, `version`, `redactions:n`, `latencyMs`, `fallbackHash:bool` |
| 5 | `context_retrieve` | heartbeat self-retrieval + gate | `companyId`, `agentId`, `issueId`, `layer`, `requireVerified:true`, `candidates:n`, `returned:n`, `topScores:[…]` |
| 6 | `context_passdown` | EM passdown composer | `companyId`, `fromEmAgentId`, `toAgentId`, `issueId`, `tier`, `layers:[…]`, `entriesCited:n`, `bytes`, `truncated:bool` |
| 7 | `context_conflict` | conflict detection | `companyId`, `subjectKey`, `existingId`, `incomingId`, `resolution` |
| 8 | `sufficiency_verdict` | **exists** — `heartbeat.ts:343` | (already emitted; we add `corrId`/`issueId` for joinability) |

A `corrId` (one per issue lifecycle) lets you trace even across heartbeat runs. With these, the **failure-localization table** becomes:

| Symptom | First log to check | Likely cause |
|---|---|---|
| Answer never shows in Memory | `context_write{hook:qa_answer}` missing | HOOK 1 didn't fire / write went to ops PG |
| Answer in Memory but not retrieved later | `context_retrieve.returned:0` | `requireVerified` excluded it / embedding mismatch / wrong companyId |
| Context "leaks" wrong company | `context_retrieve.companyId` ≠ `<COMPANY_ID>` | scope bug / wrong company selected |
| PR approval captured nothing | `context_write{hook:pr_approval}` missing | HOOK 2 / approval actor identity |
| Passdown empty for big ticket | `context_passdown.entriesCited:0` | tier/budget or nothing verified yet |
| Writes hitting the wrong DB | `context_db_route.sameAsOperational:true` | `COMBYNE_CONTEXT_DATABASE_URL` not loaded |
| Embeddings silently degraded | `embedding_op.fallbackHash:true` | key didn't load → hash-64 fallback |

### 7.2 How to watch during testing

```bash
# all context-flow events, pretty:
pnpm dev 2>&1 | grep -E 'context_(write|retrieve|passdown|conflict|db_route)|embedding_op|sufficiency_verdict'

# the full lifecycle of one ticket across both DBs:
pnpm dev 2>&1 | grep '"issueId":"<TICKET_ID>"'
```

Plus the UI surfaces: **Memory → Browse / Conflicts / Embedding** tabs, the **Approvals** panel, and the per-agent **activity feed** (`logActivity`).

> I have **not** added these log lines yet — they're a proposal. Say the word and I'll implement #1–#8 (small, additive, no behavior change) as the very first step so the test is debuggable from run one.

---

## Part 8 — Debug → fix loop (and the bar for a "proper" fix)

When a hop breaks during testing:
1. **Localize** with the table in §7.1 — grep the `issueId`, find the first missing/wrong event.
2. **Reproduce** minimally — re-run that one ticket; confirm the same event is missing/wrong.
3. **Root-cause** at the code site (the events map 1:1 to `memory.ts` / HOOK 1 / HOOK 2 / `em-passdown.ts` / `context-db.ts`).
4. **Fix bar (don't patch symptoms):** a fix ships only when (a) there's a failing test that reproduces it, (b) the fix is in the right layer (not a log-only band-aid), (c) the full server suite stays green (`pnpm --filter @combyne/server test`), and (d) the trace now shows the correct event. This matches how the central-DB branch was built (every PR: build → adversarial review → test).
5. **Capture the lesson** — if it's a design/behavior decision, it belongs in the context DB too (dogfood the system).

---

## Part 9 — Run checklist, teardown, cost

**Pre-flight**
- [ ] `claude`/`codex` CLI logged in locally.
- [ ] Your IP is in Cloud SQL **Authorized networks**.
- [ ] `.env` has context URL + embedding key + `VECTOR_SEARCH_ENABLED=true`; `DATABASE_URL` unset; mode `local_trusted`.
- [ ] (Recommended) Part 7 logs implemented.

**Smoke (Part 2.4)**
- [ ] `/api/health` ok · context DB = Cloud SQL (not :54329) · embedder live (3-small/1536) · adapters available.

**Run (Parts 3–6)**
- [ ] Company created, `COMPANY_ID` recorded · org hired (CEO→EM→engs, approvals worked) · GitHub integration green · project points at repo · T1–T5 acceptance criteria all checked.

**Teardown / hygiene**
- Ops is throwaway: stop `pnpm dev`; to fully reset ops, drop the embedded PG data dir under `~/.combyne` (context DB untouched).
- **Cloud SQL bills hourly** on the public-IP instance — when done testing for the day, **stop the instance** in GCP and keep Authorized networks locked to your `/32` (never `0.0.0.0/0`).
- **Rotate** the OpenAI key + Cloud SQL password that were shared in chat; update both `.env` files.

---

## Appendix — file/line references (for fixers)
- Company id (random, local): `packages/db/src/schema/companies.ts:6`
- Context DB routing: `server/src/services/context-db.ts` · `memory.ts:479` (`resolveContextDb`)
- Memory write + global NULL scoping + idempotent (companyId,source): `memory.ts:551-650`
- Hooks: HOOK 1 (Q&A→memory) and HOOK 2 (PR-approval→memory) capture paths
- EM passdown tiers: `em-passdown.ts` (`PASSDOWN_TIERS`)
- Sufficiency gate + telemetry: `heartbeat.ts:197-358`, retrieval requireVerified at `heartbeat.ts:~4185`
- Hire/governance: `server/src/routes/agents.ts:48-49` (adapter config), `doc/plans/ceo-agent-creation-and-hiring.md`
- GitHub: `server/src/services/github.ts`, `server/src/routes/integrations.ts`
- Project repo url: `packages/db/src/schema/project_workspaces.ts:21`
- Logger: `server/src/middleware/logger.ts`
