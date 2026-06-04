# Embedding Retrieval Quality — Eval, Strategy Critique, Safe Enable

Status: PR-12 (embedding-quality). Branch `central-db`.

This report documents (1) the live retrieval-quality eval method + the real
measured numbers, (2) the strategy critique across three axes
(retrieval-strategy, correctness-transition, ops-cost), (3) the **safe enable
order** for `vectorSearchEnabled`, and (4) the deferred high-effort items.

The embedding stack itself is described in code: `embedding-driver.ts` (the
managed-API HTTP driver), `memory-embedder.ts` (the redact-before-embed
chokepoint + hash-64 fallback), `memory.ts` (`embedText`, `cosineSimilarity`
version-guard, `rankEntries`, `loadCandidates`), `memory-reembed.ts` (the
backfill), and migration `0052_pgvector_embeddings.sql`.

---

## 1. The eval method

A labeled fixture (`server/src/services/embedding-eval-fixture.ts`) of **14
ADE/Combyne-domain knowledge entries** + **14 deliberately PARAPHRASED queries**.
The queries are written to share little/no surface vocabulary with their target
entry (e.g. *"an employee blew through its spending allowance — what stops it?"*
→ the *"Token salary budget pause policy"* entry). This isolates the **semantic**
axis — exactly the axis a bag-of-hashed-words vector cannot serve.

Two tiers consume the SAME fixture:

- **Hash-64 tier** — deterministic, network-free, in-process. This is the CI
  merge gate (`retrieval-quality.test.ts`): it embeds every entry + query with
  the hash-64 oracle (`embedText`), ranks by cosine, and asserts a regression
  band. Runs on every `pnpm test:run`.
- **Live tier** — opt-in (`scripts/embedding-eval.ts` behind
  `COMBYNE_EVAL_LIVE_EMBEDDINGS=1` + an OpenAI key). Embeds via the real managed
  API. Costs tokens + needs network, so it is NOT a merge gate.

Each tier: embed entries → embed queries → rank each entry set by cosine to the
query → record the rank of the first expected entry → compute recall@{1,3,5}
and MRR.

---

## 2. Real measured numbers

Measured against `openai:text-embedding-3-small:1536`, 14 entries + 14
paraphrased queries:

| tier                                | recall@1 | recall@3 | recall@5 | MRR   |
| ----------------------------------- | -------- | -------- | -------- | ----- |
| hash-64 oracle                      | 14.3%    | 50.0%    | 57.1%    | 0.375 |
| openai:text-embedding-3-small:1536  | 92.9%    | 92.9%    | 100%     | 0.943 |

**LIFT: MRR +0.568 (0.375 → 0.943), recall@1 +78.6 pts.** Cost: 737 tokens for
the whole fixture. Per-query: the hash oracle buried roughly half the queries at
rank 6–9; the live embedder put 13/14 at rank 1.

This **locks the managed-API embedder decision** (quality over a self-hosted
default; one team-shared key at setup; redact-before-embed).

> **Caveat — this 0.94 is a PURE-COSINE upper bound, not what the ranker
> delivers.** The eval ranks by raw cosine alone. Production `rankEntries`
> blends `score = 0.5·lexical + 0.35·semantic + 0.15·recency` (memory.ts:222-235)
> and `queryRanked` passes empty weights so those defaults apply. On the
> lexically-disjoint paraphrases the eval is built to win, `lexicalScore` ≈ 0, so
> a strong semantic hit is diluted to `0.35·sem` and can be outvoted by a ~1.0
> recency term on a fresh row. The embedder's recall is real; the *ranker's*
> realized recall on paraphrases is lower. The weights were tuned in the hash-64
> era (semantic = noise) and have **not** been re-tuned now that semantic is
> strong. (Deferred — see §5.)

---

## 3. Strategy critique (high/med findings across 3 axes)

### Retrieval-strategy
- **HIGH — train/serve weighting mismatch.** The 0.94 is pure cosine; production
  dilutes semantic to 35% and lets recency outvote it on paraphrases. The eval
  measures a path production never runs. *(Deferred: re-tune weights + re-run the
  eval through `rankEntries`.)*
- **HIGH — no ANN index.** Migration 0052 ships `embedding_vec` with **no** HNSW
  index. `loadCandidatesByVector` does `ORDER BY embedding_vec <=> $q LIMIT k`
  against an unindexed column → brute-force KNN (O(N) distance computations per
  query at 1536 dims). At 10k+ rows this is the same scan cost as the jsonb path;
  the only win is wire volume (k rows vs 500). The "ANN" label is aspirational
  until the index lands. *(Deferred.)*
- **HIGH — long bodies silently fall to the worst tier (FIXED this PR).** A body
  over ~8192 tokens made the provider 400; the embedder caught it and stored a
  hash-64 vector, and the version-guard then made that entry lexical-only
  forever — with no telemetry. Long RFCs/design docs are the highest-value
  long-form memory and the most likely to exceed the limit. **Fixed:** a
  head-truncation guard (`MAX_EMBED_CHARS`) caps the egressed text so the embed
  succeeds at the API version; a truncation counter surfaces it on the status
  route.
- **MED — storage/query text asymmetry.** Storage embeds `subject\nbody`; the
  heartbeat query embeds `identifier\ntitle\ndescription`. The issue identifier
  (e.g. `ENG-4821`) is a high-magnitude, semantically-empty token that pulls the
  query vector off-manifold. The eval's clean paraphrases never pay this penalty,
  so production retrieval is dirtier than 0.94 implies. *(Deferred: strip the
  identifier from the heartbeat query + align the eval's query format.)*
- **MED — normalization contract unenforced for live vectors.** `cosineSimilarity`
  returns a bare dot product assuming unit vectors. OpenAI happens to return
  unit-normalized vectors, so it holds by luck; a custom `EMBEDDING_PROVIDER`
  endpoint returning un-normalized vectors would silently corrupt ranking.
  *(Deferred: assert / normalize.)*
- **MED — non-pgvector path caps at 500 rows `ORDER BY updatedAt` — a recency
  cut, not a relevance cut.** On the common no-pgvector deployment a relevant but
  old fact is dropped before cosine scores it. *(Deferred.)*
- **MED — dimension 1536 baked into `vector(1536)` + the version string.**
  Dropping to Matryoshka-768 (a cost lever) is a column rebuild + full re-embed,
  not a config flip. The fixture already saturates at recall@5=100% on small@1536
  so 3072/large is NOT justified. *(Deferred.)*

### Correctness-transition
- **HIGH — dark-retrieval bug on pgvector enable (FIXED this PR).** The ANN
  pushdown filters `embedding_version = <current>`, so on a not-yet-reembedded
  corpus it returns `[]`. `[]` is **truthy**, and `if (annRows) return …` short-
  circuited and returned ZERO candidates for EVERY query during the pre-backfill
  window — a silent total blackout. **Fixed** to `if (annRows && annRows.length
  > 0)`, so an empty ANN result falls through to the jsonb/lexical window.
- **HIGH — same flag drives backfill AND live egress.** `embedder.enabled`
  (`COMBYNE_VECTOR_SEARCH_ENABLED` + a key) gates BOTH the backfill and the
  server's live query path. Flipping it on the server before backfill makes the
  query embed at the API version while every entry is still `hash-64:64`; the
  version-guard scores semantic=0 corpus-wide and recall silently collapses to
  lexical. *(Mitigated this PR via the documented safe enable order §4 + the
  status route §5; full robustness — a startup coverage guard — is deferred.)*
- **MED — mixed-version corpus during a slow backfill.** Reembedded rows score
  normally; stale rows score 0 (jsonb) or are excluded entirely (ANN). Quality is
  a function of which rows are done. The status route (§5) makes the backlog
  visible mid-run.
- **LOW — `embedding_model` held the composite, not the bare model (FIXED this
  PR).** It now stores the bare model (e.g. `text-embedding-3-small`), threaded
  from `EmbeddingResult.model`; the composite stays in `embedding_version`.

### Ops-cost
- **HIGH — `monthlyCapUsd` / `rpm` are dead config** (no consumers). A runaway
  backfill spends with no backpressure. *(Deferred: a real budget gate.)*
- **HIGH — no spend ledger.** The driver returns `inputTokens`; both callers
  discard it. *(Deferred.)*
- **HIGH — re-embed is not batched** — one HTTP round-trip per row instead of one
  batched call per page. *(Deferred.)*
- **MED — eval was not a CI gate (FIXED this PR).** The hash tier is now a merge
  gate (`retrieval-quality.test.ts`); the live tier stays opt-in.
- **MED — the import-lint never ran in CI and passed vacuously on untracked
  files (FIXED this PR).** It now enumerates tracked **and** untracked files, is
  wired into `pr-verify.yml`, and is locked in by a non-vacuous in-process gate
  (`embedding-driver-lint-gate.test.ts`).
- **LOW — content-hash cache is per-process/volatile (DOCUMENTED this PR).** The
  durable cross-process dedupe is the `content_hash` column + the version-skip in
  `reembedBackfill`, not this LRU.
- **LOW — HNSW build is prose only** (no runnable, guarded script). *(Deferred.)*

---

## 4. SAFE ENABLE ORDER for `vectorSearchEnabled`

> **Re-embed backfill MUST complete before the live query path is flipped on.**
> Otherwise the version-guard scores semantic=0 for every un-reembedded entry
> (jsonb) or the ANN path omits them (pgvector). Because `embedder.enabled`
> drives BOTH the backfill and the live egress off the same flag, the two must be
> sequenced by scoping the flag to the CLI env first, then the server.

1. **Apply migration 0052** (adds `embedding_model`, `embedding_dim`,
   `content_hash`, and — only where pgvector is available — `embedding_vec`).
   Builds **no** index.
2. **Run the backfill with the flag set in the CLI ENV ONLY**, while the **server
   keeps `COMBYNE_VECTOR_SEARCH_ENABLED=false`**:
   ```
   COMBYNE_VECTOR_SEARCH_ENABLED=true COMBYNE_EMBEDDING_API_KEY=sk-… \
     DATABASE_URL=… pnpm db:memory-reembed
   ```
   The backfill only needs `embedder.enabled`; the server's query path stays on
   the hash-64 jsonb route, so retrieval is unaffected during the backfill.
3. **Confirm coverage** via `GET /companies/:id/memory/embedding-status` for
   **every** company: `reembedBacklog: 0`, `versionCoveragePct: 1.0`,
   `hashFallbackPct: 0`.
4. **(pgvector only) Build the HNSW index** `CONCURRENTLY` once coverage is 100%
   (never a plain `CREATE INDEX` — that takes ACCESS EXCLUSIVE and freezes
   writes). Confirm `hnswIndexPresent: true` on the status route.
5. **ONLY NOW flip `COMBYNE_VECTOR_SEARCH_ENABLED=true` on the SERVER** and
   restart, so the live query path turns on against a fully migrated corpus.

The empty-ANN fall-through fix means a *mistimed* flip degrades to
lexical/recency instead of going fully dark — but it is still a recall
regression, so follow the order. The runbook is also embedded in the header of
`server/scripts/memory-reembed.ts`.

---

## 5. What shipped in PR-12 vs deferred

### Shipped (low/med-effort, high value)
- **CI merge gate for retrieval quality** — `retrieval-quality.test.ts` asserts
  the hash-64 tier within `[0.30, 0.45]` MRR and recall@5 ≥ 0.5; the live tier
  stays opt-in. Fixture extracted to `embedding-eval-fixture.ts` (single source
  of truth shared by gate + script).
- **Embedding-driver import-lint wired in + de-vacuumed** — now scans untracked
  files, runs in `pr-verify.yml`, and is locked by
  `embedding-driver-lint-gate.test.ts` (non-vacuous: asserts the real importer is
  seen AND a planted bypass fails).
- **`embedding_model` = bare model** — threaded `EmbeddingResult.model` through
  `writeVectorColumns` + the backfill UPDATE; composite stays in
  `embedding_version`.
- **`GET /companies/:id/memory/embedding-status`** — version coverage %,
  hash-fallback %, version breakdown, re-embed backlog, redaction-blocked count,
  HNSW index presence, pgvector presence, and process-local truncation /
  hash-fallback counters.
- **Long-body truncation guard** — head-truncate the egressed text to
  `MAX_EMBED_CHARS` so a long doc embeds at the API version instead of silently
  falling to the hash-64 worst tier; truncation is counted.
- **Empty-ANN dark-retrieval fix** — `if (annRows && annRows.length > 0)` so a
  pre-backfill pgvector corpus falls through to lexical instead of going dark.
- **Documented safe enable order** — in this doc + the reembed CLI header.
- **Documented cache scope** — per-process/volatile; durable dedupe is the
  `content_hash` column + the version-skip.

### Deferred (high-effort)
- **Re-tune ranker weights** toward semantic (e.g. 0.55/0.30/0.15) and re-run the
  eval **through** `rankEntries` (not raw cosine) so the reported MRR reflects the
  realized ranker.
- **Build the HNSW / IVFFlat index** as a guarded, runnable script
  (`CREATE INDEX CONCURRENTLY … USING hnsw`, refuses unless coverage is 100%,
  runs outside a transaction) and gate the ANN pushdown on the **index** existing.
- **Real cost enforcement** — a durable monthly spend ledger
  (`inputTokens × price`) + a budget circuit-breaker that returns the hash-64
  fallback when over `embeddingMonthlyCapUsd`, plus proactive RPM pacing in the
  backfill (honor `embeddingRpm`, don't permanently skip rows that hit a 429).
- **Batch the backfill provider call** (one batched `embed(texts)` per page; one
  multi-row UPDATE per page) and capture `inputTokens` into the ledger.
- **3072/large dim** — NOT justified (fixture saturates at small@1536); instead
  decouple the dim from `vector(1536)` + the version string so Matryoshka-768 can
  be A/B-tested without a destructive migration.
- **Strip the issue identifier** from the heartbeat self-retrieval query + align
  the eval's query format to measure the real train/serve text gap.
- **Enforce the normalization contract** for live vectors (assert / normalize)
  and make the eval use production `cosineSimilarity`.
- **Relevance-aware non-pgvector fallback** to replace the 500-row recency window.
- **Startup / per-query coverage guard** that warns when the corpus is 0% on the
  current version (full robustness beyond the documented order + status route).
- **Shared cross-process embed cache** if/when the server runs multiple replicas.

---

## Code-context & human-answer validation (the real workload)

Because the ADE workload is mostly **code and the things around it**, a second
live eval (`server/scripts/embedding-eval-code.ts`, 16 entries / 17 task queries)
covers conventions, code snippets, stack-trace/incident patterns, service
ownership, file-path pointers, **EM/CEO conventions**, and the **human Q→A answers**
captured by HOOK 1 — queried with realistic per-task questions.

| tier | recall@1 | recall@5 | MRR |
|---|---|---|---|
| hash-64 | 35.3% | 64.7% | 0.492 |
| openai text-embedding-3-small @1536 | **100%** | **100%** | **1.000** |

Subset breakouts (live):

- **Human-answer (Q→A) capture**: hash MRR 0.750 → **1.000** (recall@1 50% → 100%) — user answers embed and retrieve correctly.
- **EM/CEO per-task queries**: hash MRR 0.569 → **1.000** (recall@1 50% → 100%) — the EM's ownership/rate-limit conventions and the CEO's quarterly directive all retrieve at #1.
- The multi-fact task *"I'm building a refund endpoint — what do I need to know?"* moved from hash rank **9 → live rank 1**, surfacing both the ownership rule and the EM rate-limit convention.

> ⚠️ These are **pure-cosine** upper bounds. Production `rankEntries` blends
> `0.5·lexical + 0.35·semantic + 0.15·recency` (see the retrieval-strategy
> critique), so the agent only realizes this lift once the weights are re-tuned
> for the strong-semantic era — tracked as the next improvement.
