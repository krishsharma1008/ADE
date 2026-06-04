# Memory UI & Retrieval-Quality Plan — Companion to `CENTRAL_CONTEXT_DB_PLAN.md`

> Status: **the plan to execute, second half.** Destination doc: `doc/MEMORY_UI_AND_QUALITY_PLAN.md`.
> This is the implementable companion to `doc/CENTRAL_CONTEXT_DB_PLAN.md` (the "core plan"). The core plan ships the **trust spine** (migration `0049`), the **two write-hooks** (HOOK 1 human Q&A, HOOK 2 EM PR-approval), **EM passdown**, **self-hosted Postgres cutover**, and **RLS**. This doc adds the three workstreams the core plan flagged but did not fully specify:
>
> 1. **Managed-API embedding backend** — quality embeddings from ONE team-shared key, set once at install, with an airtight **redact-before-embed** gate, `embedding_version` tracking, cost/rate governance, and a **retrieval-quality test harness** that measures *input-quality → output-quality*.
> 2. **Ask-don't-hallucinate sufficiency gate** — a **HARD** decision point (not advisory) that, when retrieved context is insufficient, withholds the sub-threshold context and posts a gate-authored clarifying question through the existing question flow, then **closes the loop** when the human answer feeds HOOK 1 back into the DB.
> 3. **The full memory-layer UI/UX** for all eight flows, with the **conflict merge/override screen** made first-class (user decision #5).
>
> Every code claim is grounded with `file:line` against the live tree (HEAD migration `0047`; `memory.ts:34/73/155/235/269/337/647`; validator at **`packages/shared/src/validators/memory.ts:31-37`**, NOT `server/src/validators`; `summarizer-driver-anthropic.ts:36-46`; `config.ts:25`; `heartbeat.ts:3905-3947/5382`; `agent-question-routing.ts:50/405`; `redaction.ts:1-3`; `Approvals.tsx:88-100`; `routes/memory.ts:70-73/321`; `ui/src/api/memory.ts:4-13`; `Sidebar.tsx:113`; `App.tsx:154`; design-guide `SKILL.md:293`).

---

## 0. How this depends on the core plan (read first)

This companion is **strictly additive** and **strictly downstream** of the core plan. It does not re-decide any of the four locked decisions, the trust spine, or the deployment topology. It introduces exactly **one deliberate reversal** of a previously-locked axis, which §1.0 records explicitly.

### 0.1 The RESOLVED user decisions this doc honors

| # | Decision | Where implemented here |
|---|---|---|
| 1 | **Embeddings = managed API embedder** (e.g. OpenAI `text-embedding-3-small`). ONE team-shared key, set once at install. Redact-before-embed + privacy disclosure are **blocking**. Need `embedding_version`/model/dim tracking, cost/rate governance, and a retrieval-quality harness. | §1 (backend), §1.4 (redaction), §1.6 (harness), §3.7 (Setup UI) |
| 2 | **Sufficiency gate (ask-don't-hallucinate)** — on low-confidence/insufficient context the agent ASKS via the existing question flow instead of fabricating; the answer feeds back via HOOK 1 so input→output improves over time. | §2 (the whole section) |
| 3 | **Verify SLA = Hybrid** — human-answer + PR-approval verified at write; agent-claims unverified until a board verify action OR reuse across N distinct issues. | §3.4 (Verify queue UI), consumes core-plan §3.2 write gate |
| 4 | **Captured-answer layer = `workspace`, behind a BLOCKING redaction/PII gate.** | §1.4, §2.5, §3.6 (Redaction queue UI), consumes core-plan §4.4 |
| 5 | **Conflicts = show the conflict; default-surface newest-by-that-user; OVERRIDE / MERGE / EDIT in the UI** (not silent newest-wins, not needs_review-exclude). | §3.5 (the first-class Conflict resolver), §2.6 (gate interaction) |
| 6 | **Postgres + ADE UI is the single system of record; strict human-gated trust; multi-team (RLS before company #2); self-hosted DB. The embedding API is the one external dependency, by explicit choice.** | Whole doc; reversal recorded in §1.0 |

### 0.2 Migration sequencing — one shared prerequisite, owned once

The core plan's serialized migration table (`CENTRAL_CONTEXT_DB_PLAN.md §10`) is HEAD-`0047` → `0048` (owner_id text) → `0049` (trust spine) → `0051` (issues.service_scope) → `0052` (pgvector) → `0053` (RLS). This companion **adds nothing before `0052`** and **re-purposes `0052`** from "Phase-4 hosted-only pgvector, deferred" into "the embedding-swap dependency."

The review surfaced that **three designs silently assume `0049` exists and none owns landing it**, and that the sufficiency gate *also* hard-depends on `0049` **and** on `0051` (`service_scope`). This doc makes that ownership explicit:

> **Shared-prerequisite rule (non-negotiable):** `0048` → `0049` → `0051` are owned by the core plan's **Phase 1** and MUST land (and HOOK 1 must populate `provenance`/`verificationState`) before *any* code in this companion is enabled beyond label-only. The embedding swap (§1) lands `0052`; the sufficiency gate (§2) is a **no-op until `0049` + HOOK 1 ship** (§2.8). The UI (§3) ships **Browse-with-badges first** and lights up the queue tabs only as the backing hooks land (§3.9).

### 0.3 The one canonical `queryRanked` signature (collision-avoidance)

The review's sharpest cross-design conflict: **all three designs mutate `queryRanked`/`loadCandidates` concurrently** — the embedding swap adds `queryEmbedding`/version-guard + pgvector pushdown; the sufficiency gate adds `minConfidence`/`requireVerified`; the passdown packet calls the same functions. Without coordination they collide on the `opts` signature and the candidate-loading SQL.

**Resolution — define ONE signature, here, that all three consume** (`server/src/services/memory.ts`, `queryRanked` at `:365`, `loadCandidates` at `:322`, `rankEntries` at `:147`):

```ts
interface QueryRankedOpts {
  layers?: MemoryLayer[];
  ownerType?: MemoryOwnerType;
  ownerId?: string;
  limit?: number;
  includeSnippets?: boolean;
  // --- core-plan §3.2 trust filter (sufficiency gate + passdown consume) ---
  minConfidence?: number;        // default undefined = no floor (label-only)
  requireVerified?: boolean;     // default false until Release N+1
  excludeSuperseded?: boolean;   // default true once 0049 lands
  // --- this doc §1: embedding swap (query-side embedding lifted OUT of rankEntries) ---
  queryEmbedding?: { vector: number[]; version: string };  // precomputed by embedQuery
}

// rankEntries stays PURE + SYNC. It NO LONGER calls embedText(query) at :155.
// queryRanked computes queryEmbedding via embedQuery() BEFORE calling rankEntries
// and passes it in. The pure ranker is unchanged for the test oracle.
rankEntries(query: string, entries: RankInputEntry[], weights?, queryEmbedding?): RankedEntry[]
```

Every retrieval call site (heartbeat self-retrieval `:3913`, `em-passdown.ts`, and any future path) goes through `queryRanked` with this one shape. A `queryRanked` call-site **lint/grep gate** (core-plan §3.2) ensures no fourth path forgets the trust filter or the query-embedding lift.

---

## 1. Managed-API embedding backend + retrieval quality

### 1.0 The deliberate locked-decision reversal (record it loudly)

The prior locked docs are explicit that **no third party holds the data**:
- `CENTRAL_DB_DEPLOYMENT_OPTIONS.md §0`: *"No managed memory SaaS. No managed Supabase. No third-party-held data."*
- `HALLUCINATION_AT_SCALE.md` preamble: self-hosted Postgres, *"no managed memory SaaS"*; and `CENTRAL_CONTEXT_DB_PLAN.md §8.1`/§9-item-6 explicitly chose a **self-hosted** embedder *"because bodies can hold PII."*

RESOLVED user decision #1 **overrides this for the embedder only**: memory bodies (post-redaction) are egressed to a managed embedding API, **quality chosen over the self-hosted-privacy default**. This is a real, intentional reversal of one axis.

> **Reconciliation (must appear in three places, identically):** the embedding API is **the single external dependency, by explicit user choice**. Storage stays 100% self-hosted Postgres+pgvector (the rest of the locked posture is unchanged). The reversal is carried verbatim in (a) `doc/PRIVACY_DISCLOSURE.md` (§1.5), (b) the **Setup-screen acknowledge checkbox** (§3.7), and (c) the §9 resolved-decisions block of `CENTRAL_CONTEXT_DB_PLAN.md`. The two prior docs are **superseded on this one axis** and must not be read as still binding it. The disclosure must **NOT overclaim** that redaction makes egress private (§1.5 residual).

### 1.1 The architectural constraint that shapes everything

`embedText` (`memory.ts:34`) is **synchronous** and is called **inside the pure exported `rankEntries` at `memory.ts:155`** (`const queryEmb = embedText(query)`). `memory-ranker.test.ts` is the oracle that asserts `embedText` determinism + L2-normalization and `cosineSimilarity` ordering. Naively making the embedder async breaks the pure ranker and its tests.

**The load-bearing mitigation (verified correct by review):** lift the **query-side** embedding OUT of `rankEntries` into an async pre-step (`embedQuery`), pass the precomputed `queryEmbedding` into `rankEntries` (the new optional param in §0.3), and keep `rankEntries` synchronous and deterministic. **Storage-side** embedding (`createEntry:235`, `updateEntry:269-272`, `createSharedFromPromotion:647`) becomes async with a **hash fallback**, so a slow/down embedder never blocks or fails a write.

### 1.2 New config (mirror the `config.ts` `envVar` pattern at `:25`)

`config.ts` reads `envVar('SUFFIX') → process.env.COMBYNE_<SUFFIX>` with file-config fallback and an `''`-default that **never throws on unset** (e.g. `licenseSupabaseAnonKey`). The embedding config follows the same shape so "configured once at ADE setup" is honored and "unset → fall back, never crash" is the natural default. Add to the `Config` interface (`config.ts:~36-73`) and `loadConfig` return (`:~231`):

```
embeddingProvider     COMBYNE_EMBEDDING_PROVIDER     default 'openai'
embeddingModel        COMBYNE_EMBEDDING_MODEL        default 'text-embedding-3-small'
embeddingDim          COMBYNE_EMBEDDING_DIM          default 1536
embeddingApiKey       COMBYNE_EMBEDDING_API_KEY → OPENAI_API_KEY   (ONE team-shared key, set once)
vectorSearchEnabled   COMBYNE_VECTOR_SEARCH_ENABLED === 'true'     default false
embeddingMonthlyCapUsd COMBYNE_EMBEDDING_MONTHLY_CAP_USD  default '' (no cap; visibility-only)
embeddingRpm          COMBYNE_EMBEDDING_RPM          default 3000
```

**Coercion rule (closes the chatty-fallback hole):** if `embeddingApiKey` resolves empty, `vectorSearchEnabled` is **coerced false** at load and every path falls back to `embedText` hash-64 locally — no provider call, no egress, no crash. Validation of the key is **lazy** (happens in the driver on first use), exactly like the summarizer driver.

### 1.3 The HTTP driver — clone of the summarizer template

`server/src/services/embedding-driver.ts` **(NEW)** clones `summarizer-driver-anthropic.ts` (verified: `resolveApiKey` chain at `:36-46` walks `explicit → COMBYNE_SUMMARIZER_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY`; fail-loud-if-unset; `fetch` with `AbortController` timeout; `!response.ok` status-wrap). The embedding driver:

```ts
makeEmbeddingDriver({ apiKey, model, dim, endpoint }) → {
  embed(texts: string[]): Promise<{
    vectors: number[][]; model: string; dim: number; version: string; inputTokens: number;
  }>;
}
// resolveApiKey chain: explicit → COMBYNE_EMBEDDING_API_KEY → OPENAI_API_KEY
// POST https://api.openai.com/v1/embeddings  { model, input: texts[] }  (native batch)
// AbortController timeout 60s; try/catch + !response.ok status-wrap (mirror Anthropic driver)
// version = `${provider}:${model}:${dim}`  ← the embedding_version value
// On a dim mismatch in the API response: THROW (a misconfigured dim must not write a wrong-width vector)
```

The driver **never logs the key** — reuse `sanitizeRecord` (`redaction.ts`) on any structured log line, consistent with the summarizer.

### 1.4 The swap layer that keeps `rankEntries` pure — and where redact-before-embed lives

`server/src/services/memory-embedder.ts` **(NEW)** is the only module that calls the driver. **Both** egress paths route through it, and **both** run the secret scanner FIRST:

```ts
// STORAGE side (createEntry:235, updateEntry:269, createSharedFromPromotion:647)
async embedForStorage(subject, body): Promise<{ vector, version, redactedFindings }> {
  if (!vectorSearchEnabled || !apiKeyPresent) return { vector: embedText(subject+body), version: 'hash-64:64' };
  const scan = scanBody(`${subject}\n${body}`);          // §1.4.1 — BLOCKING, runs before any provider call
  const text = scan.clean;                               // redacted spans removed
  const cacheHit = lookupByContentHash(sha256(text), version);  // §1.7
  if (cacheHit) return cacheHit;
  try   { const r = await driver.embed([text]); return { vector: r.vectors[0], version: r.version, redactedFindings: scan.findings }; }
  catch { return { vector: embedText(subject+body), version: 'hash-64:64', redactedFindings: scan.findings }; }  // ANY error → hash, NEVER throw
}

// QUERY side (queryRanked, BEFORE rankEntries)
async embedQuery(text): Promise<{ vector, version }> {
  if (!vectorSearchEnabled || !apiKeyPresent) return { vector: embedText(text), version: 'hash-64:64' };
  const scan = scanBody(text);                           // §1.4.2 — the QUERY is egressed too; scan it
  try   { const r = await driver.embed([scan.clean]); return { vector: r.vectors[0], version: r.version }; }
  catch { return { vector: embedText(text), version: 'hash-64:64' }; }
}
```

#### 1.4.1 The body-text secret scanner (NEW — `redaction.ts` cannot do this)

`server/src/redaction.ts` is **key-based**: `sanitizeRecord` tests object **keys** against `SECRET_PAYLOAD_KEY_RE` (`:1`) and JWT **values** against `JWT_VALUE_RE` (`:3`). It **cannot scan a free-text body**. The threat is code-grounded and real: `agent-question-routing.ts:194` explicitly instructs agents to *"Escalate to the human only for credentials/access…"* — so the human's typed answer (the exact body HOOK 1 captures, and the body the embedder would egress) is a **credential-bearing channel by design**.

`server/src/secret-scan.ts` **(NEW)** — `scanBody(text): { clean: string; findings: Finding[] }`:
- Regex set: API keys (`sk-…`, `AKIA…`, `ghp_…`, `xoxb-…`), bearer/JWT (**reuse `JWT_VALUE_RE` from `redaction.ts:3`**), connection strings (`postgres://user:pass@…`), private-key PEM blocks, and generic high-entropy 32+ char tokens that follow secret-ish labels (**reuse `SECRET_PAYLOAD_KEY_RE` from `redaction.ts:1`** as the label regex).
- On detection: **redact the span in `clean`** AND set `verificationState='needs_review'` on the entry (excluded from retrieval) so a secret never both egresses AND lands in the highest-trust, never-expiring `workspace` tier.

#### 1.4.2 Redact-before-embed is airtight (the ordering invariant)

Made non-negotiable by three structural facts:
1. **`driver.embed()` is reachable ONLY through `memory-embedder.ts`.** No other module imports `embedding-driver.ts`. (Enforced by an ESLint `no-restricted-imports` rule on `embedding-driver` + a CI grep gate, mirroring the `queryRanked` call-site lint of core-plan §3.2.)
2. **Both** `embedForStorage` AND `embedQuery` call `scanBody` **before** the `driver.embed` call. The review flagged that query-side egress was under-emphasized: `embedQuery` egresses the **query text** (issue `identifier + title + description`, per `heartbeat.ts:3908-3912`), and **issue descriptions can also contain secrets**. The scanner runs on **both** paths and is **tested on both** (§1.8 (d)).
3. **Unset key = zero egress.** With no key, neither path calls the driver at all (§1.2 coercion) — the only egress is gated behind an explicit team-shared key set at install.

### 1.5 Privacy disclosure (`doc/PRIVACY_DISCLOSURE.md`, NEW) + setup docs

Document the single external dependency by explicit user choice. Must state, plainly and without overclaiming:
- **What is sent:** `subject + body`, **post-redaction**, to the configured managed embedding provider (default OpenAI `text-embedding-3`), for both newly-captured entries and the query text on retrieval.
- **What is NOT sent:** the team-shared API key is never logged (reuse `sanitizeRecord`); `transcript_summaries` are never embedded (excluded per core-plan §3.8/4.8).
- **The redact-before-embed guarantee — and its explicit bound:** the scanner removes **known credential shapes** before egress and quarantines the entry to `needs_review` on detection. It does **NOT** make egress private. **Redaction is best-effort regex**: it will miss novel secret shapes, and it does **not redact non-secret-but-sensitive business content at all** (a proprietary algorithm description, an unredacted password phrased as prose like "the prod password is hunter2"). The disclosure **bounds credential leakage; it does not guarantee body confidentiality.** This is a stated **residual**, per the review's privacy finding — it must not be closed.
- **This breaks the prior posture on one axis:** carry the §1.0 reconciliation verbatim — *"no third-party-held data"* held for storage but **not** for the subject+body egress to the embedder.
- **How to disable:** unset `COMBYNE_EMBEDDING_API_KEY` or set `COMBYNE_VECTOR_SEARCH_ENABLED=false` → hash-64, local-only, zero egress.

Reconcile `doc/DATABASE.md` setup docs to add the one-key-set-once-at-install step.

### 1.6 Schema + migration `0052`

`packages/db/src/schema/memory_layers.ts` (after `embedding` jsonb at `:44`):
- `embeddingVec` — a **pgvector** column. drizzle-orm `^0.38.4` has **no native vector type** (verified), so declare a `customType` wrapping `vector(1536)` (or a raw-sql column). **Keep the existing `embedding` jsonb column** as the hash-64 fallback **and** the deterministic test oracle.
- `embeddingVersion text` (NET-NEW — already mandated by core-plan §3.1), `embeddingModel text`, `embeddingDim integer`, `contentHash text` (sha256 of `subject+body` for cache + change-detect).

`packages/db/src/migrations/0052_pgvector_embeddings.sql` **(NEW; update `meta/_journal.json`)** — sequenced **after** `0049` (trust spine) + `0051` (service_scope), per §0.2:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE memory_entries
  ADD COLUMN embedding_vec vector(1536) NULL,
  ADD COLUMN embedding_version text,
  ADD COLUMN embedding_model text,
  ADD COLUMN embedding_dim integer,
  ADD COLUMN content_hash text;
-- DO NOT build HNSW in this migration. Ship the column nullable, backfill via the re-embed
-- script, THEN build CREATE INDEX CONCURRENTLY … USING hnsw (embedding_vec vector_cosine_ops)
-- once dim=1536 is validated against real-corpus recall (HNSW-build-last avoids reindex on a dim change).
```
**CI/test-rig caveat (verified risk):** the `embedded-postgres` dev/test rig may not ship the `vector` extension. CI and the test path MUST stay on the **hash-64 jsonb oracle** (`vectorSearchEnabled=false`) and never require pgvector — this is why the jsonb column and `embedText` are preserved permanently, not just transitionally.

### 1.7 Wiring the swap into `memory.ts`

- `createEntry:235`, `updateEntry:269-272`, `createSharedFromPromotion:647`: replace the inline `embedText(...)` storage call with `await embedForStorage(subject, body)` → write **both** `embedding` (jsonb, fallback/oracle) and the new `embedding_vec` + `embedding_version`. Best-effort: a failed embed writes the hash vector + `'hash-64:64'`, never throws (capture hooks must not fail — consistent with HOOK 1's "must not fail the answer response", core-plan §4.1).
- `updateEntry` re-embeds **only when `content_hash` changes** (today it re-embeds on **any** subject/body field touch at `:269-272` — confirmed). The content-hash cache (`server/src/services/memory-embed-cache.ts`, NEW) skips re-embedding unchanged bodies; capture hooks + the backfill batch texts in pages of ~100 (OpenAI batch limit) with exponential backoff on 429/5xx (mirror the summarizer retry).
- `rankEntries:155`: **remove `embedText(query)`**; `queryRanked:365` computes `embedQuery(query)` first and passes `queryEmbedding` into `rankEntries` (per §0.3). The pure ranker stays sync.
- `cosineSimilarity:73` gains an **`embedding_version` equality guard**: only score `entry.embedding_vec` against `queryVec` when versions match; otherwise fall back to hashing **both** sides. This closes the silent `min(len)` truncation hazard (a 64-dim hash vector dotted against a 1536-dim API vector returns a valid-but-meaningless score with **no error** today — verified at `:73`). **Never cross-score two embedding spaces.**
- `loadCandidates:322`: today it is an **unordered `.limit(500)`** (verified at `:337`, no `ORDER BY`). When `vectorSearchEnabled`, replace with `embedding_vec <=> $q ORDER BY … LIMIT k` (pgvector pushdown) — this also fixes the nondeterministic-window defect (core-plan §7 item 4).

### 1.8 Re-embed backfill + retrieval-quality harness

- `server/scripts/memory-reembed.ts` **(NEW)** + root `package.json` script `db:memory-reembed` (mirror `db:backup` at `package.json:18`): `SELECT … WHERE embedding_version != current OR embedding_vec IS NULL`, redact-before-embed, batch with backoff, `UPDATE embedding_vec + embedding_version + content_hash`. Idempotent, resumable, per-company. Run **after** `0052` and **before** building HNSW; also the migration tool when the team rotates the model. **Trigger policy:** explicit operator action (status-surfaced in §3.7), **never** auto-run on boot — cost/rate-limit safety.
- `server/src/services/__tests__/retrieval-quality.test.ts` **(NEW)** + `fixtures/retrieval-eval.json` **(NEW)**: labeled set `[{ query, expectedEntryIds[], seedEntries[] }]` grounded in real ADE domains (kafka topic conventions, budget pause policy, auth middleware — same vocabulary as `memory-ranker.test.ts`). Seeds via `memoryService` into the `_test-db.ts` rig, runs `queryRanked`, computes **recall@1/@5/@10, MRR, right-context-retrieved-rate**. Runs against the **deterministic hash-64 oracle in CI** (`pnpm test:run`, no network) → a hard merge gate.
- **The input-quality → output-quality measurement (decision #1):** a SECOND opt-in tier (`COMBYNE_EVAL_LIVE_EMBEDDINGS=true`, **skipped in CI**) runs the same fixtures through the managed embedder and asserts **real-embedding recall@k > hash recall@k by a threshold** — the explicit lift measurement.
- `server/src/services/__tests__/embedding-version.test.ts` **(NEW)** + amend `memory-ranker.test.ts:5-19`: assert (a) `embedText` still deterministic + L2-normalized (oracle preserved); (b) `cosineSimilarity` falls back to hash on version mismatch (no silent min-len score); (c) unset key → `vectorSearchEnabled` coerced false, `createEntry` writes hash-64 + `'hash-64:64'` and never throws; **(d) a body containing a fake `sk-` key is redacted before the (mocked) driver receives it AND the entry is marked `needs_review` — asserted on BOTH the storage path (`createEntry`) AND the query path (`embedQuery`)** (the review's explicit gap: today's design only tested the storage path).

### 1.9 Observability (`GET /memory/embedding-status`)

New route on `server/src/routes/memory.ts` + UI surface (§3.7). Per-company: `embedding_version` coverage (% on current model vs stale/hash), cumulative input-token count + estimated cost, last re-embed timestamp, **hash-fallback rate** (writes that fell back because the embedder was down/slow), re-embed backlog size, and **redaction-blocked (`needs_review`) count**. A degraded embedder must be visible **before** recall silently drops.

---

## 2. The ask-don't-hallucinate sufficiency gate (HARD, not advisory)

### 2.1 The problem the gate closes

The trust spine (core-plan §3.2) stops agent-fabricated content from being **retrieved** as fact. It is **silent on the complementary failure**: when retrieval returns nothing trustworthy, today the agent **proceeds anyway and fabricates**. The self-retrieval at `heartbeat.ts:3913` injects whatever `queryRanked` returns and renders it verbatim at `:3934-3947` with no notion of *"was this enough to act on."* `queryRanked` already filters to `lexical>0 || semantic>0.05` and returns `{items, layerCounts}` (verified at `memory.ts:387-389/415`), so an empty/low-score/all-unverified result is **already observable in code** — we just don't act on it. With hash-64's near-zero synonym recall, "no hit" is common, and a confident-but-wrong guess is the expensive outcome (rework, rejected PRs).

### 2.2 THE HARD-GATE FIX (the review's most important finding)

The review correctly flagged that an advisory gate **fails**: setting `context.combyneSufficiencyGate` + a one-line preamble directive ("ask one clarifying question rather than guessing") only materializes a question if (a) the run reaches finalize with `outcome === 'succeeded'` **AND** (b) the agent **chooses** to emit question text that `extractAndPostQuestions` then scrapes via `extractQuestionsFromText(sourceText)`. **Verified:** `extractAndPostQuestions` fires only inside `if (runIssueId && outcome === "succeeded")` at `heartbeat.ts:5382` and extracts from the agent's OWN `sourceText`. **Nothing forces the agent to ask.** An agent that ignores the preamble, fabricates, and finalizes `succeeded` fires **zero** questions. That is exactly the advisory failure to avoid.

**This doc makes the gate HARD via two deterministic, code-level mechanisms that do NOT depend on agent compliance:**

**(H1) Withhold the sub-threshold context — don't just annotate it.** The review's second gap: the advisory design evaluates *after* `combyneLongTermMemoryPreamble` is already built (`heartbeat.ts:3934-3947`), so the low-confidence context is still in the prompt the agent sees, and the agent can act on it anyway. **Fix:** on an `insufficient` verdict, the heartbeat **does not set `context.combyneLongTermMemoryPreamble` from the sub-threshold entries at all** (or sets it to a non-authoritative, explicitly-fenced "low-confidence, not vetted" block that carries no facts). The agent cannot act on context it never receives. `thin` (borderline) still injects but adds an `UNVERIFIED/THIN` render label only.

**(H2) Post the gate-authored question directly, independent of agent output.** On an `insufficient` verdict, the heartbeat calls the **existing** `routeAgentQuestionsToManager` (`agent-question-routing.ts:205`) with the gate's `suggestedQuestion` **directly** — manager-first, `fallbackToUser → awaiting_user` for the human — and **transitions the issue to a blocked/awaiting state**, a deterministic status transition, **not** a prompt. This reuses the exact machinery that already posts questions, blocks the issue, wakes the manager, and falls back to the user (`agent-question-extract.ts:283-373`, `agent-question-routing.ts:205-349`). The gate is the missing **decision point** that wires `evaluateSufficiency → routeAgentQuestionsToManager` without routing through the agent's discretionary output.

> Net: insufficient context → the agent **doesn't get** the bad context (H1) **and** a question **is** posted regardless of what the agent does (H2). Compliance-independent on both sides. This is the hard gate.

### 2.3 The pure verdict function

`server/src/services/memory-sufficiency.ts` **(NEW)** — `evaluateSufficiency(input)` → `{ verdict: 'sufficient'|'insufficient'|'thin', reasons[], topScore, verifiedCovered, entityCoverage, requirementCoverage, missingEntities[] }`. Pure/DB-free so it unit-tests without a DB, mirroring `rankEntries` (`memory.ts:147`).

Inputs: the `queryRanked` result (`items` with `score`, `layerCounts` from `memory.ts:415`), the per-item planned trust fields (`verificationState`/`provenance`/`confidence` from `0049`), the ticket's `serviceScope` (from `0051`) + extracted requirement tokens, and `complexity`.

Verdict = `insufficient` when **ALL** of:
1. `topScore < SUFFICIENCY_MIN_SCORE` (default `0.22`), **OR** no item has `verificationState === 'verified'` AND `provenance IN ('human-answer','pr-approval','verified-summary')`;
2. no verified entry's `serviceScope`/subject covers the ticket's key entities (`entityCoverage === 0`);
3. `requirementCoverage < REQ_COVER_MIN` (default `0.34`).

`thin` = borderline (one of the three) → label-only, do not ask.

> **Threshold-is-embedder-scoped (cross-design fix):** `0.22`/`0.34` are derived from the **current hash-64** score distribution. When real embeddings land (§1), cosine over 1536-dim shifts the distribution and **invalidates** these constants. The thresholds are therefore **keyed by `embedding_version`** — `memory-sufficiency.ts` reads a `{ minScore, reqCover }` map indexed by the active `embedding_version`, and the §1.9 status surface flags when a threshold set is missing for the current version (re-calibrate before flipping the gate to ask-mode on a new embedder). `embedding_version` (the §1 mechanism) is exactly what drives this re-calibration.

### 2.4 Both channels, never one (consumes the §0.3 canonical signature)

The gate evaluates at **both** governed retrieval sites (the same dual-channel rule as the trust gate, core-plan §3.2):
- **Self-retrieval** — `heartbeat.ts` after the block at `:3905-3947`, using the `ranked` result + the issue row already fetched at `:3896` + resolved `complexity`. Applies H1+H2.
- **EM passdown** — `server/src/services/em-passdown.ts` `buildPassdownPacket` (core-plan §5.1): after assembling the verified packet, run `evaluateSufficiency` against the **child** ticket's title/description/serviceScope. If `insufficient`, set packet flag `requiresClarification: true` + `missingEntities` (stored in the existing `agent_handoffs.artifactRefs` jsonb — zero migration) so the EM is instructed to resolve the gap (ask the human, or pin `curatedMemoryEntryIds`) **before delegating**. The gate fires at passdown time, not only at sub-agent self-retrieval — otherwise the EM delegates a context-starved ticket and the sub-agent fabricates downstream.

A call-site lint ensures a future third retrieval path can't skip the gate (shared with the §0.3 `queryRanked` gate).

### 2.5 Close the loop (the input→output quality path)

The whole value is: **the same gap retrieves a hit next time.**
- On gate-fire, the human answers via the existing `POST /issues/:id/answer-question` (`routes/issues.ts:1045-1112`) or the internal-manager path (`answerInternalManagerQuestion`, `agent-question-routing.ts:405-422`).
- **HOOK 1** (core-plan §4.1) captures that answer as a `verified` `human-answer` entry, stamped with the `subjectKey` of the **original question** (load the question comment by `questionCommentId` — the "required added work" of core-plan §4.1). Best-effort try/catch; must not fail the answer response.
- The next `evaluateSufficiency` over the same gap now retrieves this verified entry and returns `sufficient` — loop closed.

> **Assumption laundering — the hard rule (verified at `agent-question-routing.ts:50/405`):** when `input.assumption === true`, the HOOK-1 write MUST be `verificationState='unverified'` / `provenance='agent-claim'`. **Gate on the CODE flag `input.assumption`, NEVER by parsing the `"Assumption:"` body prefix** (the body prefix at `:405` is `input.assumption ? "Assumption: ${answer}" : answer`, but trust must key off the flag, not the string). If an assumption-flagged answer were captured as `verified`, the loop would launder a guess into authority and the gate would report `sufficient` forever. This is the genuinely-unknown vs assumption split the gate requires.

### 2.6 Interaction with the conflict model (decision #5)

If two `human-answer` entries disagree on the same `subjectKey`, decision #5 says **show the conflict, default-surface the newest-by-that-user, let the user OVERRIDE/MERGE/EDIT** (NOT needs_review-exclude). For the gate: a `subjectKey` with an **unresolved conflict** counts as **covered** for sufficiency purposes (the newest-by-that-user is default-surfaced, so the agent is not starved), but the §3.5 Conflicts tab raises it for human resolution. The gate does **not** re-ask a `subjectKey` that already has any answer (resolved or in-conflict) — see §2.7 cooldown.

### 2.7 Guardrails (don't make agents chatty)

`server/src/services/sufficiency-budget.ts` **(NEW)** + config:
- **Per-issue ask budget** — default max 2 gate-driven questions/issue.
- **Per-`subjectKey` cooldown** — never re-ask a `subjectKey` that has an answered comment OR an `assumption` answer. Reuses the existing duplicate-question guard (`existingKeys` at `agent-question-routing.ts:272-276` / `agent-question-extract.ts:274-276`, verified normalization `body.toLowerCase().replace(/\s+/g,' ').trim()` at `:270`) so the gate cannot flood the timeline.
- **Ask only when decision-critical** — `verdict === 'insufficient'` AND `entityCoverage === 0`. So small tasks aren't made chatty. The gate **evaluates even for `focused_small`** (memory is suppressed there today at `heartbeat.ts:3831`) because a small ticket with zero vetted context is exactly the over-confidence risk — but the ask is rate-limited to decision-critical gaps only (mirrors core-plan §5.3 "inject even for focused_small with a hard cap").
- Global `COMBYNE_SUFFICIENCY_GATE_ENABLED` (default **off** → label-only first) + tunable `SUFFICIENCY_MIN_SCORE` / `REQ_COVER_MIN` (embedder-version-scoped per §2.3).
- **Ask-rate alarm:** the §2.9 telemetry alerts if the fraction of retrievals that triggered a question exceeds a ceiling (e.g. >15% sustained) so the gate isn't over-asking.

### 2.8 Sequencing — the gate is a NO-OP until `0049` + HOOK 1 ship

The review flagged: `evaluateSufficiency`'s verdict logic ("no item has `verificationState==='verified'`…") is **uncomputable until `0049` lands and HOOK 1 populates it.** Until then every entry is unlabeled, `verifiedCovered` is always false, and the gate would fire `insufficient` on essentially every retrieval (chatty regression). **Therefore:**
- `COMBYNE_SUFFICIENCY_GATE_ENABLED` stays **off** until `0049` + `0051` + HOOK 1 are live and a verification path exists.
- Even when enabled, roll out **label-only first** (emit telemetry, do not ask) to calibrate thresholds against real telemetry on the real corpus before flipping to ask-mode.
- This places the gate firmly **after** core-plan Phase 1 (trust spine + write-paths) — see §4 roadmap.

### 2.9 Telemetry + metrics (the input→output dashboard)

Emit a `sufficiency_verdict` event per retrieval (`verdict, topScore, verifiedCovered, asked`) alongside the existing `memory_usage` insert at `recordUsage` (`memory.ts:446-468`). Metrics:
- **Repeat-question rate per `subjectKey`** — distinct issues asking the SAME `subjectKey` (from `memory_usage.issueId`, `memory_layers.ts:114`, + the question-comment key). Falling rate = the loop is closing.
- **PR-approval rate (HOOK 2 signal)** — approved-without-rework PRs for ask-cohort vs proceeded-without-asking.
- **Rework/reject count** — `awaiting_user` re-bounces + rejected PRs, sliced by gate verdict. The core quality KPI.
- **Ask-rate guardrail** — fraction of retrievals that asked (alarm ceiling per §2.7).

### 2.10 Residual (honest)

A human-verified answer can be wrong; the gate then confidently reports `sufficient` and suppresses re-asking. This is the core-plan §13 residual — the gate **reduces fabrication, it does not guarantee correctness.** Pair with the §9 re-verification loop (demote drifted verified rows to `needs_review`).

---

## 3. The full memory-layer UI/UX (all flows; conflict merge first-class)

### 3.0 Philosophy — composition over invention (verified patterns only)

Keep the flat `/memory` route (`App.tsx:154`) and convert the single-scroll `CompanyMemory.tsx` into a **tabbed shell** using the exact `Tabs` + `PageTabBar` pattern from `Approvals.tsx:88-100` (verified: yellow pill `bg-yellow-500/20 text-yellow-500`, path-driven `navigate('/approvals/${v}')`). Eight flows → eight path-driven tabs under `/memory/:tab`, matching the existing `agents/:tab` / `approvals/pending|all` / `skills/:skillId` conventions (`App.tsx:125/141-144`).

**Reuse only existing primitives + composites** (verified present): `ui/src/components/ui/{badge,card,input,textarea,select,button,dialog,tabs,checkbox,skeleton}.tsx`; `ui/src/components/{EmptyState,StatusBadge,FilterBar,PageTabBar,PageSkeleton,CommentThread,MarkdownBody,Identity,CopyText,ApprovalCard}.tsx`. **No new design language.** Per the design-guide rule (`SKILL.md:293`: *"when you add a new reusable component, you MUST add it to the design guide page"*), every new reusable component is registered in `DesignGuide.tsx`.

### 3.1 The eight tabs

| Tab | Route | Purpose | Generalizes |
|---|---|---|---|
| **Browse** (default) | `/memory/browse` | Search / filter / CRUD | current `CompanyMemory.tsx` |
| **Capture** | `/memory/capture` | Review newly-captured human-answer / pr-approval entries | the "Accepted Work Events" section already in `CompanyMemory.tsx` |
| **Verify** | `/memory/verify` | Board-verify queue (hybrid SLA) + promotion proposals | `decidePromotion` flow (`routes/memory.ts:321`) |
| **Conflicts** | `/memory/conflicts` | **First-class** merge/override (decision #5) | `ApprovalDetail` side-by-side layout |
| **Redaction** | `/memory/redaction` | `needs_review` secret quarantine | the same inbox shell + reveal toggle |
| **Questions** | `/memory/questions` | Sufficiency-gate questions → answered → captured entry (the loop, visible) | new |
| **Passdown** | `/memory/passdown` | Read-only audit of EM passdown packets (curation lives in the delegate dialog) | new |
| **Setup** | `/memory/setup` | Embedding key + provider/model + privacy ack + cost governance + re-embed/eval | `InstanceGeneralSettings.tsx` form template |

One new **sidebar pending badge** on the existing Memory nav item (Brain icon at `Sidebar.tsx:113`, sourced from `sidebarBadges` at `:37-39`) summing `capture + verify + conflicts + redaction` depths — matching the approvals pending-badge pattern.

### 3.2 Browse (`ui/src/pages/memory/MemoryBrowse.tsx`, NEW)

Keeps the current search `Input` + entries list, adds a filter row (`FilterBar` + `Select`) for layer / kind / provenance / verificationState / confidence-bucket / serviceScope / age. Renders each entry via `MemoryEntryCard` (§3.8). "New entry" opens `MemoryEntryEditDialog` (workspace/personal only — **shared stays promotion-gated** per the refine at **`packages/shared/src/validators/memory.ts:31-37`**, NOT `server/src/validators/memory.ts` which does not exist — the review's codeGroundingError #1, corrected here). Empty state uses `EmptyState icon={Brain}`.

### 3.3 Capture review (`MemoryCaptureReview.tsx`, NEW)

Lists newly-captured `provenance IN ('human-answer','pr-approval')` entries (queue shape from `Approvals.tsx`). Each row = `MemoryCaptureCard` with source citation (issue#/PR#), the Q/A or decisionNote body, and Confirm / Edit / Discard. Promotes the existing read-only "Accepted Work Events" section in `CompanyMemory.tsx` to a first-class actionable inbox.

### 3.4 Verify queue (`MemoryVerifyQueue.tsx`, NEW) — hybrid SLA (decision #3)

Two sub-sections, same card: (a) board-verify **agent-claims that hit N distinct-issue reuse** (`verificationState='unverified'`, high distinct-issue count — the §3 hybrid signal), (b) existing promotion proposals from `listPromotions`. Reuses the `ApprovalCard` decision pattern wired to the new `POST /memory/entries/:id/verify` (assertBoard, mirroring `routes/memory.ts:321-350`) and existing `decidePromotion`. Shows distinct-issue reuse-evidence + a green "Verify" primary button.

### 3.5 Conflicts (`MemoryConflicts.tsx` + `MemoryConflictResolver.tsx`, NEW) — THE FIRST-CLASS ASK (decision #5)

Groups entries by `subjectKey` HAVING conflicting human-answers. Each conflict opens `MemoryConflictResolver`: **side-by-side bordered cards** (the `ApprovalDetail` two-column precedent) showing both bodies, `authorId`, `updatedAt`, with the **newest-by-that-user pre-selected/highlighted** (decision #5's default-surface). Three actions, mapped to `supersededById`:
- **OVERRIDE** — pick one canonical, supersede the other (`supersededById`).
- **MERGE** — a third editable `Textarea` seeded from both bodies → writes a **brand-new canonical entry**, supersedes **both** originals (preserving both for audit; consistent with core-plan §3.6 keep-losers-via-`supersededById`).
- **EDIT** — free-edit the canonical.
Diff-highlight differing lines.

> **Honest labeling (verified caveat):** `subjectKey` normalization is conservative (lowercase/whitespace/punctuation-strip only, the same weak key as the question dedupe at `agent-question-routing.ts:270`). Paraphrased/cross-lingual conflicts won't group, so the tab **under-reports**. Label it **"Detected conflicts"** (not "all conflicts") and keep manual Browse-edit as the fallback. Revisit semantic near-dup only after real embeddings land (§1).

### 3.6 Redaction queue (`MemoryRedactionQueue.tsx`, NEW) — the blocking §1.4 / core-§4.4 gate

Lists `verificationState='needs_review'` + `sensitive`-flagged entries (held out of retrieval). Each = `MemoryRedactionCard`: body rendered **MASKED by default** (CopyText/reveal pattern), matched secret span(s) highlighted, actions Reveal / Redact-span / Approve-as-clean / Reject. Approve clears `needs_review → verified`; Redact rewrites the body with the span replaced then re-queues.

> **Reveal is a second egress surface — concrete control (the review's privacy gap, closed):** Reveal is **never default**; it is an explicit board-principal click against an **audited** endpoint (`POST /memory/entries/:id/redaction/reveal`, `assertBoard`) that returns cleartext **only to that principal**, **never persisted client-side, never written to logs/telemetry** (the reveal action itself is audit-logged, not the revealed body). Masked-by-default is asserted in a regression test (§3.10): no secret span is in the DOM before Reveal.

### 3.7 Setup (`MemorySetup.tsx`, NEW) — decision #1 + the privacy reconciliation

A `Card` form (`InstanceGeneralSettings.tsx` template) to paste the **team-shared embedding API key** (masked password input + CopyText pattern), choose provider/model (`Select`: `text-embedding-3-small`/`-large`), shows resolved `embedding_version`/dim. Plus:
- A **prominent privacy-disclosure panel** carrying the §1.0/§1.5 reconciliation verbatim ("memory bodies are sent to `<provider>`; a redact-before-embed step runs first; this is the one external dependency by explicit choice; redaction bounds credential leakage, NOT body confidentiality") with an **explicit acknowledge checkbox required before save** (save blocked until acked — asserted in §3.10).
- Cost/rate governance fields: monthly cap (USD), RPM.
- The §1.9 status surface: `embedding_version` coverage %, stale/hash-fallback count, cumulative token spend vs cap, redaction-blocked count, last re-embed timestamp.
- A "**Run re-embed**" action (explicit operator trigger, §1.8) and a "**Run retrieval eval**" action that reports recall@k of known-correct entries for a fixed query set (the §1.8 harness, surfaced — measures input-quality→output-quality as required).

> **Key storage (the review's security gap, closed):** the key is stored via the existing secrets path, **never a plaintext setting**; the masked input **never echoes the saved key back**. First-run detection: if no key is configured, Browse renders a banner linking to Setup. Per decision #1 the key is configured **once at install** (instance/company-setup time).

### 3.8 New reusable components (registered in `DesignGuide.tsx` per `SKILL.md:293`)

- `ui/src/components/memory/MemoryEntryCard.tsx` — extracts + extends the existing inline-edit card (`CompanyMemory.tsx:199-326`, verified). Non-editing branch adds, after the layer/kind badges: `ProvenanceBadge`, `VerificationBadge`, `ConfidenceMeter`, `MemoryCitationLine`. Keeps inline-edit. Shows `supersededBy` strike state.
- `ui/src/components/memory/MemoryTrustBadges.tsx` — `ProvenanceBadge` (human-answer/pr-approval=green, verified-summary=blue, agent-claim=neutral, system=gray), `VerificationBadge` (verified=green, **unverified=amber**, needs_review=red — reuse `StatusBadge` color map), `ConfidenceMeter` (thin progress bar per design-guide Progress Bar at `SKILL.md:216`: red<0.4, yellow<0.7, green), `MemoryCitationLine` (`text-xs font-mono text-muted-foreground` per `SKILL.md:97`, format `[mem:<id> · <provenance> · conf=<n> · ref=<type>:<id>]`, core-plan §3.7).
- `ui/src/components/memory/MemoryPassdownPicker.tsx` — `Checkbox`-list of verified entries matching the child issue's title/serviceScope, lets the EM pin `curatedMemoryEntryIds`, **embedded in the existing issue-delegate dialog** (where complexity/serviceScope already resolve per core-plan §5.1). Plus the read-only `/memory/passdown` audit list (from `agent_handoffs.artifactRefs`).
- `ui/src/components/memory/MemoryEntryEditDialog.tsx` — `Dialog` wrapper around the existing draft form fields (`CompanyMemory.tsx:206-292`), used by Browse/Capture/Conflict-merge; enforces the shared validator (no direct shared-layer create).

### 3.9 API + routes + types + wiring

- `ui/src/api/memory.ts` (verified thin style at `:4-13`, today only `{layer?:'workspace'|'shared'; status?}`): extend `memoryApi` with `listEntries(+provenance/verificationState/minConfidence/serviceScope/age)`, `listCaptureInbox`, `confirmCapture`, `listVerifyQueue`, `verifyEntry`, `listConflicts`, `resolveConflict({action:'override'|'merge'|'edit', canonicalEntryId?, body?})`, `listRedactionQueue`, `resolveRedaction`, `revealRedaction`, `listQuestions`, `getEmbeddingConfig`, `updateEmbeddingConfig`, `listPassdownPackets`. Mirror the existing `api.get/post/patch` style.
- `server/src/routes/memory.ts`: add `POST /memory/entries/:id/verify` (assertBoard), `POST /companies/:companyId/memory/conflicts/:subjectKey/resolve` (assertBoard), `POST /memory/entries/:id/redaction/resolve` + `/reveal` (assertBoard, audited), and GET `…/capture-inbox`, `…/verify-queue`, `…/conflicts`, `…/redaction-queue`, `…/questions`, `…/embedding-config`, `…/embedding-status`, `…/passdown-packets`. Extend `GET …/memory/entries` (today only `layer/status` at `:70-73`) to accept `provenance`, `verificationState`, `minConfidence`, `serviceScope`, `ageDays`.
- `packages/shared/src/types/memory.ts`: extend `MemoryEntry` with the `0049` trust-spine fields the UI renders (`provenance`, `verificationState`, `confidence`, `authorType`, `authorId`, `sourceRefType`, `sourceRefId`, `subjectKey`, `supersededById`, `verifiedBy`, `verifiedAt`, `embeddingVersion`). New types: `MemoryConflictGroup`, `MemoryEmbeddingConfig`, `MemoryQuestionItem`, `MemoryPassdownPacket`.
- `ui/src/lib/queryKeys.ts`: extend `queryKeys.memory` with `captureInbox`, `verifyQueue`, `conflicts`, `redactionQueue`, `questions`, `embeddingConfig`, `embeddingStatus`, `passdownPackets` (companyId-keyed).
- `ui/src/App.tsx`: add `memory/:tab` child routes alongside `:154`, all rendering `CompanyMemory` (tab read from path).
- `ui/src/components/Sidebar.tsx`: pending-count badge on the Memory item (`:113`).
- `ui/src/pages/DesignGuide.tsx`: add a "Memory" section showcasing the trust badges + `MemoryEntryCard` + `MemoryConflictResolver` in all states (verified/unverified/needs_review/superseded).

### 3.10 Tests

Component (vitest/RTL): `MemoryEntryCard` renders all trust badges + citation per provenance; unverified shows the amber chip (the label-then-exclude Release-N contract). `MemoryConflictResolver`: newest-by-that-user pre-highlighted; OVERRIDE/MERGE/EDIT fire `resolveConflict` with the right payload; MERGE seeds from both bodies. Redaction: body MASKED by default, **no secret span in the DOM before Reveal** (the §3.6 leak regression guard), Approve clears `needs_review`. Setup: save **blocked** until disclosure acked; masked key never echoed. Route (server): `POST …/verify` rejects non-board; verify stamps `verifiedBy/verifiedAt`; non-board cannot resolve conflicts/redaction or reveal. Filter: `GET entries?provenance=agent-claim&verificationState=unverified` returns only matching rows. E2E (browse skill): all 8 tabs navigate; pending pill matches queue depth.

### 3.11 Staleness UX note (the prompt-cache window)

A fact the user just edited/superseded/redacted can still be served from a cached agent prefix until the cache TTL (core-plan §5.3, `composer.ts:158-167`). Surface a "change may take up to `<cache TTL>` to reach running agents" note on edit/redact/supersede/conflict-resolve so users don't think a correction is instant.

### 3.12 Phasing (matches core-plan label-then-exclude)

Every screen except Browse renders `0049` columns + routes that don't exist until the hooks land. Gate the 4 queue tabs behind empty-states / a feature flag; **ship Browse-with-badges first (label-only, Release N)**, light up queues as hooks land. Must-haves under time pressure: Browse(+badges), Capture, Verify, **Conflicts** (the explicit user ask). Redaction/Questions/Passdown/Setup are fast-follows — except **Setup + Redaction must ship WITH the embedding swap** (Setup configures the key; Redaction is the blocking gate for what the embedder egresses).

---

## 4. How this plugs into the phased roadmap

Aligned to `CENTRAL_CONTEXT_DB_PLAN.md §11`. This companion adds **no new phases**; it slots into the existing ones.

### Phase 0 — Use TODAY (unchanged)
No code changes. Hash-64 embedder, no gate, single-scroll memory UI. This doc is dormant.

### Phase 1 — Trust spine + write-paths (the shared prerequisite for everything here)
- Core plan lands `0048` → `0049` → `0051` + HOOK 1 + HOOK 2 + the write-side force-unverified gate + render label-only.
- **This doc, Phase 1 additions:**
  - **UI:** convert `CompanyMemory.tsx` to the tabbed shell; ship **Browse-with-trust-badges** + the `MemoryTrustBadges`/`MemoryEntryCard` components + DesignGuide section (label-only Release N). Capture/Verify/Conflicts tabs ship as the hooks populate `0049`.
  - **Sufficiency gate:** land `memory-sufficiency.ts` + `sufficiency-budget.ts` + tests **as a no-op** (`COMBYNE_SUFFICIENCY_GATE_ENABLED=off`), emitting `sufficiency_verdict` telemetry only (§2.8). Wire H1/H2 code paths but keep them dark until calibration.
  - Adopt the **§0.3 canonical `queryRanked` signature** here so the embedding swap and passdown don't collide later.

### Phase 2 — Self-hosted central DB cutover (Option A) + embedding swap
- Core plan does the DB cutover and flips `requireVerified` (Release N+1).
- **This doc, Phase 2 additions (the embedding workstream):**
  - Land `0052` (pgvector columns, nullable, no HNSW yet) + `embedding-driver.ts` + `memory-embedder.ts` + `secret-scan.ts` + `memory-embed-cache.ts` + the `cosineSimilarity` version guard + the `rankEntries` query-embedding lift.
  - Ship `db:memory-reembed`; backfill; **then** build HNSW CONCURRENTLY after dim=1536 recall-validation.
  - Ship `doc/PRIVACY_DISCLOSURE.md` + the **Setup** + **Redaction** tabs (Setup configures the one team key; Redaction quarantines what the embedder would egress).
  - Land `retrieval-quality.test.ts` (hash oracle, CI merge gate) + the live-embedding eval tier.
  - **Calibrate** `SUFFICIENCY_MIN_SCORE`/`REQ_COVER_MIN` per the new `embedding_version` (§2.3) before any ask-mode flip.

### Phase 3 — EM passdown + first teammates + gate to ask-mode
- Core plan lands `em-passdown.ts` + the dual-channel injection.
- **This doc, Phase 3 additions:**
  - Wire `evaluateSufficiency` into **both** channels (self-retrieval H1/H2 + passdown `requiresClarification`), §2.4.
  - Flip `COMBYNE_SUFFICIENCY_GATE_ENABLED` to ask-mode after the label-only telemetry pass confirms thresholds (ask-rate under ceiling).
  - Ship the **Questions** tab (the loop, visible) + the **Passdown** audit list + `MemoryPassdownPicker` in the delegate dialog.

### Phase 4 — Multi-team RLS + scale
- Core plan lands `0053` RLS + per-tenant JWT.
- **This doc, Phase 4 additions:** ensure the new GET routes + the `memory_usage`-backed metrics run under the `BYPASSRLS` scheduler role where they cross companies; ensure `embedding-status`/re-embed honor per-company RLS; the gate's `subjectKey` cooldown and the conflict resolver operate per-tenant.

---

## 5. Resolved code-grounding errors & cross-design conflicts (audit trail)

| Item | Resolution in this doc |
|---|---|
| **Validator mislocated** (`server/src/validators/memory.ts` does not exist) | Corrected throughout to **`packages/shared/src/validators/memory.ts`** (shared-layer refine at `:31-37`, personal-owner refine at `:24-30`). §3.2. |
| **Advisory gate fails** (extractAndPostQuestions only on `succeeded`, scrapes agent output) | Made HARD: (H1) withhold sub-threshold context; (H2) post `suggestedQuestion` directly via `routeAgentQuestionsToManager` + deterministic status transition. §2.2. |
| **Gate annotates context already injected** | H1 suppresses `combyneLongTermMemoryPreamble` on `insufficient`. §2.2. |
| **Gate uncomputable pre-`0049`** | Explicitly sequenced as a no-op behind `0049` + HOOK 1; label-only first. §2.8. |
| **Query-side redaction under-emphasized** | `embedQuery` runs `scanBody` on the query; tested on **both** paths. §1.4.2, §1.8(d). |
| **Three designs collide on `queryRanked`** | One canonical signature defined once. §0.3. |
| **Thresholds invalidated by embedder swap** | Thresholds keyed by `embedding_version`; §1 drives re-calibration. §2.3. |
| **`0049`/`0051` assumed by all, owned by none** | Shared-prerequisite rule; owned by core-plan Phase 1. §0.2. |
| **Locked "no third-party data" reversal** | Recorded loudly in 3 places (disclosure, Setup ack, §9 decisions); supersedes prior docs on this one axis; does not overclaim redaction = privacy. §1.0, §1.5. |
| **Redaction reveal = second egress** | Concrete control: audited board-only endpoint, cleartext never persisted/logged. §3.6. |
| **Setup key in plaintext** | Stored via secrets path; never echoed. §3.7. |
| **Conflicts under-report** | Labeled "Detected conflicts"; manual fallback. §3.5. |
| **`cosineSimilarity` silent min-len truncation** (`memory.ts:73`) | `embedding_version` equality guard; never cross-score spaces. §1.7. |
| **`embedText` async would break the pure ranker** (`memory.ts:155`) | Query-embedding lifted out; storage async with hash fallback. §1.1, §1.7. |
| **`embedded-postgres` may lack pgvector** | hash-64 jsonb oracle is permanent; CI never requires pgvector. §1.6. |
