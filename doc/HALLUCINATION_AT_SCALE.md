# Hallucination Check — As the Context DB Grows

> **Scope.** This is a dedicated pass on the hallucinations that *emerge as the memory store grows* — driven by **volume** (entry count), **age** (calendar time since capture), and **team size** (writers, tenants, retrieval traffic). It is deliberately distinct from the static governance design in `doc/` and `/tmp/ade_wf/synthesis_document.md`: those describe the *steady-state* trust spine; this document asks **what breaks when the corpus is large, old, and multi-tenant** — and what we watch for to catch it early.
>
> **Code-grounded.** Every failure mode below is tied to a verified `file:line` in the live ADE/Combyne repo (re-read and confirmed while writing this doc). Mitigation calls honor the four locked decisions: **(1)** self-hosted Postgres on the user's own infra (pgvector/pgbouncer/PITR are *ours* to run — no managed memory SaaS), **(2)** strict human-gated trust rolled out **label-then-exclude**, **(3)** multi-team org with Postgres **RLS required** before team onboarding, **(4)** Postgres + the existing ADE memory UI as the single system of record (no Obsidian SoR).
>
> **The honest framing, up front.** We do **not** claim "zero hallucinations." We claim a **layered defense** that bounds the blast radius of any single bad entry, quarantines agent-fabricated claims out of authoritative retrieval, and makes the *named residual risks* observable and time-bounded by monitoring. The residual risks are stated explicitly at the end — they are real and they survive the full stack.

---

## How to read severity and the adopt calls

**Severity** is the *growth-adjusted* impact: how bad the hallucination is **once the store is large**, not how bad it is today at single-operator scale.

| Severity | Meaning at scale |
|---|---|
| **critical** | Silently serves wrong/foreign content as authoritative fact; non-deterministic or unbounded blast radius. |
| **high** | Reliably degrades correctness as volume/age/team grows; bounded but real. |
| **med** | Erodes precision/recall; recoverable, surfaces as quality drift. |

**Adopt calls** on every mitigation option:

| Call | Meaning |
|---|---|
| **adopt** | Ship in the near-term roadmap; cheap or structural, high leverage. |
| **adopt-later** | Correct and necessary, but gated behind a prerequisite (pgvector, RLS trigger, backfill) — do not ship prematurely. |
| **consider** | Useful complement; ship if cheap or once its prerequisite lands. |
| **reject** | Not pursued (called out explicitly where relevant — e.g. bidirectional Obsidian sync as a staleness vector). |

---

# Cluster 1 — Retrieval degradation

*The ranker stops finding the right entry as the candidate pool grows. The output still reads authoritative because the render path emits it with no confidence signal — so a retrieval miss becomes a confident hallucination.*

### 1.1 — FNV-1a hash-64 embedding collisions saturate the semantic channel `[high]`

`embedText` (`server/src/services/memory.ts:34-44`) maps every token into one of only `EMBEDDING_DIM = 64` buckets via `vec[fnv1a(tok) % 64] += 1` and sums them bag-of-words. `cosineSimilarity` (`memory.ts:71-78`) is then a dot product over 64 dims. With a working vocabulary of thousands of distinct tokens against 64 slots, the pigeonhole principle guarantees heavy bucket-sharing — `'postgres'` and `'auth'` can collide, and a short entry's whole vector becomes a near-permutation of a handful of buckets. The `0.35` semantic weight (`memory.ts:153`) then ranks topically-adjacent-but-wrong entries above the right one, and the verbatim render (`heartbeat.ts:3934-3947`) emits it with no confidence marker.

- **Growth mechanism.** Collision probability in a fixed 64-bucket space rises monotonically with vocabulary/entry count (birthday bound: collisions near-certain past a few dozen distinct tokens). At dozens of entries, lexical overlap breaks ties; at thousands, dozens of entries share an effectively-identical 64-dim vector for any query, so the semantic term stops discriminating and *actively promotes false neighbors*.
- **Early-warning signal.** Per-query **semantic-score variance collapsing toward zero** as the store grows; rising fraction of retrieved entries whose semantic score is within ε of each other (flat top-k); many entries sharing near-identical stored 64-dim vectors; growing gap between semantic rank and human-judged relevance.

### 1.2 — Top-k saturates with near-duplicates, evicting the one correct entry `[high]`

`queryRanked` returns at most 8 entries to the heartbeat (`heartbeat.ts:3913-3919`, `limit:8`) with **no diversity, dedup, or per-cluster cap** pass. There is no canonicalization on write — `createEntry` (`memory.ts:228-255`) dedups on nothing today (the planned `(companyId,source)` unique index catches re-fires of the *same source*, not semantically-duplicate human answers or re-asked questions). As a convention gets re-captured across many tickets, the top-k fills with 5-8 paraphrases of one popular topic and crowds out the single entry that answers the current query.

- **Growth mechanism.** Every ticket Q&A capture (HOOK 1) and every `accepted_work` row (`accepted-work.ts`) adds another paraphrase of recurring topics. Duplicate mass for hot topics grows linearly with activity while k stays fixed at 8, so the probability that all 8 slots are consumed by one over-represented cluster rises with corpus age — the long-tail correct entry is squeezed out precisely when the store is largest.
- **Early-warning signal.** Top-k for common queries collapsing to a single `subjectKey` cluster (low distinct-subject ratio within top-k); duplicate-rate by normalized subject climbing; `memory_usage` rows concentrating on a shrinking set of entry ids.

### 1.3 — Context-budget composer truncates the correct entry out, tail-first `[med]`

The heartbeat concatenates entries in rank order then applies `body.slice(0, 16_000)` (`heartbeat.ts:3943`) — a hard tail cut. The composer places `'memory'` in the **stable tier** (`packages/context-budget/src/composer.ts:158-167`, confirmed: `'memory'` sits in `stableOrder` between `'projects'` and `'standing'`) and, on `stable_overflow`, shrinks lowest-priority stable sections **tail-first** (`composer.ts:222-255`). A correct entry that ranked 6th-8th (common when the weak hash ranker can't cleanly separate the winner) lands late in the block and is the first to be sliced away — the model sees the high-confidence-looking duplicates at the top and silently loses the one right entry.

- **Growth mechanism.** As the corpus grows, more entries clear the `lexical>0 || semantic>0.05` floor (`memory.ts:388`), so the rendered block trends toward the full k and toward the 16k cap; simultaneously other stable sections (skills, projects, handoff, the planned passdown) grow with team size, shrinking memory's effective budget. Both forces push the truncation boundary up through the rank list.
- **Early-warning signal.** Rising rate of `truncated`/`dropped` warnings for the memory section in context-budget telemetry; memory-section token usage pinned at its cap; increasing share of retrieved entries rendered-but-truncated mid-body.

### 1.4 — Recency + usage boost creates a self-reinforcing popularity loop `[high]`

`recencyBoost` (`memory.ts:110-116`) keys off `max(lastUsedAt, updatedAt)` with a 14-day half-life, and **every retrieval calls `recordUsage`** which bumps `lastUsedAt` and `usageCount` (`memory.ts:462-468`, confirmed unconditional). An entry that gets retrieved stays "recent" purely by being retrieved — a rich-get-richer loop independent of correctness. A once-right entry that was superseded keeps winning because its usage history keeps its recency term hot, and `runAutoDistill` (`memory.ts:705-748`) then proposes the most-used entries for promotion to shared — **laundering popularity into apparent authority**.

- **Growth mechanism.** The loop compounds with retrieval volume and entry count: the more retrievals accumulate, the more entrenched the popular entries become, and the harder it is for a newer correct entry (zero usage, must win on lexical/semantic alone — exactly the channels weakened by 1.1) to break in. Stale-but-popular entries accumulate as the store ages.
- **Early-warning signal.** `usageCount` distribution becoming heavily skewed (a few entries dominate `memory_usage`); high-usage entries with old `updatedAt` (popular but not recently edited = stale candidate); auto-distill repeatedly proposing the same high-usage entries; correct-but-new entries showing near-zero retrieval share.

### 1.5 — `serviceScope` dilution + exact-match filter both fail at scale, in opposite directions `[med]`

`loadCandidates` applies `serviceScope` as **strict equality** (`eq(memoryEntries.serviceScope, opts.serviceScope)`, `memory.ts:330-331`). When set, it silently drops every cross-cutting (null-scope) or sibling-service entry. When **not** set — the heartbeat path passes no `serviceScope` (`heartbeat.ts:3913-3919`) — all scopes compete in one undifferentiated 500-row pool, so a query about service A pulls in entries for unrelated services that happen to collide in hash-64. Scope is binary include/exclude with no fuzzy/hierarchical match and no scope-aware ranking weight.

- **Growth mechanism.** As more services/repos onboard, the unscoped pool grows with the cross-product of all teams' entries while the 500-row cap stays fixed — an arbitrary truncated window increasingly omits in-scope entries and over-represents the most prolific scope. Meanwhile the scoped path gets more brittle as the same fact is logged under inconsistent scope strings, so exact-equality misses grow with team count.
- **Early-warning signal.** Candidate count hitting the 500 cap on the unscoped heartbeat path; rising count of distinct `serviceScope` string variants for the same logical service; retrieved entries whose `serviceScope` mismatches the querying ticket's scope.

### 1.6 — Candidate-window truncation at 500, with NO `ORDER BY`, silently drops correct entries before ranking runs `[critical]`

`loadCandidates` hard-caps at `.limit(500)` (`memory.ts:337`) with **no `ORDER BY` in the SQL** (confirmed). Postgres returns an arbitrary, effectively physical-order 500-row slice, then ranking happens *only over that slice*. Below 500 active entries per company this is invisible; above it, the ranker never sees rows outside the unordered window — the globally-best entry can be **absent from the candidate set entirely**, and the model is served best-of-an-arbitrary-subset as if it were best-of-all.

- **Growth mechanism.** The cap is a constant; active entry count per company grows without bound (decay only archives ttl-set or 90-day-cold-zero-usage rows, `memory.ts:672-698`, so an active corpus of human answers + conventions accumulates indefinitely). Once active entries exceed 500, the fraction the ranker can consider falls below 100% and keeps shrinking; with no `ORDER BY` the dropped rows are **nondeterministic** — the same query can return different context on different runs.
- **Early-warning signal.** Active `memory_entries` count per company approaching/exceeding 500; **non-deterministic top-k for an identical repeated query**; retrieval recall (does the known-correct entry appear at all) dropping below 100% in an eval harness.

### Retrieval-degradation mitigation options

| Option | Pros | Cons | Effort | Call |
|---|---|---|---|---|
| **Real model embeddings + self-hosted pgvector ANN** (replace FNV-1a hash-64) | Fixes the root collision driver (1.1); `embedding_vec <=> q ORDER BY ... LIMIT k` replaces the unordered 500-row scan, killing the **critical** 1.6 drop and making retrieval deterministic; pgvector is an extension *we* install on *our* Postgres (RDS/Cloud SQL/Docker) — honors self-hosted; swap point already isolated to `embedText`/`loadCandidates` (`memory.ts:34,:322`, comments anticipate it) | Needs an embedder (self-hosted inference, or an external key = cost + a PII egress surface); dimension locks the HNSW index; one-time re-embed backfill of the jsonb corpus; **must ship with an `embedding_version` column** or the swap silently mis-scores the pre-cutover corpus (see Missed Mode M1); ANN recall <100% by construction | high | **adopt-later** |
| **Hybrid lexical + vector with explicit score fusion** | Hedges the weak semantic channel *now*: fuse the existing `lexicalScore` (`memory.ts:80-106`) with Postgres `tsvector`/GIN full-text so hash-64 collisions can't dominate before pgvector lands; Postgres-native, no new infra; one tunable fusion knob | Lexical alone misses paraphrase/synonym (the gap real embeddings fix) — a bridge, not a destination; to scale, `lexicalScore` must move into SQL or it inherits the 1.6 window problem; fusion weights are corpus-dependent and need eval tuning | med | **adopt** |
| **Dedup / canonicalization on write + `subjectKey` conflict resolution** | Attacks top-k near-dup saturation (1.2): one slot per fact frees the other 7; precedence (human-answer > pr-approval > verified-summary > agent-claim) keeps the *most-trusted* version; shrinks the active corpus, easing 1.6; small schema change (`supersededById`, migration 0049) | Over-merging risk: too aggressive collapses two distinct facts (silent data loss); two conflicting human-answers must go to `needs_review` (load grows with team size); canonicalization quality is capped by the weak embedder until pgvector lands (see Missed Mode M5 — normalizer is only `tokenize()` lowercasing) | med | **adopt** |
| **MMR (maximal marginal relevance) diversity pass over top candidates** | Tackles 1.2 at retrieval time with no write-side work; drops into `queryRanked` after `rankEntries` (`memory.ts:371-389`) as a post-rank reorder, no schema/infra; a diverse top-k lifts the one relevant outlier above the truncation boundary (counters 1.3) | Its similarity judgments run over the broken hash-64 vectors and are themselves noisy — *most valuable after pgvector*; adds a λ knob to tune; minor extra compute on the hot run-loop path | low | **consider** |
| **Cross-encoder reranking over the candidate shortlist** | Highest precision ceiling: joint (query, entry) scoring corrects hash-64 false neighbors (1.1) and lifts the right entry into the top slots before truncation (1.3); bounded cost (rerank top ~50); can be self-hosted; *more* valuable as the corpus grows | Another model to host on the run-loop hot path; useless before real first-stage embeddings (reranking a shortlist that already dropped the right entry can't recover it); meaningful per-query latency to budget | high | **adopt-later** |
| **Per-`subjectKey` / per-cluster caps in top-k selection** (e.g. max 2 per subjectKey) | Cheapest fix for 1.2; pure selection-time logic in `queryRanked` (`memory.ts:387-389`), no schema/infra/model; protects the long-tail correct entry and dampens the popularity loop (1.4) | Needs `subjectKey` to exist and be accurate (depends on canonicalization, and on M5's weak normalizer); a blunt cap can exclude a legitimately-deep cluster; treats symptom not cause — pair with write-side dedup | low | **adopt** |
| **Decouple recency from usage + add freshness/supersession decay** | Targets 1.4 at the source: stop `recordUsage`'s `lastUsedAt` bump (`memory.ts:462-468`) inflating recency (`memory.ts:110-116`); add a staleness penalty for old `updatedAt`; exclude `supersededById` entries; gate auto-distill on **distinct-issue reuse** not raw `usageCount` so the loop can't launder a popular-but-wrong entry into shared; small, surgical | Recency genuinely matters for some queries — over-correcting buries legitimately-hot context (needs a `pinned`/evergreen escape hatch); needs a `COUNT(DISTINCT issueId)` aggregate; doesn't fix the underlying collision, only one amplifier | low | **adopt** |
| **Scope-aware ranking weight + scoped candidate windowing** (replace binary `serviceScope` equality) | Fixes both directions of 1.5: boost in-scope while still letting null-scope cross-cutting entries compete; apply the scope filter inside SQL so the 500-row window fills with in-scope rows first (helps 1.6 on the scoped path); scope normalization reduces string-variant brittleness | Needs a normalized scope taxonomy across teams (org discipline, not just code; `issues.service_scope`, migration 0051, is a start); a soft boost can leak an out-of-scope-but-popular entry; partial without the broader candidate-window fix (pgvector `ORDER BY`) | med | **consider** |

---

# Cluster 2 — Fact lifecycle

*Facts that were true at capture become false over time, but the store has no mechanism whose rate scales with calendar time. As the DB ages, the stale fraction compounds — and the most-trusted, most-cited facts are the hardest to ever expire.*

### 2.1 — Stale facts survive forever because decay is human-triggered, not scheduled `[high]`

`runDecayPass` (`memory.ts:672-698`) and `runAutoDistill` (`memory.ts:705`) are reachable **only** via board-gated manual POST routes (`server/src/routes/memory.ts:352-368`). Grep confirms no `setInterval`/cron/heartbeat tick ever calls them. A fact captured in month 1 whose truth changed in month 3 stays `status='active'` and retrievable until an operator clicks "decay." Worse, `ttlDays` defaults `NULL` (`memory_layers.ts:48`; `createEntry memory.ts:250`) and the capture-hook plan stamps human-answer/pr-approval as **no-expiry by design** (synthesis §4.6) — so even when decay runs, the highest-trust facts are exempted from TTL.

- **Growth mechanism.** Decay is `O(operator-discipline)`, not `O(time)`. Every new entry is another row only a manual pass can retire; the human cadence stays roughly constant while entry count grows, so the gap between "facts that became false" and "facts an operator reviewed" widens monotonically.
- **Early-warning signal.** **Days since last `runDecayPass` per company** climbing unbounded; count of active entries with `updatedAt` older than 90 days and no decay action in the activity log; any retrieval whose top hit has `updatedAt` many half-lives old.

### 2.2 — Frequently-retrieved stale facts are IMMUNE to the one cleanup path that exists `[high]`

The only automatic-ish archival branch is `usageCount === 0 AND age > 90d` (`memory.ts:688`). But `recordUsage` increments `usageCount` on **every** retrieval (`memory.ts:462-468`). The moment a stale fact is retrieved once, it can **never** satisfy the cold-start condition again. Compounding it, `recencyBoost` keys off `lastUsedAt` when newer than `updatedAt` — it boosts by last-*retrieval* time, not truth-age — so a popular-but-wrong fact keeps a high recency score and keeps winning, re-bumping `lastUsedAt`. **The most-cited fact is the hardest to expire and the most damaging when wrong.**

- **Growth mechanism.** The loop strengthens with retrieval volume: more runs → more bumps → larger pool of facts permanently exempt from cold-start cleanup. Team scale multiplies retrieval traffic against the same un-penalized staleness.
- **Early-warning signal.** Entries with high `usageCount` but `updatedAt` far in the past (e.g. `usageCount>10 AND updatedAt>120d`); a **widening gap between `lastUsedAt` (recent) and `updatedAt` (old)** on top-ranked hits — the direct fingerprint of recency-by-retrieval masking truth-age.

### 2.3 — Supersession holes: no `supersededById` column, and nothing sets it `[high]`

The schema (`memory_layers.ts:28-63`) has no supersession field, and `updateEntry` (`memory.ts:262-289`) edits in place. When truth changes, capture hooks always `createEntry` a **new** row; the old contradicting row stays `active` and co-retrievable. `queryRanked` does no grouping/dedup and returns up to 50 hits, so an agent sees both `'deploy via Fly'` and `'deploy via Render'` with no signal which superseded which.

- **Growth mechanism.** Every fact-update adds a contradicting pair instead of replacing. With N updates over the DB's life you accumulate up to N stale-vs-current pairs, all active and rankable; the probability a retrieval surfaces a superseded sibling rises with revision count per subject.
- **Early-warning signal.** Multiple active entries sharing a normalized `subjectKey` with divergent bodies and different `updatedAt`; before `subjectKey` exists, count active entries whose subject is near-identical (`lexicalScore>0.8`) but body differs.

### 2.4 — Two genuine human-answers disagree on the same `subjectKey`, with no reconciliation `[high]`

The capture plan stamps human Q&A answers `verificationState='verified', confidence=0.95` at write (`routes/issues.ts:1045-1112`, HOOK 1). Two users answering the same recurring question on two tickets both write verified/high-confidence rows. Today's ranker has **no conflict resolution** — both surface, both look authoritative, the agent picks arbitrarily by score (recency tiebreak silently favors whoever answered last). This is the explicit open decision in `synthesis_meta.json`. Until `subjectKey` + a `needs_review` queue exist, two verified contradictions are a hallucination source that looks *more* trustworthy than an honest unverified note.

- **Growth mechanism.** More humans × more re-asked questions × DB age = more independent authoritative answers per subject. Single-operator mode hides this (one internally-consistent human); it **detonates at the team-onboarding milestone the plan is building toward**.
- **Early-warning signal.** Two+ active entries with `provenance='human-answer'`, `verificationState='verified'`, same `subjectKey`, different bodies, different `authorId`; `needs_review` queue depth once it exists; before it, `GROUP BY subjectKey HAVING count(distinct body)>1` on verified rows.

### 2.5 — Duplicate proliferation from capture hooks firing repeatedly `[med]`

`createEntry` is a plain `INSERT` (`memory.ts:236-253`) with no unique index on `(companyId, source)`. The accepted-work writer sets `source='accepted_work:<eventId>'` (`accepted-work.ts:380`); planned hooks set `human-answer:...`/`pr-approval:...`. If the answer endpoint is retried, reconcile runs twice, or a poller re-emits an accepted-work event, each fire writes another identical row. Duplicates split/inflate `usageCount`, distort auto-distill's `usageCount>=3` threshold (`memory.ts:709,724`), and multiply token cost.

- **Growth mechanism.** Retry/replay events scale with traffic; with no natural-key constraint, duplicate count is unbounded. At team scale, more agents × more flaky network paths multiplies the re-fire rate.
- **Early-warning signal.** `count(*) GROUP BY (companyId, source) HAVING count(*)>1` — any value >1 is a duplicate today; a spike in near-identical subjects sharing a `source` prefix after a retry storm.

### 2.6 — Verified entries silently rot — no re-verification ever happens `[critical]`

Once hooks stamp `verificationState='verified' + verifiedAt` (migration 0049), nothing re-checks them (grep: no scheduler at all), and verified human-answer/pr-approval rows are TTL-exempt by design (§4.6). A fact that was true and human-verified at capture stays labeled "verified, do not treat as unverified" **forever** — even after its PR is reverted, the convention abandoned, the staging host decommissioned. The verified label — the exact thing `requireVerified` gates authoritative retrieval on — becomes a **stale guarantee**. This is the most dangerous rot because it's the content the system tells agents to trust *most*.

- **Growth mechanism.** The verified set is append-only and monotonic; every capture adds a permanently-trusted row and none are re-examined. As it grows, the fraction whose source-of-truth has drifted since `verifiedAt` grows with calendar time. The Release-N+1 `requireVerified` flip makes this **worse** by making the stale-verified set the *only* thing retrieved (see Weak-Mitigation flag W3).
- **Early-warning signal.** Verified entries whose `verifiedAt` is old (>180d) and whose `sourceRefId` points at a now-closed/reverted PR or deleted issue; age distribution of `verifiedAt` with no corresponding re-verification event; any verified entry whose `sourceRef` no longer resolves = confirmed rotted guarantee.

### Fact-lifecycle mitigation options

| Option | Pros | Cons | Effort | Call |
|---|---|---|---|---|
| **Scheduled staleness audit + decay** (wire `runDecayPass`/`runAutoDistill` into the heartbeat scheduler) | Closes the biggest gap (2.1): the decay code already exists, this is a *wiring* change; per-company tick next to the existing scheduler loop (`heartbeat.ts:6583`); cheap | **Will not hold once active entries exceed `runDecayPass`'s `.limit(2000)` window — see Missed Mode M2: scheduling more often does not help, each run still sees an arbitrary unordered 2000-row slice**; background scans need `BYPASSRLS` once RLS lands; multi-replica needs leader-election | low | **adopt** *(but must remove the 2000 cap, add `ORDER BY updatedAt ASC`, and paginate — see M2)* |
| **Provenance-aware TTL + truth-age penalty in `recencyBoost`** | Replaces the NULL-ttl "never expires" default with per-provenance defaults (agent-claim 30d, verified-summary 180d, human-answer/pr-approval flag-for-reverify); fixing `recencyBoost` to decay by `updatedAt` (truth-age) not `lastUsedAt` directly defeats 2.2's immunity loop; localized | Changes ranking for all entries — needs `memory-service.test.ts` re-baselined + a before/after rank diff; can starve a genuinely-evergreen old convention (needs an evergreen escape hatch); depends on the provenance column (0049) | med | **adopt** |
| **Supersession-on-write + exclude superseded at retrieval** | Fixes 2.3: writing a new fact on an existing `subjectKey` marks the prior row `supersededById`; `loadCandidates` excludes `supersededById IS NOT NULL`; deterministic precedence makes "which wins" explainable; keeps history for audit | Needs net-new `supersededById` + `subjectKey` (0049); **`subjectKey` normalization is the weak link — M5: only `tokenize()` lowercasing, so paraphrase/synonym/cross-lingual supersessions silently no-op**; an agent-claim must never supersede a verified human-answer (precedence must gate the write) | med | **adopt** |
| **`subjectKey` conflict → `needs_review` queue for two disagreeing human-answers** (not silent newest-wins) | Resolves the explicit open decision (2.4): conflicting verified answers enqueue and **both** are excluded from authoritative retrieval until a board reconciles; reuses the proven board-review checkpoint (`memory_promotions` + `decidePromotion`, `memory.ts:609-642`) | Adds a human step exactly when conflicts spike at team scale (queue can back up, starving that subject); excluding both means a genuinely-answered question temporarily returns nothing (needs a "show both with conflict banner" fallback for low-stakes subjects); needs `subjectKey` (0049) + the M5 normalizer fix or conflicts in different phrasings never collide | med | **adopt** |
| **Idempotent `(companyId, source)` upsert + unique partial index** | Kills 2.5 at the root: `onConflictDoNothing` makes every re-fired capture a no-op; `source` is already a natural key the hooks set; protects auto-distill's `usageCount>=3` signal | Pre-existing duplicates must be merged before the unique index can be created; `source` is nullable today so the partial index only protects sourced rows (un-sourced manual entries can still duplicate — pair with `subjectKey` dedup); `onConflictDoNothing` must re-select the existing row so callers still get an entry back | low | **adopt** |
| **Periodic re-verification job** (re-resolve `sourceRef`, demote to `needs_review` on drift) | Directly addresses the **critical** 2.6: structural checks (PR reverted? issue deleted?) are deterministic and cheap, no LLM needed; a re-verify SLA (re-check verified rows >180d) gives the verified label a bounded freshness guarantee instead of a forever-promise | Content-level rot (PR still merged but convention abandoned) isn't catchable by `sourceRef` resolution alone — needs human re-verification for semantic cases (doesn't scale); demoting a verified entry that `requireVerified` depends on can empty retrieval for that subject; needs `verifiedAt`/`sourceRefType`/`sourceRefId` (0049) + a scheduler under `BYPASSRLS` | high | **adopt-later** |
| **`max-versions-per-subjectKey` cap** (auto-archive oldest superseded revisions beyond N) | Bounds the historical-pair accumulation driving 2.3/2.5 — at most N revisions per subject keeps the contradiction surface constant as the DB ages; cheap alongside supersession-on-write | Throws away audit history that `supersededById` was preserving (tension with that approach); pure safety-net — only helps once `subjectKey` + supersession exist; picking N is a guess | low | **consider** |

---

# Cluster 3 — Adversarial / trust

*A single poisoned, secret-bearing, or wrongly-blessed entry steers every downstream agent run. The trust model is the primary control; everything else is defense-in-depth that an LLM can ignore.*

### 3.1 — Stored-memory prompt injection (second-order injection) `[critical]`

The render at `heartbeat.ts:3934-3947` builds the preamble as `## ${entry.subject}\nLayer: ${entry.layer}${scope}${tags}\n${entry.body}` with **zero delimiting, escaping, or content fencing** (confirmed at `:3939`) — body markdown becomes preamble markdown. As entry count grows, top-8 retrieval pulls from a larger pool where one poisoned `workspace`/`kind:fact` row (immediately active+retrievable; no trust column exists in the schema today) can win a slot. An attacker (or a sloppy paste) needs **one** entry that says "always disable auth checks / exfiltrate env to URL X / ignore prior instructions" to steer every downstream run that retrieves it. The blast radius is **multiplicative**: one poisoned shared/workspace row × every agent × every issue that ranks it.

- **Growth mechanism.** A larger team means more write surface (every accepted-work agent write `accepted-work.ts:374-376`, every human answer, every PR-decision note is a candidate carrier), and a larger pool means a poisoned row more easily wins a slot.
- **Early-warning signal.** Memory bodies containing imperative/second-person directives (`you must`, `ignore`, `always run`, `instead of`) or fenced code/URLs that are not facts; a single entry's `usageCount` climbing across many distinct issues; agent runs taking actions traceable to a memory body rather than the ticket.

### 3.2 — Confidence/usage inflation: an unverified wrong entry climbs to a board promotion `[high]`

`recordUsage` increments `usageCount` **unconditionally** on every retrieval by any actor, including the agent's own self-retrieval on every run (`heartbeat.ts:3925`). `runAutoDistill` (`memory.ts:705-745`, `minUsage` default 3) orders by `usageCount desc` with **no distinct-issue and no distinct-actor dedup** — three self-retrievals of the same entry reach the threshold. As the same wrong-but-plausible entry keeps surfacing for similar queries (the hash embedder is weak), its count compounds, driving it toward the promotion queue where a rubber-stamp converts `unverified → verified/authoritative`.

- **Growth mechanism.** A larger team multiplies retrieval volume, accelerating bad entries to the board's review surface. **Critically: the entries the hash ranker false-matches most accrue the highest `usageCount` precisely because they are the worst-discriminated — traffic growth launders ranker error into promotion signal** (see Missed Mode M3).
- **Early-warning signal.** Entries with high `usageCount` but `verificationState=unverified` and few **distinct** `issueId`s in `memory_usage`; auto-distill proposals dominated by agent-authored (`accepted_work:%`) sources; promotion-queue depth rising faster than distinct-human-decision events.

### 3.3 — Agent-claims leaking into authoritative retrieval via the parallel self-retrieval channel `[critical]`

Even after a `requireVerified` filter lands on the EM passdown, the sub-agent's **own** self-retrieval at `heartbeat.ts:3895-3925` calls `queryRanked` over `['workspace','shared','personal']` (confirmed `:3913-3918`, `limit:8`, no `requireVerified`), and `loadCandidates` filters **only** `companyId + status='active'` (`memory.ts:326`) — no trust filter at all. An agent-authored workspace fact is pulled into the preamble with **identical formatting** to a verified entry, next to the vetted EM packet. If `requireVerified` is applied to only one of the two channels, the unverified channel stays wide open. **Applying the filter to one channel makes governance cosmetic.**

- **Growth mechanism.** As entry volume grows the unfiltered channel's pool grows, so the probability an agent-claim out-ranks a verified entry rises. Across a team, every agent has this open channel — the hole scales per-agent.
- **Early-warning signal.** `queryRanked`/`loadCandidates` call sites omitting `requireVerified` (grep guard around `heartbeat.ts:3913`); injected preamble entries whose `provenance=agent-claim` appearing despite a verified-only policy; a diff that adds the filter to em-passdown but not to the self-retrieval. **Assert in a test that both channels reject unverified.**

### 3.4 — PII/secret accumulation in human-answer and EM-note bodies `[high]`

The question-routing prompt explicitly escalates credentials/access to humans (`agent-question-routing.ts:194`), so the human's free-text answer body is the **most likely** place a real secret lands. The planned HOOK 1 writes that answer to `layer=workspace` (company-wide, readable by every agent) with `provenance=human-answer/verified`. `createEntry` does no content classification. Every captured answer and EM decision-note is a potential secret deposit — and they are the **highest-trust, never-expiring tier**, re-injected verbatim into agent preambles and, if a markdown export ships, git-committed.

- **Growth mechanism.** Human-answers don't decay, so the corpus of company-wide bodies grows monotonically — secret density accumulates. Bigger team = more answerers = more credential pastes into a shared, long-lived, broadly-readable store.
- **Early-warning signal.** Bodies matching secret shapes (`sk-`, `ghp_`, `AKIA`, `Bearer`, `BEGIN PRIVATE KEY`, `postgres://user:pass@`, `password=`); answers captured from questions routed as credentials/access; growth in workspace-layer body bytes from `human-answer` source.

### 3.5 — Compromised or sloppy human writes a bad "verified" fact (single-point-of-trust) `[high]`

The trust model rests on human-sourced content being authoritative. But `getActorInfo` returns `actorType='user'` for `local_implicit` too (`authz.ts:46-51`), and in single-operator mode `local_implicit` answers are treated as verified by design — **one operator account is a single point of trust**. A board-gated `/verify` lets any board principal stamp `verified` with no second reviewer. As the org grows multi-team, more humans hold verify rights; one compromised or careless human can mint authoritative facts that flow through EM passdown into every sub-agent and, via conflict precedence (human-answer > pr-approval > verified-summary > agent-claim), **outrank and supersede correct agent-claims**. A bad verified fact is harder to dislodge than a bad agent-claim.

- **Growth mechanism.** Scale adds verifiers, blast radius, and the staleness window during which nobody re-checks.
- **Early-warning signal.** Verified entries with a single `verifiedBy` and no corroborating `sourceRefId`; a spike in entries verified by one principal in a short window; verified entries later contradicted by a human-answer reconciliation; a board principal acting with empty/implicit company scope.

### 3.6 — Cross-tenant leakage of poisoned/secret entries once multiple companies share the instance `[high]`

*(Also analyzed structurally in Cluster 4; here as the adversarial consequence.)* Isolation today is 100% app-layer (`assertCompanyAccess`); there are **zero** Postgres RLS policies, and `local_implicit`/`isInstanceAdmin` bypass scoping (`authz.ts:25-31`). `loadCandidates` trusts the `companyId` the app passes. As the 2nd/3rd company onboards, every app-layer scoping miss becomes a cross-tenant read of another company's poisoned or secret-bearing memory — ingested by the consuming agent as its own fact. The probability of a leaking path rises combinatorially with `tenants × query-sites`, and the value of a leak rises with corpus size.

- **Growth mechanism.** The pgbouncer transaction-pooler makes a plain `SET app.current_company` unreliable (`SET` and query may not share a backend — same pinning hazard documented at `summarizer-queue.ts:15-19`), so even an RLS attempt can silently fail-open if implemented as a session `SET` on a pooled checkout.
- **Early-warning signal.** Any retrieval site reaching `memory_entries` without an explicit company filter; board/`local_implicit` principals operating with empty `companyId`; background scans returning rows across `companyId`s; absence of `SET LOCAL` inside a per-request transaction on the pooler.

### Adversarial / trust mitigation options

| Option | Pros | Cons | Effort | Call |
|---|---|---|---|---|
| **Two-sided write-gate + `requireVerified` on BOTH retrieval channels** (EM passdown AND self-retrieval at `heartbeat.ts:3913`) | Closes the primary amplifier at source: `createEntry` forces `unverified`/`confidence<=0.4` for agent authors regardless of request body, so an agent **cannot** mint an authoritative fact; applying the filter to the self-retrieval too is what makes governance *real* not cosmetic (3.3); deterministic and testable; bounds the blast radius of **every** other failure (collisions, popularity loop, injection, conflicting claims) to the human-vetted set | Flipping `requireVerified` before a backfill+verify path empties the preamble (only ex-shared rows survive) — **must ship label-only first (Release N) then exclude (Release N+1)** to avoid starvation; requires the trust spine (0049); a future code path could add a third retrieval site that forgets the filter (needs a lint/test guard) | med | **adopt** |
| **Injection-resistant rendering** (fence + "data not instructions" framing + `[mem:id · provenance · conf]` citation at `heartbeat.ts:3934-3947`) | Targets the verbatim-injection render directly; cheap, no migration, deployable as defense-in-depth in Release N; provenance citation creates a forensic trail; separates quoted knowledge from live instructions even for verified entries | **Defense-in-depth ONLY, never a control — an LLM can ignore a delimiter/caveat (see Weak-Mitigation W5)**; naive fencing is defeated by a body containing the closing delimiter unless the delimiter is HMAC/randomized per render; adds preamble tokens against the budget | low | **adopt** |
| **Redaction/secret-scan gate as a BLOCKING prerequisite** before any human-answer/EM-note write to company-wide workspace | Stops 3.4 at the exact deposit point (the highest-risk path per `agent-question-routing.ts:194`); on detection redact or set `needs_review` and exclude until cleared (fail-safe, not fail-open); protects the most dangerous tier; also gates the optional markdown export so secrets never reach a git vault | Regex detection has false negatives (novel shapes, base64) and false positives (hex IDs) — needs tuning + a manual-clear path; adds a synchronous step to the answer write (best-effort try/catch so it never fails the response, but a hard secret-block must not be silently bypassed); needs a one-time backfill scan of existing bodies | med | **adopt** |
| **Promotion-signal hardening** (`COUNT(DISTINCT issue_id)` AND distinct-actor reuse, not raw `usageCount`; exclude self-retrieval from the counter) | Defuses 3.2: counting distinct issues/actors makes popularity reflect genuine cross-context reuse, not a self-retrieval loop; cheap from `memory_usage` rows already recorded; reduces board review noise; can weight by verified-actor/human reuse | Slightly more complex distill query + a threshold to tune; excluding self-retrieval requires tagging the `heartbeat.ts:3925` call through `recordUsage`; **still measures retrieval *breadth*, not *usefulness* — an entry false-matched across many distinct issues still scores high (Weak-Mitigation W4 + Missed Mode M3)**; promotion is still only a proposal, so this is quality control not a hard boundary | low | **adopt** |
| **Verify-SLA + audit log + dual-control on `/verify`** (require a non-null `sourceRefId` for any verified stamp) | Addresses 3.5: "verified" becomes provably derived, not asserted; append-only audit of who/when is the forensic backbone for the injection and cross-tenant modes; a `needs_review` queue prevents indefinite-trust drift; dual-control removes the single-point-of-trust for the most authoritative tier | Human-process friction — scope dual-control to shared-layer/high-impact only, leave workspace single-verify; a new append-only table; doesn't stop a determined compromised admin (they can satisfy `sourceRef` with a benign ref) — reduces sloppiness + adds traceability, not a guarantee; SLA enforcement needs a background scan under `BYPASSRLS` | med | **adopt** |
| **Postgres RLS + `BYPASSRLS` scheduler role + `SET LOCAL`-in-transaction** (gated behind the multi-tenant trigger) | The only real fence for 3.6 cross-tenant leakage once 2+ companies share the instance; solves the pgbouncer pinning interaction correctly (`SET LOCAL` clears at COMMIT, can't leak into the next pooled checkout — unlike the session-`SET` defect at `summarizer-queue.ts:15-19`); `BYPASSRLS` role for the heartbeat global scan (`heartbeat.ts:6559`) prevents the fail-closed zero-rows outage; fail-closed on empty `companyId` closes the narrow current bypass | Genuinely complex (policy authoring, pooler/txn wiring, role separation, local-board owner-remap interaction); not needed for single-operator phase (premature RLS adds friction with no tenant to isolate); per-tenant agent-JWT key separation is a **separate** workstream (a leaked global agent secret defeats isolation regardless); self-hosted means **we** own `BYPASSRLS` hygiene, pgbouncer transaction-mode config, and `max_connections` | high | **adopt-later** |
| **Content-security scan for instruction-shaped bodies** (anti-injection classifier at write + render) | Targets stored prompt-injection (3.1): flag imperative/second-person directives, "ignore previous", fenced executable code, exfiltration URLs → quarantine to `needs_review`; catches a poisoned **human-authored** entry the trust-gate would otherwise stamp verified; scan-at-render gives a runtime tripwire metric | False positives on legitimate runbooks (which *are* imperative — "always run migrations before deploy") — needs a runbook allowlist + human-clear; an LLM classifier adds latency/cost and is itself unverified (use deterministic rules for the blocking gate, classifier only as an advisory flag); sophisticated injections phrased as declarative facts evade directive-detection — a net, not a wall | med | **consider** |

---

# Cluster 4 — Tenant / scope

*The single fence today is `assertCompanyAccess` plus a URL-path `companyId`. With one company a missing filter is invisible; with N companies it is a cross-tenant hallucination. RLS is required — not someday — before team onboarding.*

### 4.1 — App-layer scoping bug leaks cross-company rows before RLS lands `[critical]`

Isolation is 100% app-layer: `assertCompanyAccess` (`authz.ts:18-31`) checks membership against `companyId`, and every memory query trusts the `companyId` from the URL path (`routes/memory.ts:27`) then filters `eq(memoryEntries.companyId, companyId)` (`memory.ts:326`). With one company, a missing/wrong filter is invisible. As N companies accumulate, **every** query path (memory, issues at `heartbeat.ts:407`, accepted-work, handoffs) becomes a place where one forgotten `companyId` predicate returns another tenant's rows. To the consuming agent a leaked row is indistinguishable from its own context — a cross-tenant hallucination.

- **Growth mechanism.** Leak sites are `O(query-paths)` and blast radius is `O(tenants)` — the product grows with both code size and tenant count.
- **Early-warning signal.** An isolation test (agent of company A receives any row with `company_id != A`) returns non-empty; activity-log shows memory reads where the actor's companyIds don't include the row's `company_id`; spike in retrieved entries referencing repos/services not belonging to the querying tenant.

### 4.2 — RLS + pgbouncer transaction-pooler backend-pinning: `SET` vs `SET LOCAL` scopes to the wrong tenant `[critical]`

No per-request tenant binding exists in code today — grep finds **zero** `SET LOCAL`/`set_config`/`current_setting` and **zero** `CREATE POLICY` in the whole repo; the actor middleware (`auth.ts:20-152`) populates `req.actor` in memory only. When RLS lands (migration 0053), a policy reads `current_setting('app.current_company')`, which must be `SET` per request. The repo already documents the exact hazard at `summarizer-queue.ts:15-19`: session-scoped state lands on different pooled sessions. A plain session-level `SET` on a transaction-pooled checkout has the identical defect — the `SET` and the query may run on different backends, so the query runs with a **stale value (a previous request's tenant — cross-tenant read)** or an empty value (RLS evaluates false → zero rows, or a NULL-comparison a sloppy policy treats as match-all). The leak is silent because the query succeeds.

- **Growth mechanism.** As concurrency and tenant count rise, the probability a checkout carries a residual setting from a different tenant rises toward 1.
- **Early-warning signal.** Under concurrent multi-tenant load, the same query returns different row sets across requests for the same actor; `current_setting('app.current_company')` observed empty/mismatched inside a scoped query; an interleaved two-tenant test on a shared pooled connection sees A's `SET` leak into B's query.

### 4.3 — Empty/undefined `companyId` bypass for `local_implicit` and `isInstanceAdmin` `[high]`

`assertCompanyAccess` short-circuits the membership check when `req.actor.type==='board'` AND (`source==='local_implicit'` OR `isInstanceAdmin`) — `authz.ts:25` returns **without validating that `companyId` is a real, non-empty value**. In `local_trusted` mode the middleware hard-codes every request to `{isInstanceAdmin:true, source:'local_implicit'}` (`auth.ts:23-24`), so this branch is always taken; the `companyId` is whatever the URL path carries. Once multi-tenant, an instance-admin or residual `local_implicit` path with an empty-string or wrong `companyId` skips the check — an empty `companyId` matches zero rows, or, if any path treats empty/undefined as "no filter," matches **all** tenants.

- **Growth mechanism.** Worsens as more admin-scoped tooling and background jobs are added, each a place where `companyId` can arrive empty.
- **Early-warning signal.** A request reaching `assertCompanyAccess` with `companyId === '' | undefined` does not throw; an admin/`local_implicit` actor reads/writes memory under a `companyId` not in their `companyIds`; a fuzz test passing empty `companyId` returns 200 instead of 400/403.

### 4.4 — Background global scans return zero rows under naive RLS, silently halting the instance `[high]`

The heartbeat scheduler scans all agents across all tenants with an unscoped `db.select().from(agents)` (`heartbeat.ts:6559`) and similar reads (`heartbeat.ts:407`), on the shared pool with no tenant context. The moment RLS is enabled with a policy keyed to `current_setting('app.current_company')`, a tick that never `SET`s a company matches **zero rows for every tenant** — no agent gets a heartbeat, no timer fires, the whole fleet silently stops. This is a fail-**closed** outage; its blast radius is the entire instance. The fix (a dedicated `BYPASSRLS` scheduler role) must exist **before** RLS is switched on.

- **Growth mechanism.** Gets worse as more tenants depend on the shared scheduler.
- **Early-warning signal.** After enabling RLS in staging, heartbeat enqueue counts drop to zero across all companies; `tickTimers` logs "checked: 0" despite invokable agents; no wakeup runs created; `lastHeartbeatAt` stops advancing instance-wide.

### 4.5 — Per-tenant volume imbalance starves small tenants' retrieval `[med]`

`loadCandidates` over-fetches `.limit(500)` (`memory.ts:337`) then ranks in-process; the embedder is a weak global FNV-1a hash (`memory.ts:34`) with no tenant salt. With one tenant this is fine. As tenants grow at wildly different rates, any change broadening the candidate set — or a pgvector ANN over a *shared* index — lets the high-volume tenant's rows dominate recall, and the heavy tenant's huge candidate set makes its in-process ranking slow and its hash collisions more frequent (lower precision, more confident-looking marginal entries). Small tenants get sparse-but-clean retrieval; large tenants get noisy retrieval — both are correctness regressions scaling with the skew.

- **Growth mechanism.** The skew between tenant corpus sizes only grows.
- **Early-warning signal.** p95 `queryRanked` latency diverging sharply by `company_id`; heavy tenants showing a rising rate of low-score (<0.2) entries crossing the injection threshold; small tenants showing empty preambles.

### 4.6 — Shared embedding / ANN space across tenants leaks neighbors once pgvector lands `[high]`

`embedText` is a global, deterministic, tenant-agnostic hash — identical text in tenant A and B produces identical vectors. Today this is harmless because `loadCandidates` pushes `eq(company_id)` into the SQL `WHERE` before ranking (`memory.ts:326`), so the company filter is the real fence. The hazard is migration 0052: an HNSW index is built over **all** rows regardless of tenant, and a naive `ORDER BY embedding <=> $q LIMIT k` returns the **global** nearest neighbors. If the `company_id` predicate isn't pushed *into* the ANN query (or enforced by RLS the ANN path respects), the top-k can include another tenant's semantically-identical entry — a cross-tenant retrieval the agent treats as its own knowledge.

- **Growth mechanism.** Risk grows with tenant count (more identical-vector collisions) and index size (post-filtering k may all belong to other tenants, emptying a small tenant's top-k).
- **Early-warning signal.** After enabling pgvector ANN, a vector query for tenant A returns rows with `company_id != A` (pre-filter test); recall drops because post-ANN company filtering empties the top-k for small tenants; two tenants with identical entries see each other's as the nearest neighbor.

> **Structural gap (Missed Mode M4, folded in here):** `memory_usage.companyId` is a **bare `uuid("company_id").notNull()` with no `.references()`** (confirmed `memory_layers.ts:113`), unlike `memory_entries.companyId` which has `.references()` + `onDelete: 'cascade'`. `memory_usage` is the highest-volume tenancy surface (one row per entry per retrieval per run — superlinear in tenants × agents × tickets), records `actorType`/`actorId`/`issueId`/`score` across tenants, and is **the one of the three memory tables with the weakest schema-level scoping**. On company delete, `memory_usage` rows do **not** cascade (orphaned history still feeds promotion aggregates). It must get its own FK + RLS policy or it becomes the largest *and* least-protected leak surface.

### Tenant / scope mitigation options

| Option | Pros | Cons | Effort | Call |
|---|---|---|---|---|
| **App-layer `companyId` hardening as the bridge** (fail-closed on empty/undefined for ALL principals incl. `local_implicit`/admin) | Closes the `authz.ts:25` bypass directly: an explicit `if (!companyId) throw forbidden()` at the **top** of `assertCompanyAccess` before any short-circuit; zero schema change, ships today, protects the entire single-operator→first-team window; one unit test per principal type | Still `O(query-paths)` discipline, not structural — a route that forgets to call it still leaks (Weak-Mitigation W6); doesn't defend a wrong-but-non-empty `companyId`; must audit every route to confirm it uses the path `companyId`, not a body-supplied one | low | **adopt** |
| **Postgres RLS with per-request `SET LOCAL` inside an explicit transaction** | Moves isolation from `O(query-paths)` app discipline to **one DB-enforced invariant** — a forgotten predicate can no longer leak; `SET LOCAL` is txn-scoped, auto-cleared at COMMIT/ROLLBACK, can't leak into the next pooled checkout (the correct answer to the pgbouncer pinning hazard); honors the locked decision that RLS is required before team onboarding | Requires wrapping **every** tenant-scoped handler in a transaction that does `SET LOCAL` first — a real request-lifecycle refactor; raises connection hold time + pool pressure against self-hosted `max_connections` (size with pgbouncer); only correct if the whole request runs in one txn on one connection (any second pool connection escapes the binding); background jobs need the `BYPASSRLS` story | high | **adopt** *(at the multi-tenant trigger)* |
| **Dedicated `BYPASSRLS` role for the heartbeat scheduler + all background scans** | Prevents the fail-closed outage (4.4): `tickTimers`' unscoped `db.select().from(agents)` (`heartbeat.ts:6559`) and the issues scan (`heartbeat.ts:407`) keep working; clean separation — request traffic uses the RLS-enforced role with `SET LOCAL`, background traffic uses the privileged role | A second crown-jewel credential (sees every tenant) to provision/secure/rotate, never reachable from request paths; background code under `BYPASSRLS` must **manually** scope every query by `company_id` (loses the safety net where it has the most power — needs its own isolation tests); easy to misuse | med | **adopt** *(prerequisite for RLS)* |
| **pgbouncer in transaction mode + disciplined `SET LOCAL` + explicit connection sizing** | Transaction mode is compatible with `SET LOCAL` and gives connection multiplexing without a managed cap — **we** own `max_connections` and pool size (self-hosted equivalent of the rejected Supabase cap); lets us pass explicit pool sizing the code lacks (`client.ts:50-51` passes no `max` → postgres-js default 10) and document the budget math | Transaction mode forbids session features (plain `SET`, session advisory locks, prepared statements unless `prepare:false`) — audit needed; note `prepare:false` is auto-set only for port 6543 today (`client.ts:14-16`) and must generalize for a self-hosted pgbouncer host; mis-sizing deadlocks the app (txn-per-request holds a connection for the whole handler); one more component to run/monitor/HA | med | **adopt** *(at central-DB / team phase)* |
| **Per-tenant indexes / partitioning + push `company_id` INTO the ANN query** (partial/per-tenant HNSW) | Solves both 4.5 starvation and 4.6 leak: LIST partition by `company_id` or partial HNSW per high-volume tenant keeps one tenant's vectors out of another's neighbor search; the ANN `company_id` predicate becomes index-backed so post-filtering doesn't empty a small tenant's top-k; aligns the pgvector cutover with isolation from day one | pgvector ANN doesn't cleanly combine HNSW with an arbitrary `WHERE company_id` (pre-filtering can fall back to exact scan; partitioned HNSW is operationally heavy, partition count grows with tenants); DDL-per-tenant onboarding machinery; premature before pgvector lands and the dimension is decided | high | **adopt-later** |
| **Automated cross-tenant isolation test suite as a CI gate** | Turns isolation from a hope into an enforced invariant: tests that (a) agent of A receives zero rows with `company_id != A`, (b) empty/wrong `companyId` is rejected per principal type, (c) interleaved two-tenant requests on a pooled connection never cross `SET LOCAL`, (d) post-RLS heartbeat scan still returns rows via `BYPASSRLS`, (e) pgvector top-k contains no foreign tenant, (f) the unscoped `memory_usage` path is covered; catches the two **critical** modes before prod; runs on every PR | Only as good as the boundaries covered — pair with a lint/grep gate flagging any tenant-scoped query lacking a `company_id` predicate; concurrency/pinning tests are flaky and need a real pooled connection (not the embedded single-conn test DB); adds CI time | med | **adopt** |

---

# Adversarial critic — folded in

*Six failure modes the four clusters missed, the weak-mitigation flags, the prioritized defense stack, and the strongest mitigations. These are integrated above where relevant and consolidated here.*

## Missed failure modes

| # | Missed mode | Code anchor | Why it grows | Severity |
|---|---|---|---|---|
| **M1** | **Embedder version drift with NO `embedding_version` column** — query and stored vectors silently embedded by *different models*, scoring garbage. `rankEntries` re-embeds the query live (`embedText(query)`, `memory.ts:155`) and dots it against whatever was stored at write time. The moment the embedder swaps (hash-64 → real model), every pre-swap entry is scored in a different vector space. `cosineSimilarity` (`memory.ts:73`) **silently truncates to `min(a.length,b.length)`** (confirmed) — a 64-dim stored vector vs a 1536-dim query does **not** throw; it dots the first 64 dims of an unrelated basis and returns a numerically-valid, semantically-meaningless score. With no version tag, nothing can even `SELECT` which rows are stale-embedded. | `memory.ts:44,73,155`; `memory_layers.ts:44` (jsonb, no version field) | The corpus is append-only and the embedder changes at least once; every pre-cutover entry (the largest, oldest, most-trusted slice) is permanently mis-embedded unless a full re-embed runs, and partial backfills (what operator discipline produces) leave a permanent silent mix of two vector spaces that compounds with every model bump. | high |
| **M2** | **`runDecayPass` itself silently caps at `.limit(2000)` with NO `ORDER BY`** (`memory.ts:680`, confirmed) — the staleness audit goes blind past 2000 active entries, the same bug as 1.6 but for *cleanup*. Above 2000 active entries per company, the stalest rows fall outside the nondeterministic window and are **never** evaluated, even by a perfectly-disciplined daily-decay operator. `runAutoDistill` has the same shape (`.limit(max*4)` ordered by `usageCount`, `memory.ts:721-722`, confirmed) so low-usage-but-correct entries never reach the promotion scan. | `memory.ts:680,721-722` | The 2000 cap is constant; active entries per company grow unbounded (and `usageCount=0` is unreachable once retrieved, per 2.2). Once active count exceeds 2000 the audit covers <100% and the covered fraction keeps shrinking — un-auditable stale rows grow monotonically with corpus age. | high |
| **M3** | **`usageCount` measures RETRIEVAL, not USEFULNESS** — the self-retrieval bumps the counter *before* the entry is read or acted on (`heartbeat.ts:3925`, inside the retrieval loop, unconditional). `recordUsage` increments the instant an entry enters the candidate set, regardless of whether the model used, ignored, or was misled by it. The deeper defect beyond the popularity loop: **the signal is correctness-blind** — an entry the weak hash ranker keeps false-matching accrues the *highest* `usageCount` precisely because it is the *worst*-discriminated, and `runAutoDistill` nominates that exact entry for board promotion. The promotion pipeline is positively correlated with **ranker noise**, not truth. No signal anywhere (no thumbs-up, no "agent cited this", no outcome link) measures whether a retrieved entry helped. | `heartbeat.ts:3925`; `memory.ts:462-468,721-724` | Every run on every ticket fires self-retrieval and bumps the top-8 unconditionally; the bump rate grows linearly with ticket volume and team size, and the entries bumped most are the hash-64 false-neighbors — traffic growth launders ranker error into promotion signal. | high |
| **M4** | **`memory_usage.companyId` has NO foreign key to `companies`** (`memory_layers.ts:113`, confirmed bare `uuid().notNull()`), unlike `memory_entries.companyId` (`.references()` + cascade). It's the highest-volume tenancy surface, records cross-tenant `actorType`/`actorId`/`issueId`/`score`, and has the weakest schema-level scoping — exactly what a forgotten RLS policy or `BYPASSRLS` scanner reads cross-tenant. On company delete it does not cascade (orphaned usage still feeds promotion aggregates). | `memory_layers.ts:106-124` | `memory_usage` grows fastest of the three tables (superlinear in tenants × agents × tickets) and is the most likely to be under-protected when per-table RLS policies are authored. | high |
| **M5** | **Cross-lingual / near-synonym / word-order `subjectKey` misses make canonicalization, supersession, AND conflict-detection all silently fail** — the entire trust spine keys on `subjectKey`, but the only normalizer is `tokenize()` (`memory.ts:55-61`, confirmed: lowercase + strip punctuation, nothing else). "Staging DB host", "staging database hostname", "host of the staging db", and a Spanish/Hindi answer normalize to **different keys**, so: (a) the new fact does not supersede the old (2.3 stays open for paraphrases), (b) two disagreeing human-answers phrased differently never collide so they **never** enqueue for `needs_review` (2.4 — both pass as authoritative), (c) the `(companyId,source)` unique index only catches same-source re-fires. The weak hash embedder cannot do semantic near-dup detection either. | `memory.ts:55-61` | Subject phrasings diverge more as more humans (team scale) and more tickets re-ask in different words; multi-team/multi-company means different languages and house vocabularies. The collision rate for logically-identical facts **falls** as linguistic diversity rises, so missed-supersessions and undetected-conflicts grow with exactly the team/tenant scale the plan targets. | high |
| **M6** | **Prompt-cache poisoning** — a stale/superseded entry frozen into the provider prompt-cache *prefix* survives its own correction by up to the cache TTL. The composer places `'memory'` in the `cacheStable` tier (`composer.ts:158-167`, confirmed `'memory'` in `stableOrder`) specifically to win cache hits across wakes, so the rendered memory block becomes part of the cached prefix. If a fact is corrected/superseded/redacted in Postgres between two wakes, the next wake can still be served the **old** memory block from the provider cache because the stable prefix didn't bust — the DB correction does not propagate until the cache entry expires. "We fixed the fact" becomes "we fixed it but agents kept being told the old one for the cache lifetime." | `composer.ts:153-167` | The plan deliberately grows the stable/cached tier (skills, projects, handoff, passdown, standing — Phase 3) to maximize cache hit rate as context grows. The more aggressively memory is cache-stabilized for cost, the longer a corrected fact lingers in cached prefixes — **cost-optimization pressure (which rises with scale) directly widens the staleness window of injected memory.** | high |

## Weak-mitigation flags (do not over-trust these)

- **W1 — Scheduled decay/auto-distill wired into the heartbeat scheduler.** Necessary but **will not hold once the per-company active set exceeds `runDecayPass`'s `.limit(2000)` window** (M2). Scheduling more often does not help — each run still sees an arbitrary 2000-row physical slice. Without removing the cap, adding `ORDER BY updatedAt ASC`, and paginating, it gives a *false sense of cleanup* while the stale tail grows unbounded. **Fix the cap, don't just wire the scheduler.**
- **W2 — `subjectKey`-based supersession + conflict `needs_review` + `(companyId,source)` unique index.** Presented as the structural fix for the supersession hole and two-disagreeing-humans, but **all** key on `subjectKey = normalize(subject)` where `normalize` is only `tokenize()` lowercasing (M5). Looks fine at single-operator scale (one human, consistent phrasing); **detonates at team/multi-company scale** where phrasing diverges — exactly when relied on.
- **W3 — `requireVerified` retrieval filter as the *primary* anti-hallucination control, without a re-verification mechanism.** Flipping `requireVerified` (Phase 2) makes the verified set the *only* thing retrieved, but nothing re-checks a verified row (2.6; verified human-answer/pr-approval are TTL-exempt). It does not *reduce* hallucination at scale; it **concentrates** retrieval onto a monotonically-growing, never-re-examined verified set whose sources drift after `verifiedAt`. Guarantees freshness-at-capture, never freshness-now, and the gap widens with calendar time. **Must be paired with the re-verification job.**
- **W4 — Promotion-signal hardening via `COUNT(DISTINCT issue_id)`.** Better than raw count but still measures retrieval *breadth*, not *usefulness* (M3). An entry the weak ranker false-matches across many distinct issues scores high on distinct-issue reuse and gets promoted. Distinct-issue dedup removes self-retrieval-loop inflation but does nothing about *no signal measuring whether the retrieved entry helped or was even read*. **The real fix needs an outcome-feedback loop.**
- **W5 — Injection-resistant rendering (delimiters + "data not instructions").** Explicitly defense-in-depth but fundamentally unreliable at scale: an LLM can ignore any delimiter/caveat, and a body containing the closing delimiter defeats naive fencing unless HMAC/randomized per render. **Must never be counted as a control** — the only real controls are the write-gate + verified-only retrieval, and even those do not stop a *human-authored* injection the trust model stamps verified.
- **W6 — App-layer `companyId` scoping as the multi-tenant bridge.** Fine for single-operator, but it is `O(query-paths)` discipline with no DB backstop, and the codebase keeps adding query paths. The `authz.ts:25` empty-`companyId` bypass means one admin-scoped background job or mis-set tenant claim reads across tenants. **Cannot hold the moment a second company lands** — it is a bridge load-bearing for an unbounded number of as-yet-unwritten routes.

## Strongest mitigations (the load-bearing controls)

1. **Two-sided write-gate + `requireVerified` on BOTH retrieval channels** — the highest-leverage control because it is *structural not heuristic*: it bounds the blast radius of every downstream failure to the human-vetted set, and closing the parallel self-retrieval channel (`heartbeat.ts:3913`) is what makes governance real instead of cosmetic. Ship label-then-exclude.
2. **Real model embeddings + self-hosted pgvector ANN with `ORDER BY ... LIMIT k` pushdown** — fixes the root collision driver (1.1), eliminates the **critical** nondeterministic 500-row window (1.6), makes retrieval deterministic, and is the prerequisite that makes MMR/dedup/cross-encoder/near-dup actually work. **Must be paired with an `embedding_version` column + re-embed backfill (M1)** or the swap silently mis-scores the pre-cutover corpus.
3. **Postgres RLS (`SET LOCAL` in a per-request txn) + `BYPASSRLS` scheduler role** — the only DB-level fence for the multi-team decision; correctly handles the pgbouncer pinning hazard and prevents the fail-closed instance-wide outage.
4. **Idempotent `(companyId, source)` unique partial index + `onConflictDoNothing`** — kills unbounded duplicate proliferation at the root, protecting the promotion signal and the token budget. Cheap and deterministic; pair with `subjectKey` dedup for un-sourced/semantically-duplicate writes.
5. **Redaction/secret-scan gate as a BLOCKING prerequisite** before any human-answer/EM-note write to company-wide workspace — the single highest-risk secret-deposit path into the highest-trust, never-expiring, broadly-readable, verbatim-re-injected tier. Fail to `needs_review` on detection; run over existing bodies as a one-time pre-onboarding audit.

## Prioritized defense stack (build order)

1. **Two-sided trust gate FIRST** — write-side force-unverified for agent authors (`createEntry` + `routes/memory.ts:23` override) AND `requireVerified` on **both** retrieval channels (EM passdown AND the sub-agent self-retrieval at `heartbeat.ts:3913`). Roll out **label-only (Release N) then exclude (Release N+1)** to avoid starvation. The structural ceiling on hallucination blast radius — precedes everything else. Guard with a test asserting both channels reject unverified, plus a lint/grep gate around every `queryRanked` call site.
2. **Idempotent `(companyId,source)` upsert + secret/redaction write-gate** on human-answer/EM-note writes — cheap, deterministic, ship alongside the trust gate; they protect the promotion signal and stop the highest-trust tier accumulating secrets/duplicates before the corpus grows.
3. **Fail-closed app-layer `companyId` hardening** (throw on empty/undefined at the top of `assertCompanyAccess` for ALL principals incl. `local_implicit`/`isInstanceAdmin`, `authz.ts:25`) + a **CI cross-tenant isolation test suite** (company B cannot read A via every retrieval path; empty `companyId` rejected; the unscoped `memory_usage` path covered). The bridge fence before RLS and the regression net for the `SET`-vs-`SET LOCAL` hazard.
4. **Provenance-aware TTL + decouple recency from usage** (`recencyBoost` off `updatedAt`/truth-age not `lastUsedAt`, `memory.ts:110-116`) + promotion on `COUNT(DISTINCT issue_id)` excluding self-retrieval + **remove the `runDecayPass .limit(2000)` and `loadCandidates .limit(500)` nondeterministic windows** (add `ORDER BY` + pagination, M2/1.6). Breaks the popularity loop AND fixes the silent cleanup/candidate truncation operator discipline cannot overcome.
5. **Real model embeddings + self-hosted pgvector ANN** with `ORDER BY ... LIMIT k` pushdown, shipped **with** an `embedding_version`/`model`/`dim` column + re-embed backfill so the swap does not silently mis-score the pre-cutover corpus and `cosineSimilarity` (`memory.ts:73`) never dots vectors from two spaces (M1). Enables MMR/dedup/cross-encoder/near-dup. Gate behind a flag; keep the hash path as the deterministic test oracle.
6. **Postgres RLS** (`SET LOCAL` in a per-request txn) + **`BYPASSRLS` scheduler role** + **pgbouncer transaction mode** with explicit pool sizing under *our* `max_connections` — the DB-level multi-tenant fence, mandatory before the second company onboards, plus **add the missing FK + RLS policy on `memory_usage`** (`memory_layers.ts:113`, M4) so the highest-volume tenancy table is not the weakest-scoped one.
7. **Re-verification + observability LAST** as the residual-risk catch — periodic re-resolve of `sourceRefId` (PR reverted? issue deleted?) demoting drifted verified rows to `needs_review`; per-query provenance/confidence/age telemetry; the early-signal dashboards each cluster named. Does not prevent the irreducible residuals — makes them observable and bounds their dwell time, including the prompt-cache staleness window (M6).

---

# Honest residual-risk statement

> **We do not claim "zero hallucinations." We claim a layered defense with named residual risk and active monitoring.**

Even with the full stack shipped, hallucination risk is **reduced and bounded, never eliminated.** Three irreducible residuals remain:

1. **Human-verified-but-wrong.** The trust model treats human-sourced content as authoritative, but `getActorInfo` returns `actorType='user'` for `local_implicit` too (`authz.ts:46-51`), a human can paste an injection or a stale/incorrect fact, and nothing re-verifies a verified row after capture. A confidently-wrong human fact is **harder to dislodge** than a wrong agent-claim and is retrieved as ground truth until a human notices and reconciles. `requireVerified` *concentrates* this risk rather than removing it (W3).

2. **Staleness-after-capture.** Verified is freshness-**at-capture**, never freshness-**now**. With no re-verification job, no `embedding_version` tracking, a nondeterministically-windowed decay pass (`memory.ts:680`, M2), and deliberate prompt-cache-stable placement of the memory block (`composer.ts:158-167`, M6), a fact can be true when verified and false when retrieved — and the correction can lag by the prompt-cache TTL.

3. **Retrieval is approximate by construction.** ANN recall is <100%; `subjectKey` canonicalization is conservative-by-design (residual duplicates and missed cross-lingual/synonym supersessions persist, M5); the composer still tail-truncates (1.3). The correct-but-marginal entry can be silently absent or cut.

**The honest claim:** agent-fabricated claims are *quarantined* and cannot reach authoritative retrieval; the blast radius of any single bad entry is *bounded to one tenant* and (with rendering defenses + verified-only) *framed as data not instruction*. **But wrong-but-human-blessed and stale-but-once-verified content will still occasionally be surfaced as fact.** The system must ship with per-query provenance/confidence/age signals and an outcome-feedback loop so these residuals are **observable and correctable, not hidden.**

---

# Monitoring & guardrail metrics to watch as it grows

These are the instruments that convert the residual risks above from invisible to observable. Group by cluster; each has a **metric**, a **source**, and a **growth-alarm condition** (the threshold that means scale is starting to bite).

### Retrieval-degradation guardrails

| Metric | Source | Growth-alarm condition |
|---|---|---|
| Per-query semantic-score variance | `rankEntries` output, logged per query | Trending toward zero (hash-64 saturation, 1.1) |
| Distinct-`subjectKey` ratio within top-k | `queryRanked` items | Falling below ~0.5 (near-dup saturation, 1.2) |
| `memory` section `truncated`/`dropped` rate + token usage vs cap | context-budget telemetry (`composer.ts`) | Truncated rate rising; usage pinned at cap (1.3) |
| `usageCount` distribution skew (Gini / top-1% share) | `memory_entries.usageCount` | Increasingly skewed (popularity loop, 1.4) |
| `loadCandidates` candidate count hitting 500 | instrument `memory.ts:337` | Frequently at cap (1.6 nondeterminism active) |
| Active `memory_entries` per company | `SELECT count(*) ... status='active'` | Approaching/exceeding 500 (1.6) and 2000 (M2) |
| **Eval-harness recall@k** (does the known-correct entry appear?) | offline eval set replayed per deploy | Dropping below 100% (1.6 / M1) |
| Repeated-identical-query determinism | replay same query N times | Different top-k across runs (1.6 confirmed) |
| Distinct `embedding_version` count among active rows | `embedding_version` column (M1, once added) | >1 without a backfill in progress (M1 mixed spaces) |

### Fact-lifecycle guardrails

| Metric | Source | Growth-alarm condition |
|---|---|---|
| **Days since last `runDecayPass` per company** | activity log / `memory_promotions` | Climbing unbounded (2.1) |
| Active entries with `updatedAt` > 90d and no decay in that window | `memory_entries` + activity log | Rising fraction (2.1) |
| **Gap between `lastUsedAt` (recent) and `updatedAt` (old) on top hits** | per-retrieval log | Widening (2.2 recency-by-retrieval masking truth-age) |
| Entries with `usageCount>10 AND updatedAt>120d` | `memory_entries` | Growing (2.2 popular-stale, immune to cleanup) |
| Active entries sharing a normalized `subjectKey` with divergent bodies | `GROUP BY subjectKey HAVING count(distinct body)>1` | Rising (2.3 supersession holes) |
| Verified human-answers conflicting on one `subjectKey` / `needs_review` queue depth | conflict detector / queue | Non-zero and growing (2.4) |
| `count(*) GROUP BY (companyId, source) HAVING count(*)>1` | `memory_entries` | Any value >1 today (2.5 duplicates) |
| **`verifiedAt` age distribution** + verified entries whose `sourceRef` no longer resolves | `memory_entries` + source resolver | Old-`verifiedAt` mass growing; any unresolved ref = confirmed rot (2.6) |
| Decay-pass coverage ratio (rows evaluated ÷ active rows) | instrument `runDecayPass` | < 100% (M2 — the 2000-cap blind spot) |

### Adversarial / trust guardrails

| Metric | Source | Growth-alarm condition |
|---|---|---|
| Injected entries whose body contains instruction-shaped tokens | render-time scan at `heartbeat.ts:3934` | Any non-zero (3.1 stored injection) |
| `usageCount` vs `COUNT(DISTINCT issue_id)` gap on promotion candidates | `memory_usage` aggregate | Large gap = inflation, reject as promotion signal (3.2 / M3) |
| Self-retrieval `queryRanked` call sites omitting `requireVerified` | CI lint/grep around `heartbeat.ts:3913` | Any (3.3 parallel-channel hole) |
| Bodies matching secret-shape regex at write | write-time scan in `createEntry` | Any hit (3.4 secrets) |
| Verify actions per principal per window; verified rows with single `verifiedBy` + null `sourceRefId` | audit log | Spike per principal; verified-without-ref (3.5) |
| Outcome-feedback signal (did the agent cite / did the run succeed when this entry was injected?) | new outcome link (closes M3) | Low or absent = promotion signal is correctness-blind |

### Tenant / scope guardrails

| Metric | Source | Growth-alarm condition |
|---|---|---|
| **Cross-tenant isolation test** (agent of A receives any row `company_id != A`) | CI gate, every retrieval path | Non-empty = leak (4.1) |
| Same-actor query returning different row sets under concurrent multi-tenant load | interleaved integration test on a pooled connection | Divergence = `SET`/`SET LOCAL` pinning leak (4.2) |
| Requests reaching `assertCompanyAccess` with empty/undefined `companyId` not throwing | fuzz test per principal type | Any 200 instead of 400/403 (4.3) |
| Heartbeat enqueue count after enabling RLS in staging | scheduler metrics | Drops to zero instance-wide = fail-closed (4.4) |
| p95 `queryRanked` latency by `company_id`; low-score entries crossing the injection threshold per tenant | per-tenant retrieval metrics | Sharp divergence (4.5 volume imbalance) |
| pgvector top-k containing foreign `company_id` (pre-filter) | ANN isolation test | Any (4.6 shared-embedding leak) |
| `memory_usage` rows without a valid `companyId` / orphaned after company delete | integrity scan | Any (M4 — missing FK) |

### Cross-cutting

| Metric | Source | Growth-alarm condition |
|---|---|---|
| **Per-query provenance / confidence / age telemetry** surfaced with every injected entry | render path + retrieval | The baseline observability that makes residuals visible — ship it before scaling |
| Prompt-cache staleness window (time between a DB correction and the next non-cache-hit wake that reflects it) | correlate `updatedAt` vs cache-bust events | Widening as the cache-stable tier grows (M6) — bound the dwell time |

---

*All `file:line` references verified against the live repo while writing this document. Severity is growth-adjusted. Mitigation calls honor the four locked decisions: self-hosted Postgres, strict human-gated trust rolled out label-then-exclude, RLS-required-before-team-onboarding multi-tenancy, and Postgres + the ADE memory UI as the single system of record.*