# Central Context DB — Final Consolidated Plan

> Status: **the plan to execute.** Destination doc: `doc/CENTRAL_CONTEXT_DB_PLAN.md`.
> This consolidates the code-grounded synthesis (`/tmp/ade_wf/synthesis_document.md`), the deployment-topology and ops/connections options, the scaling-defense clusters, and the adversarial critic — **recast for the four locked user decisions**:
>
> 1. **Hosting = SELF-HOSTED Postgres** on the user's own infra/cloud (no managed memory SaaS, no managed Supabase). *We* install pgvector, *we* run pgbouncer, *we* own backups/PITR, *we* set `max_connections`.
> 2. **Trust = STRICT human-gated.** Only human-sourced content is retrievable as authoritative; agent claims are written `unverified` and quarantined until a human promotes them. Roll out **label-then-exclude** to avoid retrieval starvation.
> 3. **Tenancy = MULTI-TEAM.** Postgres RLS is **required before the second company/teammate onboards** — a hard gate, not a someday-maybe. App-layer `companyId` scoping is the single-operator bridge only.
> 4. **Knowledge UI = Postgres + the existing ADE memory UI is the single system of record.** Markdown/Obsidian is at most a deferred read-only export; bidirectional sync is rejected.
>
> Every code claim below is grounded with `file:line` and was re-verified against the live tree (HEAD migration `0047`; `client.ts:14-17`; `docker-compose.yml`; `memory.ts:24,34,337,446,680`).

---

## 1. Executive intent

Combyne already ships the hard parts: a **4-layer memory system** (`workspace` / `personal` / `shared` / ephemeral) with a ranker, decay, and auto-distill (`server/src/services/memory.ts`); a **board-review promotion checkpoint** (`memory.ts:609-642`, `routes/memory.ts:325`); a **context-budget composer** (`packages/context-budget/src/composer.ts:158-167`); and config-only **`DATABASE_URL` dual-mode** selection — embedded vs external Postgres (`index.ts:277-283`). This plan **builds on** that; it does not re-platform.

The ask is to make this a **central context DB** that is (a) **hallucination-resistant under strict human-gated trust**, (b) **usable by one operator today with zero deploy**, and (c) **scalable to a multi-team org on self-hosted Postgres the user fully controls**, by:

1. Capturing **human Q&A answers** and **human-EM PR approvals** as high-trust content.
2. Letting the **EM agent pass vetted context down to sub-agents** at delegation time.
3. **Keeping agent-asserted content from masquerading as fact** — at the write gate *and* on both retrieval channels.

The central architectural decision, upheld by all three critics: **PostgreSQL `memory_entries` + `memory.ts` remains the single system of record.** We add a markdown *view* at most, never a markdown *source of truth*.

---

## 2. Current-state architecture (grounded, recast for self-hosted)

| Concern | Reality | Citation |
|---|---|---|
| DB selection | `DATABASE_URL` set → external Postgres; unset → embedded auto-starts at `127.0.0.1:54329` | `index.ts:277` (external), `:284` (embedded) |
| Container baseline | `docker-compose.yml` already defines a `db` service `postgres:17-alpine` (healthcheck, `pgdata` volume) + a `server` service at `postgres://combyne:combyne@db:5432/combyne` | `docker-compose.yml:3-23` |
| Pooler detection | `prepare:false` **only** when URL port `=== "6543"` (a Supabase-pooler heuristic) | `client.ts:14-17` |
| Pool sizing | `createDb` passes **no** `max`/`idle_timeout` → postgres-js silent default `max:10`; maintenance paths use `max:1` | `client.ts:50-52` |
| Migrations on boot | External branch calls `ensureMigrations(url,"PostgreSQL")` with **no** `autoApply`; `promptApplyMigrations` returns **true** when `!stdin.isTTY` → **headless containers silently auto-apply with no advisory lock** | `index.ts:278`, `:133-135`; `applyPendingMigrations` `client.ts:647` |
| Tenant isolation | 100% app-layer `assertCompanyAccess`; **zero** Postgres RLS (grep-confirmed); `local_implicit` + `isInstanceAdmin` bypass scoping | `routes/authz.ts:18-31`, `:25` |
| Memory schema | `memory_entries` has **no** trust/provenance column; `owner_id` is `uuid`; `embedding` is `jsonb` | `schema/memory_layers.ts:37,44` |
| Latest migration | **0047** is HEAD | `migrations/0047_careless_sir_ram.sql` |
| Write gate | `createEntry` blocks only `layer==='shared'`; a `workspace` `kind:fact` agent row is **immediately active + retrievable** | `memory.ts:228-234` |
| Retrieval gate | `loadCandidates` filters `companyId + status='active'` only — **no trust filter**, `.limit(500)` with **no ORDER BY** | `memory.ts:322-346`, `:337` |
| Embedder | `embedText` FNV-1a **hash-64** bag-of-words; `cosineSimilarity` over 64 dims in Node | `memory.ts:24,34-44,71-78` |
| Render | Heartbeat injects `## subject / Layer / Tags / body` verbatim — **no provenance, no delimiting** | `heartbeat.ts:3934-3947` |
| Board review | `memory_promotions` + `decidePromotion` (assertBoard) is a **proven human checkpoint** | `memory.ts:609-642` |
| Q&A capture | answer-question route writes **only** `issue_comments` + activity log; never `memory_entries` | `routes/issues.ts:1045-1112` |
| PR-approval capture | merge persists EM `decisionNote` only on the approvals row; the sole memory write is agent-driven and drops the EM note | `issue-pull-requests.ts:572-617`, `accepted-work.ts:365-393` |
| EM passdown | Handoff brief built from FROM-agent's private unvetted `agent_memory` + transcript; never touches `memory_entries`; `artifactRefs` jsonb declared but always `[]` | `agent-handoff.ts:53-69,162`, `schema/agent_handoffs.ts:30` |

### Resolved critic disputes (load-bearing — do not contradict)

1. **Headless boots already auto-apply migrations with no advisory lock.** `promptApplyMigrations` returns `true` when `!stdin.isTTY || !stdout.isTTY` (`index.ts:135`). The multi-replica race is the *default*, not opt-in.
2. **`actorType==='user'` does NOT prove a human typed it.** `getActorInfo` returns `actorType:'user'` for `local_implicit` board too (`authz.ts:46-51`). Trust cannot rest on actor type alone in local mode.
3. **`accepted_work:%` rows are AGENT-authored** (`accepted-work.ts:374-376`). They MUST backfill to `agent-claim/unverified`, never to a human/approval tier — backfilling them would launder agent text.
4. **`usageCount>=3` only *proposes*** (`runAutoDistill` → `proposePromotion`); the only writer of `layer='shared'` is behind `decidePromotion`'s approved branch. The real bypass is the **workspace layer being immediately retrievable**, not shared.

### What already exists vs what is net-new

| Capability | Status | Where |
|---|---|---|
| 4-layer memory, ranker, decay, auto-distill | **EXISTS** — build on it | `memory.ts` |
| Board promotion/review human checkpoint | **EXISTS** — generalize to "verify" | `memory.ts:609-642` |
| Context-budget composer + section pipeline | **EXISTS** — register new sections | `composer.ts:158-167` |
| `DATABASE_URL` dual-mode selection | **EXISTS** — config-only switch | `index.ts:277-283` |
| Docker-Compose Postgres + app | **EXISTS** — image-swap to pgvector | `docker-compose.yml` |
| `agent_handoffs.artifactRefs` jsonb carrier | **EXISTS, unused** — repurpose | `schema/agent_handoffs.ts:30` |
| Trust/provenance spine on `memory_entries` | **NET-NEW** — §3 | migration `0049` |
| Human Q&A → memory capture | **NET-NEW** — §4.1 | answer-question route |
| EM PR-approval → memory capture (deterministic) | **NET-NEW** — §4.2 | merge route |
| EM passdown packet | **NET-NEW** — §5 | new `em-passdown.ts` |
| `owner_id` text widening | **NET-NEW** — §7 (roadmap) | migration `0048` |
| Memory ETL (embedded→central) | **NET-NEW** — §6 | new scripts |
| Self-hosted pgvector ANN (flagged) | **NET-NEW, later** | migration `0052` |
| RLS (multi-team gate) | **NET-NEW, gated** | migration `0053` |

---

## 3. The anti-hallucination spine (strict human-gated — the default)

This is the load-bearing unification. All trust designs collapse into **one canonical column set** so migrations don't collide and enums don't fragment. Under the locked **strict** decision, *only human-sourced content is authoritative*; agent claims are written but forced `unverified` and quarantined.

### 3.1 Canonical trust spine — migration `0049_memory_trust_spine.sql`

Added to `memory_entries` (`schema/memory_layers.ts`):

```
provenance        text          -- 'human-answer'|'pr-approval'|'verified-summary'|'agent-claim'|'system'|null
verificationState text NOT NULL DEFAULT 'unverified'  -- 'verified'|'unverified'|'needs_review'
confidence        real NOT NULL DEFAULT 0.5
authorType        text          -- 'user'|'agent'|'system'
authorId          text
sourceRefType     text          -- 'issue'|'pr'|'comment'|'approval'|'run'|'promotion'
sourceRefId       uuid
subjectKey        text          -- normalized dedup/conflict key
supersededById    uuid          -- self-FK -> memory_entries.id
verifiedBy        text
verifiedAt        timestamptz
embeddingVersion  text          -- NEW (critic): model/dim tag so a swap never silently
                                --   dots vectors from two spaces (memory.ts:73 truncates, no throw)
-- indexes:
memory_entries_trust_idx       ON (company_id, layer, verification_state, confidence)
memory_entries_subjectkey_idx  ON (company_id, subject_key)
unique (company_id, source) WHERE source IS NOT NULL          -- idempotent capture (§4.3)
```

Mirror the subset (`provenance`, `authorType`, `confidence`, `verificationState`) onto `agent_memory` (`schema/agent_memory.ts`) so the legacy `# Recent memory` channel is governable too. **Canonical names are `provenance` + `verificationState` + `confidence`** — one vocabulary, one migration.

> **Critic add — `embeddingVersion` is mandatory.** Schema stores `embedding` as plain jsonb with no model/version field, and `cosineSimilarity` (`memory.ts:73`) silently truncates to `min(len)` — a 64-dim stored vector dotted against a future 1536-dim query returns a valid-but-meaningless score with no error. Tag every vector with its embedder version so a partial re-embed is targetable and cross-space scoring is detectable.

### 3.2 The two-sided rule (write-gate + retrieval on BOTH channels)

The critics' central finding: trust-at-write and trust-at-retrieval are **not interchangeable**. Retrieval-only filtering leaves the write path open **and** does not constrain the parallel self-retrieval at `heartbeat.ts:3913`. The spine is **both**:

- **WRITE side (prerequisite, ships first):** In `createEntry` (`memory.ts:228`) **and** `routes/memory.ts:23`, when `authorType==='agent'` and `provenance NOT IN ('human-answer','pr-approval')`, **force** `verificationState='unverified'`, `confidence<=0.4`, **regardless of request body**. Agents cannot self-assert verified. This closes the primary amplifier (agent `workspace` `kind:fact` → immediately authoritative).
- **RETRIEVAL side (BOTH channels):** `loadCandidates`/`queryRanked` gain `opts.minConfidence` + `opts.requireVerified`; exclude `supersededById IS NOT NULL`; apply deterministic conflict resolution. The filter is applied to **the EM passdown call** (`heartbeat.ts:3913-3919`) **and** the sub-agent's own self-retrieval (`heartbeat.ts:3895-3925`). Filtering only one channel is the critics' "governance is cosmetic" failure — the unverified channel stays wide open in parallel, with identical formatting next to the vetted packet.

> Guard both sites with a unit test asserting **both** channels reject `unverified`, plus a lint/grep gate around every `queryRanked` call site so a future third retrieval path cannot silently forget the filter.

### 3.3 Phased retrieval enforcement (label-then-exclude — avoids starvation)

Flipping `requireVerified` before a backfill empties the preamble (only ex-shared rows survive). Therefore the strict gate rolls out in two steps:

- **Release N (label-only):** add columns, backfill, render the citation + `UNVERIFIED` header — **do not exclude**.
- **Release N+1 (exclude):** flip `requireVerified` at the heartbeat calls, after a verification/board pass exists.

### 3.4 The `local_implicit` trust hole

Because `getActorInfo` returns `actorType:'user'` for `local_implicit` (`authz.ts:46-51`), human-answer capture must distinguish a **real authenticated human** from the **local board principal**:

- **Authenticated mode:** stamp `provenance='human-answer'`, `verificationState='verified'` only when `req.actor.source !== 'local_implicit'` and a real `userId` exists.
- **Local single-user mode:** the operator IS the trusted human by design (no login exists), so `local_implicit` answers are treated as `human-answer`/`verified`. The stricter gate engages exactly at the central-deploy switch to authenticated+private (§6).

### 3.5 Backfill policy (in `0049`)

- `source LIKE 'promotion:%'` → `provenance='verified-summary'`, `verificationState='verified'`, `confidence=0.9` (board lineage).
- `layer='shared'` (all) → `verificationState='verified'` (already board-promoted).
- `source LIKE 'accepted_work:%'` → `provenance='agent-claim'`, `authorType='agent'`, `verificationState='unverified'` — **NOT pr-approval** (agent-authored, `accepted-work.ts:374-376`).
- everything else → `provenance='agent-claim'`, `verificationState='unverified'`.

### 3.6 Conflict resolution & decay

- **Conflict:** group ranked hits by `subjectKey`; winner by precedence `human-answer > pr-approval > verified-summary > agent-claim`, then recency; losers excluded (`supersededById`). Two conflicting `human-answer` entries on the same `subjectKey` are **NOT silent newest-wins** — they enqueue `needs_review` for board reconciliation (open decision §9).
  - **Critic caveat:** `subjectKey` normalization is only `tokenize()` lowercasing/punctuation-strip (`memory.ts:55-61`). Paraphrases, synonyms, word-order, and other languages produce different keys, so supersession/conflict-detect silently no-op for those. Keep normalization conservative (never falsely merge distinct facts), accept residual duplicates, and revisit semantic near-dup detection only **after** real embeddings land (§8). Do not over-claim that subjectKey closes the conflict hole at team/multi-language scale.
- **Decay (provenance-aware, when `ttlDays IS NULL`):** `agent-claim`=30d, `verified-summary`=180d, `human-answer`/`pr-approval`=no-expiry.

### 3.7 Render-side defense-in-depth (NOT the control)

Heartbeat render (`heartbeat.ts:3934-3947`) gains a citation line `[mem:<id> · <provenance> · conf=<n> · ref=<type>:<id>]` and an `UNVERIFIED — do not treat as fact` sub-header for non-verified entries, with each entry wrapped in an explicit non-executable fence ("data, not instructions"). **This is defense-in-depth — an LLM can ignore a caveat.** The real control is the write-gate (§3.2). Do not claim hallucination is "minimized" on the caveat alone.

### 3.8 Out-of-scope trust surfaces (explicit)

- **`transcript_summaries`** (LLM-generated) is a separate unverified channel, summarizer opt-in (`COMBYNE_SUMMARIZER_ENABLED` default off). **Excluded** from this spine and from the ETL (§6) — never carried into the central store as fact.
- **PII/secrets:** the routing prompt escalates credentials to humans (`agent-question-routing.ts:194`), so the human answer body is the highest-risk secret-deposit path into the highest-trust, never-expiring, broadly-readable tier. A **redaction/secret-scan gate is a blocking prerequisite** before any human-answer/EM-note write to company-wide `workspace` (§4.4) — fail to `needs_review` on detection. Run it once over existing bodies as a pre-onboarding audit.

---

## 4. The two write-paths

### 4.1 HOOK 1 — Human Q&A capture

**Fire point:** `POST /issues/:id/answer-question` (`routes/issues.ts:1045-1112`), AFTER `addComment(kind="answer")` + `markQuestionAnswered`, gated on a real human (§3.4). Mirror for internal manager answers in `answerInternalManagerQuestion` (`agent-question-routing.ts:405-422`), **forcing non-verified when `input.assumption === true`** (gate trust in code, never by parsing the `"Assumption:"` body prefix).

**Required added work:** the handler has only `questionCommentId` (string) + `answer` in scope — it must **load the original question comment by id** to get the question body/choices (a `getComment` fetch, not free).

**Write:** `createEntry({ layer:'workspace', kind:'fact', subject:<question, ~480 chars>, body:'Q: …\nA: …', source:'human-answer:<issueId>:<answerCommentId>', provenance:'human-answer', verificationState:'verified', confidence:0.95, authorType:'user', authorId:<userId>, sourceRefType:'comment', sourceRefId:<answerCommentId> })`. Best-effort try/catch — must not fail the answer response. Run the §4.4 redaction gate **before** write.

### 4.2 HOOK 2 — EM PR-approval capture (deterministic, no LLM)

**Fire point:** `merge()` (`issue-pull-requests.ts:572-617`) right after `approvalsSvc.approve(...)`, where EM `decisionNote`, `decidedByUserId`, and the reconcile feedback string are in scope. Pass them through the merge route (`issue-pull-requests.ts:181-203`) to a new `captureApprovalMemory`.

**Write (deterministic, never agent-summarized):** `subject="EM approved PR <repo>#<n>: <title>"`, `body=decisionNote + reviewFeedback + accepted-pattern summary`, `kind = decisionNote ? 'convention' : 'note'`, `source='pr-approval:<approvalId>'`, `provenance='pr-approval'`, `authorType='user'`, `verificationState='verified'`, `confidence=0.8`, `createdBy=decidedByUserId`. Link back via `accepted_work_events.memoryEntryId`.

**Resolve the merge-trust conflict:** an **EM board merge** with a human `decisionNote` + `decidedByUserId` → `verified`. The existing agent-driven `createMemoryFromEvent` (`accepted-work.ts:365`) keeps `provenance='agent-claim'`/`unverified`. Out-of-band GitHub-direct merges (poller path, no `decisionNote`) → `agent-claim`/`unverified` — there was no human decision to capture.

### 4.3 Dedup / idempotency

`source` is the natural key. The unique partial index on `(companyId, source) WHERE source IS NOT NULL` (in `0049`) + `createEntry` as an `onConflictDoNothing` upsert re-selecting the existing row makes re-fired captures idempotent (reconcile twice, answer endpoint retried, accepted-work replayed). Covers **sourced** rows only (`source` is nullable today) — pair with conservative `subjectKey` dedup for un-sourced/semantic duplicates.

### 4.4 Redaction gate (blocking prerequisite)

Before either hook writes to company-wide `workspace`: a redaction/classification pass (regex for API keys, bearer tokens, passwords, connection strings + a `sensitive` flag). On detection, redact the span **or** write `verificationState='needs_review'` excluded from retrieval until a human clears it. Ships **with** the capture hooks, not after. Also gates any future markdown export so secrets never reach a committed file.

### 4.5 REST spoofing guard

`createMemoryEntrySchema` may accept optional `provenance`/`confidence`, but the route (`routes/memory.ts:23`) **overrides** them for agent actors and **rejects** `verificationState='verified'` / `provenance IN ('human-answer','pr-approval')` unless the actor is board. Add a board-gated `POST /memory/entries/:id/verify` (assertBoard, mirroring `routes/memory.ts:321-350`).

---

## 5. EM passdown of vetted context

Today the EM→sub-agent boundary carries only free-text child title/description + the FROM-agent's private `agent_memory` brief (`agent-handoff.ts:53-69`); it never touches vetted `memory_entries`, and small tickets suppress memory entirely (`heartbeat.ts:3831`).

### 5.1 Assembly at delegate time

New service `server/src/services/em-passdown.ts` → `buildPassdownPacket({ companyId, childIssueId, title, description, serviceScope, complexity, curatedMemoryEntryIds? })`:

1. `queryRanked` over layers `['shared','workspace']` (NOT `personal`) keyed on child title+description+serviceScope, **with `requireVerified` / `minConfidence`** so the packet is genuinely vetted.
2. UNION with EM-pinned `curatedMemoryEntryIds` (escape hatch for the weak hash ranker).
3. Confidence-filter (drop `score < 0.15`), conflict-resolve, token-budget.
4. Persist the typed manifest into the existing-but-unused `agent_handoffs.artifactRefs` jsonb (`schema/agent_handoffs.ts:30`) — **zero schema migration** on the handoff side.

### 5.2 Ticket-size tiering

Reuses `complexity` already resolved at delegate (`issues.ts:1178-1179`) and the existing budget curve (small=12k / medium=32k / else 48k, `context-budget-telemetry.ts:336-342`):

- **small** → 1-3 highest-confidence verified entries, shared-only, ~1.5k tok
- **medium** → ≤6 entries incl. workspace conventions for the serviceScope, ~4k tok
- **large** → ≤12 entries spanning shared+workspace + recent human-answers/approved-PR decisions, ~8-10k tok + parent-issue digest

### 5.3 Injection (the dual-channel fix)

Add `context.combynePassdownContext`, populated in heartbeat from the handoff's `artifactRefs` after the handoff block (`heartbeat.ts:3797-3830`). Register it in `buildPreambleSectionsFromContext` (`context-budget-telemetry.ts:348`) as cache-stable priority-1 with a hard `maxTokens`, insert `'passdown'` after `'handoff'` in `composer.ts` `stableOrder` (`:158-167`), add the `writeSectionBackToContext` case, and concatenate in each consuming adapter (`claude-local execute.ts:407-421`, `codex-local`). For cursor/gemini/opencode/pi (which consume zero memory fields), the brief-embedded `## Vetted context from your manager` section in `buildBriefMarkdown` is the fallback.

**Critical:** the packet injects **even for `focused_small`** (governed override of small-ticket suppression) with a hard ~1.5k cap. **And** the sub-agent's own self-retrieval at `heartbeat.ts:3913` gets the same `requireVerified` filter (§3.2).

> **Critic add — prompt-cache staleness.** The composer places `memory`/`passdown` in the cacheStable tier specifically to win provider prompt-cache hits across wakes (`composer.ts:153-167`). A fact corrected/superseded/redacted in Postgres between two wakes can still be served from the cached prefix until the cache TTL expires — "we fixed the fact" becomes "agents kept being told the old one for the cache lifetime." Bound this: bust the cache key for a company's stable tier when a verified entry it contains is superseded/redacted, or accept and document the cache-TTL staleness window. Cost-optimization pressure (bigger stable tier) widens this window, so it must be tracked.

### 5.4 Flow-back-up

The §4.1 human-answer capture is exactly what makes a child-ticket human answer retrievable by the next EM passdown. The governed path: child human-answers + merged-PR decisions → central `memory_entries` (verified) → EM passdown packet.

---

## 6. Deployment recommendation (self-hosted)

**Start with Option A → grow into Option B; keep C and D as explicitly-deferred, trigger-gated upgrades.** Every step is config-only against the existing `DATABASE_URL` switch.

### 6.1 Recommended topology path

| Option | What it is | Self-hosted fit | Verdict |
|---|---|---|---|
| **A. Docker-Compose Postgres on a single VM** *(START HERE)* | The repo's existing `docker-compose.yml` (Postgres + app, healthcheck, `pgdata` volume) with **two changes**: swap `postgres:17-alpine` → `pgvector/pgvector:pg17` (so the §8 pgvector path is available later) and run the §6.3 cutover ETL so the central DB doesn't boot empty. App auto-migrates on boot (safe at single replica). | Exact fit — user controls 100% of data on their own VM; no third party. | **Phase 2 central cutover.** Lowest burden; smallest step beyond embedded that gives a durable, network-reachable, pgvector-capable Postgres. |
| **B. Managed Postgres in the user's OWN cloud account (RDS / Cloud SQL)** *(GROW INTO)* | Same `DATABASE_URL` switch pointed at a managed endpoint in the user's account. Provider handles OS/patching, **automated backups + PITR**, and Multi-AZ failover. pgvector via `CREATE EXTENSION vector`. | Still self-hosted in the locked sense — no third party holds the data; user owns the account and the kill switch. | **Team landing spot.** Offloads exactly the liability A makes the user own by hand. **Pick RDS or Cloud SQL, NOT Fly Postgres** (Fly is operationally closer to A — you still own backups). |
| **C. Kubernetes Postgres operator (CloudNativePG) with HA** | Operator-managed primary + replicas, automatic failover, continuous WAL→object-storage backup, a managed pgbouncer (`Pooler` CRD). | Self-hosted; strongest multi-company fit. | **Deferred (Phase 4 destination only).** Wildly disproportionate today — the repo ships zero k8s manifests. Adopt only at true multi-company scale when you already run Kubernetes. |
| **D. Primary + read-replica for retrieval read scaling** | Scaling overlay on B or C: route the hot read path (retrieval every heartbeat, future pgvector ANN) to a replica; writes/migrations to the primary. | Self-hosted. | **Deferred, measured-trigger only** (retrieval read latency / primary CPU sustained high). Requires net-new read/write-split wiring (`createDb` returns a single connection, `client.ts:50`) **and a read-your-writes rule** so a freshly-captured human-answer isn't briefly invisible behind replica lag. |

### 6.2 Connection-layer hardening (applies to embedded too — replaces every Supabase/Supavisor specific)

- **`client.ts:14-17`:** detect pooling robustly — `prepare:false` when `port==='6543'` OR host contains `pgbouncer`/`pooler` OR `COMBYNE_DB_DISABLE_PREPARE==='true'` (postgres-js named prepared statements break under transaction pooling). Reconcile `doc/DATABASE.md`, which currently hand-instructs editing `createDb` to unconditional `{prepare:false}` (doc/code already disagree).
- **`client.ts:50-52`:** pass explicit sizing — `max=Number(COMBYNE_DB_POOL_MAX)||10`, `idle_timeout=30`, `max_lifetime=1800`, `connect_timeout=15`. **We own `max_connections`** — budget math: `app_pool_max × replicas + maintenance(max:1 × ~6 paths) + migration job + scanner pool < our_max_connections`. There is no Supabase 200-conn cap and no Supavisor; *we* set the number and *we* let pgbouncer absorb fan-out.
- **Pooling at team scale:** front self-hosted Postgres with **pgbouncer in TRANSACTION mode** for stateless app traffic; reserve a **SESSION-mode endpoint (or direct :5432)** for the two traffic classes transaction mode breaks: (a) the per-request RLS path (`SET LOCAL` in an explicit txn) and (b) the `BYPASSRLS` background heartbeat scans (`heartbeat.ts:6559`).

### 6.3 Migration model (resolving the auto-apply default)

Because headless boots **already auto-apply** with no advisory lock (`index.ts:135`):

- **Today / single-replica (A):** keep app-auto-apply but make it **explicit** (`COMBYNE_MIGRATION_AUTO_APPLY=true`). Land the `COMBYNE_RUN_MIGRATIONS_ON_BOOT` gate (net-new) **in the A phase as a guardrail** — the moment the operator runs even two app containers for a zero-downtime restart, the race is live.
- **Bridge (single→few replicas):** wrap `applyPendingMigrations` in a **blocking** `pg_advisory_lock` acquired on its **own reserved `max:1` connection** (`client.ts:647`). The lock MUST be on the dedicated connection — the repo documents (`summarizer-queue.ts:15-19`) that pooled session-scoped locks land on different backends; a pooled lock silently stops serializing and gives false confidence. The existing `summarizer-failures.ts:165` uses the non-blocking `try` variant — use the **blocking** variant so racing replicas wait, not skip.
- **Team / multi-replica (B):** set `COMBYNE_RUN_MIGRATIONS_ON_BOOT=false` and run a **one-shot `pnpm db:migrate`** (`packages/db/src/migrate.ts`, already wired as `db:migrate`) against the **direct :5432** endpoint as a pre-deploy CI/init-container step.

### 6.4 Backups / PITR

- **A (single VM):** the existing `pg_dump` path (`db:backup`) on a cron is the zero-infra logical baseline **and** the input to the §6.5 ETL. But its weakness is the honest framing: *A is fine for a SHORT window.* **Do not park a team's curated knowledge on un-restore-tested A for months** — STRICT human-gated content is the highest-value, least-regenerable data in the system. Configure WAL archiving + a tested restore drill (pgBackRest or `pg_basebackup`+`archive_command`) early, or treat the window as short and move to B.
- **B (managed in your account):** lean on the provider's automated snapshots + PITR + Multi-AZ — still self-hosted because *you* own the account. Keep periodic `pg_dump` as the portable logical export.

### 6.5 Cutover ETL (net-new, the missing tool — refuse-to-proceed on empty import)

`company-portability.ts` carries **no** memory table (config-only bundle), so switching `DATABASE_URL` today **silently boots an empty central DB and loses all dogfooded memory.** New scripts:

- `server/scripts/memory-export.ts` — dump `memory_entries` (+promotions, +usage, +agent_memory; **NOT** `transcript_summaries`) to JSON, preserving layer/owner/tags/**stored jsonb embedding byte-for-byte** + the new trust columns + `embeddingVersion`.
- `server/scripts/memory-import.ts` — insert under target company id via `memoryService`, `--owner-remap local-board→<userId>` for personal entries, idempotent on `(companyId, layer, subject, source)`.
- `package.json` scripts `db:memory-export` / `db:memory-import` mirroring `db:backup`.
- **The cutover doc must refuse to proceed without a verified non-empty import** — this is a hard gate, not a checklist line.

---

## 7. Scaling defenses folded into the roadmap (prioritized stack)

The scaling clusters surfaced failure modes that grow with corpus size and team count. The **prioritized defense stack** (from the critic), in execution order:

1. **Two-sided trust gate FIRST** (§3.2) — write-side force-unverified for agent authors **and** `requireVerified` on **both** retrieval channels. Label-only (Release N) → exclude (Release N+1). The structural ceiling on hallucination blast radius; precedes everything else. Guard with the both-channels test + the `queryRanked` call-site lint gate.
2. **Idempotent `(companyId,source)` upsert + secret/redaction write-gate** (§4.3, §4.4) — cheap, deterministic; ship alongside the trust gate. Protects the promotion signal and stops the highest-trust tier from accumulating secrets/duplicates before the corpus grows.
3. **Fail-closed app-layer `companyId` hardening + a CI cross-tenant isolation suite** — `throw` on empty/undefined `companyId` at the **top** of `assertCompanyAccess` for ALL principals incl. `local_implicit`/`isInstanceAdmin` (`authz.ts:25` currently skips the membership check for those). The bridge fence before RLS, and the regression net for the `SET`-vs-`SET LOCAL` hazard. Tests: company B cannot read A via every retrieval path; empty `companyId` rejected; the unscoped usage-log path covered.
4. **Fix the silent-truncation + popularity defects** —
   - **Remove the nondeterministic windows:** `loadCandidates .limit(500)` and `runDecayPass .limit(2000)` both have **no ORDER BY** (`memory.ts:337`, `:680`). Above the cap, the ranker/cleanup sees only an arbitrary physical slice — the globally-best (or stalest) row can be invisible, and the same query returns different context on different runs. Add `ORDER BY` + pagination (and once §8 lands, the pgvector `ORDER BY … LIMIT k` pushdown removes the candidate window entirely).
   - **Provenance-aware TTL + decouple recency from usage:** `recencyBoost` keys off `max(lastUsedAt, updatedAt)` and `recordUsage` bumps `lastUsedAt` on every retrieval (`memory.ts:110-116`, `:446-468`) — a rich-get-richer loop that keeps stale-but-popular facts winning and is **immune to the only cold-start cleanup** (`usageCount===0`). Key recency off `updatedAt` (truth-age), with an evergreen escape hatch.
   - **Harden promotion signal:** `runAutoDistill` orders by raw `usageCount` (`memory.ts:705-745`) — promote on `COUNT(DISTINCT issue_id)` excluding self-retrieval, not raw count, so ranker noise isn't laundered into authority. (Critic caveat: distinct-issue is still retrieval breadth, not *usefulness*; pair with the §9 outcome-feedback loop.)
   - **Wire scheduled decay/auto-distill into the heartbeat scheduler** — they exist (`memory.ts:672-745`) but are reachable only via board-gated manual POST routes; no scheduler ever calls them. Per-company tick next to the existing scheduler loop, under the §8.3 `BYPASSRLS` role once RLS lands.
5. **Real model embeddings + self-hosted pgvector ANN** (§8) — the root fix for hash-64's near-zero synonym recall, shipped **WITH** `embeddingVersion` + a re-embed backfill. Enables MMR/dedup/cross-encoder/near-dup to actually work.
6. **Postgres RLS + `BYPASSRLS` scheduler role + pgbouncer** (§8.3) — the DB-level multi-tenant fence; mandatory before the second company. **Add the missing FK + RLS policy on `memory_usage`** (`memory_layers.ts:113` declares `companyId` as a bare uuid with no `.references()`, unlike `memory_entries`) — it's the highest-volume tenancy table and currently the weakest-scoped.
7. **Re-verification + observability LAST** (§9) — the residual-risk catch: periodic re-resolve of `sourceRefId` (PR reverted? issue deleted?) demoting drifted verified rows to `needs_review`; per-query provenance/confidence/age telemetry; the early-signal dashboards (semantic-score variance collapse, distinct-subject ratio in top-k, days-since-decay, `verifiedAt` age distribution, candidate-cap-hit rate).

---

## 8. Retrieval & isolation destinations (self-hosted recasts)

### 8.1 Retrieval — pgvector + a self-hosted real embedder, dimension deferred (recommended: B3)

- **Today (Phase 0-2):** keep the FNV-1a hash-64 jsonb + in-Node cosine path (`memory.ts:24-44,71-78,322-346`) as the default **and** the deterministic test oracle, behind `COMBYNE_VECTOR_SEARCH_ENABLED=false`. Small corpus, privacy-paramount, zero deps.
- **Phase 4:** install pgvector **on our own Postgres** (image swap / `CREATE EXTENSION` — no embedding SaaS, no data egress). Ship a **NULLABLE `embedding_vec vector(N)` column with NO HNSW index yet**, and **build HNSW last**, only after `N` is validated against real recall on the **real corpus** (verified human-answers + PR-approval notes). Replace the `.limit(500)` unordered window with `embedding_vec <=> $q ORDER BY … LIMIT k`.
- **Source embeddings from a SELF-HOSTED/local model** (bge / nomic-embed / sentence-transformer on our infra), **not a third-party embedding API** — human Q&A and EM notes can contain credentials/PII; self-hosted hosting exists for data control, so the privacy answer is *run the embedder ourselves*. Default target **1536** (cheaper HNSW than 3072) unless recall testing proves otherwise.
- **Operational load-bearing detail:** a self-hosted embedder is an inference service we keep available and batch. A slow/down embedder must **not block writes** — embed async / fall back to the hash path, then backfill; otherwise the capture hooks fail or write unretrievable entries. The dimension is still eventually load-bearing (HNSW on `vector(1536)` → a different model family forces a new column + full re-embed + reindex), so pick a family you can commit to.

### 8.2 Isolation — RLS at the team-onboarding boundary (recommended: A3, a HARD gate)

Tenancy is locked MULTI-TEAM, so **RLS is mandatory**, not optional — but its value lands only when a second tenant or untrusted human exists.

- **Bridge (single operator):** app-layer `assertCompanyAccess`, hardened to **fail-closed on empty/undefined `companyId`** for admin/`local_implicit` (defense-stack item 3).
- **The gate (refuse-to-proceed in the cutover doc):** enable RLS the moment **2+ companies share the instance OR the first non-local authenticated multi-user joins.** Not "someday." The migration (`0053`) ships policies + the `BYPASSRLS` scheduler role; the request-path change ships the per-request transaction + `SET LOCAL`. **Author and CI-test both ahead of the trigger against the single tenant; flip at the boundary** — de-risking the retrofit without carrying its hot-path cost early. **The gate must be a CI/cutover hard-stop, not a checklist item** — if skipped, you ship multi-tenant on a one-WHERE-clause-deep fence.

### 8.3 The three self-hosted RLS interaction risks (named blocking prerequisites)

1. **`BYPASSRLS` role or background processing silently halts.** The heartbeat `tickTimers` global scan does `db.select().from(agents)` with no company filter (`heartbeat.ts:6559`); the decay pass, summarizer, and the new ETL run outside any request actor. Under RLS these return **zero rows** with no error — instance-wide processing stops. They must run as a *we-created* `CREATE ROLE … BYPASSRLS` scheduler role, and the **app role must NOT have BYPASSRLS**. The `BYPASSRLS` audit is unbounded by nature (every cross-company path independently breaks to zero-rows) — completing it is a flip-time gate. Background code under `BYPASSRLS` loses the RLS net exactly where it has the most power, so those scans need their own isolation tests.
2. **`SET LOCAL` inside a per-request transaction, not plain `SET`.** There is **no per-request transaction today** — `actorMiddleware` sets `req.actor` then `next()` on the shared pool (`auth.ts:20-25`). A plain `SET app.current_company` on a pgbouncer **transaction-mode** checkout is unsafe: the `SET` and the query may land on different backends (the pinning hazard `summarizer-queue.ts:15-19` documents). The fix is `SET LOCAL` inside an explicit `db.transaction()` that also contains the query (auto-cleared at COMMIT, so it can't leak into the next checkout), and route RLS-scoped traffic through **pgbouncer SESSION mode** (or direct :5432). **Building this per-request transaction wrapper is the real cost of RLS — deferring only changes *when*, not *whether*.**
3. **`local-board`-owned personal rows become unreachable under company-keyed RLS unless the ETL owner-remap ran first** (§6.5, §7) — sequence the owner-remap before enabling policies.

### 8.4 Per-tenant JWT (paired workstream at the same boundary)

The agent JWT is signed by a **single global secret** (`agent-auth-jwt.ts:97-109`) and the middleware trusts `company_id` verbatim (`auth.ts:113-120`). A leaked secret forges any tenant's claim — and **RLS does not rescue you**, because the app sets the tenant GUC from that same trusted claim. Per-tenant key separation must land **WITH** RLS, not be assumed covered by it.

---

## 9. Resolved decisions (was "Open decisions") — companion-locked 2026-06-03

All prior open decisions are now **RESOLVED** by user direction. See `doc/MEMORY_UI_AND_QUALITY_PLAN.md` for full implementation of items 1, 3, 4, 5(gate), 7.

1. **Embedding model & dimension — RESOLVED: managed-API `text-embedding-3-small` @ dim 1536.** Quality chosen over the self-hosted-privacy default (explicit user override). ONE team-shared key (`COMBYNE_EMBEDDING_API_KEY` → `OPENAI_API_KEY`), set once at install; unset → `vectorSearchEnabled` coerced false → hash-64 local-only, no egress, no crash. Ship `vector(1536)` **nullable**, build HNSW **last** after real-corpus recall validation. `embedding_version` mandatory (closes the `cosineSimilarity` `memory.ts:73` min-len silent-truncation hazard via a version-equality guard). *Rationale: the summarizer HTTP-driver + config `envVar` patterns make the swap small; small@1536 = cheaper HNSW; pgvector storage stays self-hosted.*

2. **Verification SLA — RESOLVED: Hybrid.** Human-answer + PR-approval verified at write (they ARE the human signal); agent-claims stay `unverified` until a board verify action OR reuse across N distinct issues, surfaced in the `/memory/verify` queue. *Rationale: matches the existing board-promotion checkpoint; distinct-issue reuse is breadth-not-usefulness, so pair with decision 7.*

3. **Captured human Q&A layer — RESOLVED: `workspace`, behind a BLOCKING redact-before-embed/PII gate.** Net-new body-text scanner (`secret-scan.ts`; `redaction.ts` is key-based only) runs before every embedder egress AND before write; detection → redact span + `needs_review` (excluded from retrieval). *Rationale: reusability is the point; the highest-trust never-expiring tier must never accumulate secrets, especially now that bodies egress to the managed embedder.*

4. **Conflicting human-answers on one `subjectKey` — RESOLVED: show-the-conflict, default-surface newest-by-that-user, OVERRIDE / MERGE / EDIT in the UI** (NOT silent newest-wins, NOT needs_review-exclude). First-class `/memory/conflicts` tab; MERGE writes a new canonical + supersedes both via `supersededById`. *Rationale: user decision #5; `subjectKey` is conservative, so the tab is labeled "Detected conflicts" and under-reports paraphrases until real embeddings land.*

5. **Sufficiency gate (ask-don't-hallucinate) — RESOLVED: ship as a HARD gate, not advisory.** On `insufficient`: (H1) **withhold** the sub-threshold context from the prompt; (H2) post a **gate-authored** question directly via `routeAgentQuestionsToManager` + a deterministic status transition — neither depends on agent compliance (the advisory design failed because `extractAndPostQuestions` only fires on `outcome==='succeeded'` and scrapes agent output). No-op until `0049` + HOOK 1 land; label-only first; thresholds keyed by `embedding_version`. Loop closes via HOOK 1; assumption-flagged answers forced `unverified` by the `input.assumption` code flag, never the body prefix.

6. **Self-hosted sizing & durability tier — UNCHANGED:** start **Option A** (Docker-Compose Postgres on a VM, `pgvector/pgvector:pg17`), **move to Option B** (managed Postgres in your own AWS/GCP account) before onboarding a team. Gating question: **which cloud are you on?** Do not pick Fly Postgres expecting RDS-grade durability.

7. **Re-verification + observability — RESOLVED: ship in Phase 4 as the residual catch.** Per-query provenance/confidence/age signals + the input→output dashboard (`sufficiency_verdict` telemetry, repeat-question rate, PR-approval rate, rework count) + `GET /memory/embedding-status` (version coverage, token spend, hash-fallback rate, redaction-blocked count). *Rationale: "human-verified-but-wrong" and "stale-but-once-verified" survive the full stack; make them observable, not hidden.*

> **Locked-axis reversal recorded:** decision 1 egresses post-redaction memory bodies to a managed embedding API — the SINGLE external dependency, by explicit user choice. This supersedes the prior "no third-party-held data" posture (`CENTRAL_DB_DEPLOYMENT_OPTIONS.md §0`, `HALLUCINATION_AT_SCALE.md` preamble) **on the embedder axis only**; storage stays 100% self-hosted. To be carried verbatim in `doc/PRIVACY_DISCLOSURE.md` and the Setup-screen acknowledge checkbox. The disclosure must NOT overclaim that best-effort regex redaction makes egress private — it bounds **credential** leakage, not business-content confidentiality.

---

## 10. Serialized migration plan

| # | File | Phase | Purpose |
|---|---|---|---|
| **0048** | `0048_memory_owner_id_text.sql` | 1 | `owner_id uuid→text`, rebuild owner idx (must precede any owner-fence policy / personal-memory ownership) |
| **0049** | `0049_memory_trust_spine.sql` | 1 | provenance / verificationState / confidence / authorType / subjectKey / supersededById / **embeddingVersion** + trust+subjectKey indexes + unique `(company_id, source)` partial; mirror subset on `agent_memory`; backfill (§3.5) |
| **0051** | `0051_issue_service_scope.sql` | 1 | `issues.service_scope text` (explicit retrieval target for passdown) |
| **0052** | `0052_pgvector_embeddings.sql` | 4 (self-hosted) | `CREATE EXTENSION vector`; nullable `embedding_vec vector(N)`; **HNSW built last** after N is validated |
| **0053** | `0053_memory_rls_team_phase.sql` | 4 (team gate) | RLS policies on memory tables (**incl. `memory_usage` FK + policy**) + `BYPASSRLS` scheduler role |

Update `meta/_journal.json` once per landed migration, never per-design. (`0050` markdown-vault columns are deferred with the optional export and intentionally omitted from the critical path.)

---

## 11. Phased roadmap (file-level; each phase names real files)

### Phase 0 — Use TODAY (zero deploy)
The 4-layer system is fully wired in single-user embedded mode (`index.ts:284-428`, `auth.ts:23-24`). **No code changes.** Dogfood the live memory REST surface (`routes/memory.ts:23-368`) + UI (`ui/src/pages/CompanyMemory.tsx`); write `workspace` conventions/runbooks and verify injection via `queryRanked` (`heartbeat.ts:3895-3947`); curate `shared` through the existing board promotion review (`routes/memory.ts:321-350`); manually paste ticket Q&A + EM approval rationale as interim capture; keep `COMBYNE_SUMMARIZER_ENABLED` off; tag entries with `serviceScope`.

### Phase 1 — Trust spine + write-paths (still embedded; label-only retrieval)
- Migration **0048** `owner_id uuid→text` + rebuild owner idx; relax `validators/memory.ts:21,57,67` to `z.string().min(1).max(128)` with a format check; change `schema/memory_layers.ts:37` to `text`. Pre-flight: grep for `eq(memoryEntries.ownerId,<uuid>)`; add a test that a user cannot read another principal's personal entry.
- Migration **0049** trust spine + `embeddingVersion` + indexes + unique `(company_id,source)`; mirror subset on `agent_memory`; backfill per §3.5.
- Migration **0051** `issues.service_scope`.
- `memory.ts` `createEntry`: write-side force-unverified gate (§3.2); compute `subjectKey`; idempotent `onConflictDoNothing` upsert on `(companyId,source)`.
- `routes/memory.ts:23`: override provenance/verificationState for agent actors; add board-gated `POST /memory/entries/:id/verify`.
- **HOOK 1** (`routes/issues.ts:1045-1112` + `agent-question-routing.ts:405`): load the question comment, capture human-answer entries gated on a real human and `assumption!==true`; **redaction gate** (§4.4).
- **HOOK 2** (`issue-pull-requests.ts:572-617` merge + route `:181-203`): deterministic `captureApprovalMemory`; tag existing `createMemoryFromEvent` as `agent-claim/unverified`.
- Render: `heartbeat.ts:3934-3947` add citation + `UNVERIFIED` sub-header + non-executable fence — **label-only**.
- New scripts: `memory-export.ts` / `memory-import.ts` + `db:memory-export/import` (copy stored jsonb embedding byte-for-byte; exclude `transcript_summaries`).
- **Guardrail (land here, not later):** the `COMBYNE_RUN_MIGRATIONS_ON_BOOT` gate + the blocking advisory-lock on the migration's reserved connection (§6.3) — so scaling to 2 replicas can't hit the unguarded race.

### Phase 2 — Self-hosted central DB cutover (Option A)
- `client.ts:14-17`: robust pooler detection + `COMBYNE_DB_DISABLE_PREPARE`; reconcile `doc/DATABASE.md`.
- `client.ts:50-52`: explicit pool sizing + our-`max_connections` budget math (§6.2).
- Swap `docker-compose.yml` `postgres:17-alpine` → `pgvector/pgvector:pg17`; configure WAL archiving + a tested restore drill (or treat the window as short).
- Run `pnpm db:migrate` against direct :5432; `db:memory-export` from `~/.combyne-ai` then `db:memory-import --owner-remap local-board→<userId>`. **Refuse to proceed without a verified non-empty import.**
- Point app `DATABASE_URL` at the central endpoint; switch `DEPLOYMENT_MODE` to `authenticated+private`.
- **Flip `requireVerified`** at both retrieval channels (Release N+1) now that capture + a verify path exist.

### Phase 3 — EM passdown + first teammates
- New `server/src/services/em-passdown.ts`: `buildPassdownPacket` over `[shared,workspace]` with `requireVerified`/`minConfidence` + `curatedMemoryEntryIds` union + complexity tiering.
- `routes/issues.ts` delegate (1170-1268): accept `curatedMemoryEntryIds[]` + `serviceScope`; persist packet into `agent_handoffs.artifactRefs`.
- `agent-handoff.ts` `createHandoff` + `buildBriefMarkdown`: write `artifactRefs` (replace always-`[]` at `:162`) + `## Vetted context from your manager` fallback.
- `heartbeat.ts`: `combynePassdownContext` from `artifactRefs`, injected even for `focused_small` (hard ~1.5k cap); **add `requireVerified` to the sub-agent self-retrieval at `:3913`**.
- `context-budget-telemetry.ts:348` / `composer.ts:158-167`: register `'passdown'` (priority 1, cacheStable) after `'handoff'`; mind the §5.3 prompt-cache staleness.
- `claude-local execute.ts:407-421` + `codex-local`: concatenate `combynePassdownContext`.
- `access.ts`: `ensureMembership` at teammate invite; **pre-onboarding `workspace` content audit + redaction sweep**.

### Phase 4 — Multi-team RLS + self-hosted pgvector (HARD GATE before company #2)
- **RLS is the gate, not a deferral.** Before the second company or first non-local multi-user (§8.2): migration **0053** RLS policies (incl. `memory_usage` FK + policy) + `BYPASSRLS` scheduler role for `heartbeat.ts:6559`; `actorMiddleware` (`auth.ts:20`) `SET LOCAL app.current_company` inside a per-request transaction (§8.3); `authz.ts` fail-closed on empty `companyId`; pgbouncer transaction-mode + a session-mode endpoint for RLS/scanner traffic; per-tenant agent-JWT key separation (§8.4); the CI cross-tenant isolation suite as a merge gate.
- **Retrieval upgrade (decoupled):** decide the embedding family/dimension (§9-item-1), then migration **0052** (nullable `vector(N)`, HNSW built last); `memory.ts` `embedText`/`loadCandidates` behind `COMBYNE_VECTOR_SEARCH_ENABLED` (embedded keeps the jsonb hash path as the deterministic test oracle); ship with `embeddingVersion` + a re-embed backfill.
- **Grow into Option B** (managed Postgres in the user's own account) when durability/uptime start to matter; **Option C/D** only on a measured trigger.

---

## 12. Obsidian / markdown (locked: Postgres is the single system of record)

**Keep PostgreSQL `memory_entries` as the system of record. Do NOT re-platform** onto Obsidian/Notion/Pinecone/Neo4j/mem0 — each loses multi-tenant scoping, the governed promotion path (`memory.ts:229`), and transactional server-side ranked retrieval in the run loop. Pinecone-as-SoR conflates storage with the ANN backend; the right retrieval upgrade is **self-hosted pgvector** (§8.1), orthogonal to any markdown move.

Per the locked decision, **bidirectional sync is rejected** as a staleness/hallucination vector. A **read-only markdown export** (one `.md`-per-entry with YAML frontmatter: `id`, `layer`, `provenance`, `verificationState`, `updatedAt`) is **at most a deferred nicety** for human browse/diff/audit, reusing the proven `company-portability.ts` Postgres→`.md` pattern, **gated by the §4.4 redaction sweep** so secrets never reach a committed file, and with **the agent read path always hitting the DB, never the vault.** It is explicitly **off the critical path**.

---

## 13. Residual risk (honest framing)

Even with the full stack shipped, hallucination risk is **reduced and bounded, never zero.** Three irreducible residuals remain:

1. **Human-verified-but-wrong.** The trust model treats human content as authoritative, but a human can paste an injection or a stale/incorrect fact, `local_implicit` satisfies `actorType==='user'` (`authz.ts:46-51`), and nothing re-verifies a verified row after capture. A confidently-wrong human fact is *harder* to dislodge than a wrong agent-claim. `requireVerified` **concentrates** this risk rather than removing it.
2. **Staleness-after-capture.** "Verified" is freshness-at-capture, never freshness-now. With no re-verification job, a nondeterministically-windowed decay pass (`memory.ts:680`), and deliberate prompt-cache-stable placement (`composer.ts:158-167`), a fact can be true when verified and false when retrieved, with the correction lagging by the cache TTL.
3. **Retrieval is approximate by construction.** ANN recall is <100%; `subjectKey` canonicalization is conservative-by-design (residual duplicates and missed cross-lingual/synonym supersessions persist); the composer still tail-truncates.

**Honest claim:** agent-fabricated claims are quarantined and cannot reach authoritative retrieval; the blast radius of any single bad entry is bounded to one tenant and (with the §3.7 render defenses + verified-only) framed as data, not instruction. But **wrong-but-human-blessed** and **stale-but-once-verified** content will still occasionally surface as fact. The system must ship with **per-query provenance/confidence/age signals and an outcome-feedback loop** (defense-stack item 7) so these residuals are *observable and correctable*, not hidden.