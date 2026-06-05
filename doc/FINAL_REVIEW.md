# FINAL REVIEW — `central-db` whole-branch audit

**Scope:** cross-PR seams + production-readiness of the central context DB feature
(17 PRs + dedicated context DB + cross-company global layer + RLS), all merged on
branch `central-db`. This is a **whole-branch** audit, not a per-PR review — the focus
is the seams between PRs that single-PR review cannot see. Baseline: `pnpm test:run`
985 green, ui 25, typecheck clean.

**Verdict: `ship-with-fixes`.** The runtime agent-injection trust spine (the thing
that actually matters — what reaches a live agent as authoritative) is **sound**: both
heartbeat self-retrieval (`heartbeat.ts:4185`) and EM passdown (`em-passdown.ts:172`)
enforce `requireVerified: true`, the write-gate (`memory.ts:564-571`) force-quarantines
agent-authored content, and per-company isolation holds on workspace/shared/personal.
But the **cross-company global layer is a half-wired, unaudited, trust-launderable
sub-system** with one confirmed blocker and a cluster of correlated majors, and there is
a real **cross-version embedding scoring hole** reachable on any in-place-upgraded
instance. None of these is a live agent-facing hallucination today, but each is a loaded
gun: the moment the documented global-injection wiring is fixed (it is a stated intent),
the trust-laundering blocker becomes a live cross-company hallucination vector.

---

## Per-dimension verdicts

| Dimension | Verdict | One-line |
|---|---|---|
| End-to-end flow (HOOK1/HOOK2 → entry → retrieval → passdown) | **solid** | Producer/consumer shapes agree exactly across all three packet consumers; one first-wake race (major). |
| Trust / hallucination | **gaps** | Runtime spine closed; **global-promotion launders trust (BLOCKER)** + API surface is fail-open + the CI lint built to catch this is cosmetic. |
| Tenancy / 2-DB / global / RLS | **gaps** | Per-company isolation sound; the **entire global layer is unreachable, non-idempotent, and ETL-corruptible**; RLS authored but dormant. |
| Embeddings | **gaps** | Redact-before-embed enforced; **null-version legacy rows cross-score (major)** + operator EMBEDDING_DIM silently dark-ANN. |
| Build readiness | **solid** | `pnpm -r build` + `typecheck` clean; migrations 0048-0055 consistent; no deploy landmines. |
| UI wiring | **solid** | 8 tabs map cleanly to real routes; **global layer has zero UI surface (major)**. |

### Strengths worth banking
- **Dual-channel §5.3 fix is genuinely closed.** The EM passdown packet AND the sub-agent
  self-retrieval are both `requireVerified: true`, and the self-retrieval is not gated by
  `focused_small`, so both vetted channels survive small tickets. An unverified agent-claim
  cannot reach an agent as authoritative on either runtime path.
- **Write-gate is enforced from the actor, not the body** (`memory.ts:564-571`): `authorType`
  is set by the route/hook from the principal, and agent + non-trusted-provenance is forced to
  `agent-claim`/`unverified`/conf ≤ 0.4. An agent literally cannot author a verified row.
- **Conflict/supersession cannot be weaponized.** `resolveConflict` is board-only, re-derives
  the live group restricted to `human-answer`, and `supersededById` is never agent-settable.
  `PROVENANCE_PRECEDENCE` + `requireVerified` removing unverified rows before dedup means an
  agent-claim can never be elevated over verified content.
- **Redact-before-embed** runs on every provider egress (`scanBody` before every `driver.embed`),
  enforced by a real, non-vacuous, planted-bypass-tested lint merge gate.
- **2-DB routing is clean:** all memory reads/writes resolve through `resolveContextDb(db)`
  (memoized per URL); the handoff packet is correctly snapshotted out of the context DB into
  main-DB jsonb at delegate time, needing no cross-DB join.
- **ANN-empty-falls-through-to-lexical** (`memory.ts:801-819`) prevents a pre-backfill
  dark-retrieval blackout — a genuine cross-PR correctness save.

---

## CONFIRMED BLOCKER

### B1 — Trust-laundering via global promotion (verified-stamp with no source-verification check)

**Location:** `server/src/services/memory.ts:1293-1326` (`createGlobalFromEntry`);
route `server/src/routes/memory.ts:152-178`.

`createGlobalFromEntry` guards only that `source.layer` is `workspace`/`shared`
(line 1303) and then **unconditionally** stamps the promoted row
`provenance: "verified-summary", verificationState: "verified", confidence: 0.9`
(lines 1320-1322). It **never checks `source.verificationState`.** Because the write-gate
(`memory.ts:564-571`) forces any agent-authored workspace entry to
`agent-claim`/`unverified`, an instance-admin can promote an **unverified agent-claim** and
mint a **VERIFIED, cross-company GLOBAL** row. The route (line 156) gates only on
`assertInstanceAdmin` — "promote" is not "verify the claim."

The intent is documented and unenforced: the route doc-comment (`routes/memory.ts:149`)
says *"Promote an existing verified workspace/shared entry"*, and the sibling curated-pin
path **does** enforce it — `em-passdown.ts:207` drops any pin where
`entry.verificationState !== "verified"`. `createGlobalFromEntry` is the one promotion path
that skips that check.

**Blast radius today is narrowed** by major M2 (global is unreachable on every agent-facing
retrieval path), so the laundered row is currently injected to **no** agent. But it is already
visible/authoritative through any unscoped manifest/raw query, and the moment the documented
global-injection wiring lands, this is a live cross-company hallucination vector. The verified
stamp and the promote API are both real now.

**Fix:** add a source-verification guard immediately after the layer guard, mirroring
`em-passdown.ts:207`:

```ts
if (source.layer !== "workspace" && source.layer !== "shared") {
  throw new Error("only workspace/shared entries can be promoted to global");
}
if (source.verificationState !== "verified") {
  throw new Error("only verified entries can be promoted to global");
}
if (source.supersededById) {
  throw new Error("a superseded entry cannot be promoted to global");
}
```

Return a 400 from the route on this throw (the handler already maps `Error` → 400 at
`routes/memory.ts:166-170`).

---

## CONFIRMED MAJORS

### M1 — Cross-version cosine scoring hole on null-`embedding_version` legacy rows
**Location:** `memory.ts:120-128` (guard), `:280` (rankEntries call), `:822-830` (unfiltered
jsonb load); `packages/db/src/migrations/0049_memory_trust_spine.sql:24`;
`0040_memory_layers.sql` (legacy hash embedding).

The version-guard only fires when **both** versions are non-null (the condition requires
`versionB !== null`, lines 123-124). A legacy row with `embedding != null` and
`embedding_version = NULL` falls through and is dotted against a 1536-dim real-model query over
`min(64, 1536) = 64` dims — a valid-but-meaningless score **identical in magnitude** to a true
same-version match. Reachable: migration 0040 populated 64-dim hash `embedding`; 0049:24 added
`embedding_version` as NULLABLE with **no backfill UPDATE**; the jsonb load (`memory.ts:822-830`)
has no `embedding_version` filter; and the ANN-empty fall-through routes a not-yet-backfilled
corpus straight into this jsonb ranker (`rankEntries:280`). No test covers null-version vs
real-version. The ANN path itself is safe — it filters `embedding_version = queryEmbedding.version`.

**Fix:** in `cosineSimilarity`, treat a null entry-version as the hash version when the query
version is a real version, so they refuse to cross-score:

```ts
const vb = versionB ?? "hash-64:64"; // legacy rows are hash-era
if (versionA != null && versionA !== vb) return 0;
```

Belt-and-suspenders: add a backfill `UPDATE memory_entries SET embedding_version = 'hash-64:64'
WHERE embedding IS NOT NULL AND embedding_version IS NULL` and a test asserting
null-version-vs-real-version scores 0.

### M2 — Cross-company GLOBAL layer is unreachable on every agent-facing path
**Location:** `memory.ts:774,777-778`; `heartbeat.ts:4168`; `em-passdown.ts:77-79`;
test `central-db-integration.test.ts:229,235`.

`loadCandidates` unions global via `(company_id=$id OR layer='global')` (line 774) but then
ANDs `inArray(layer, opts.layers)` (line 778), which masks the OR-global arm whenever `layers`
omits `global`. Both production agent-facing callers omit it: heartbeat self-retrieval passes
`["workspace","shared","personal"]` (`heartbeat.ts:4168`) and every passdown tier is
`["shared"]`/`["shared","workspace"]` (`em-passdown.ts:77-79`). An instance-admin-authored global
convention is **never** injected into any agent run. Integration test G1 gives false confidence —
it calls `queryRanked` with **no** `layers` option, exercising the service capability but not the
production wiring that hard-excludes global.

**Fix:** make `global` always survive the layer filter — change the layer predicate so it is an
OR with `layer = 'global'` rather than a flat `inArray`:

```ts
if (opts.layers?.length) {
  filters.push(or(inArray(memoryEntries.layer, opts.layers), eq(memoryEntries.layer, "global")));
}
```

Mirror this in `loadCandidatesByVector` (`memory.ts:868`). Add an integration test that calls
`queryRanked` with an explicit `layers` array omitting global and asserts the global row IS
returned. (Note: fixing M2 makes B1 live — fix B1 first/together.)

### M3 — Global-layer idempotency is broken (duplicate global rows on re-promote)
**Location:** `memory.ts:613-643,1319`; `0049_memory_trust_spine.sql:27`.

The dedup unique index is `(company_id, source) WHERE source IS NOT NULL` (0049:27). Global rows
carry `company_id = NULL`, and Postgres treats NULLs as **distinct** in a unique index, so two
global writes with the same `source` never collide → `onConflictDoNothing` never fires.
`createGlobalFromEntry` stamps `source = global-promotion:${source.id}` (`memory.ts:1319`) with no
pre-existence probe, so re-promoting the same source mints **duplicate** global rows; the
NULL-company re-select branch (`memory.ts:634-643`) then returns an arbitrary duplicate.

**Fix:** add a partial unique index for the global case
(`CREATE UNIQUE INDEX ... ON memory_entries (source) WHERE company_id IS NULL AND source IS NOT NULL`)
in a new migration, and add an explicit pre-existence probe in `createGlobalFromEntry` before
insert (select `isNull(companyId) AND source = ...` and return the existing row if present).

### M4 — ETL import re-stamps global rows into a company; per-company export drops globals
**Location:** `memory-etl.ts:57-68,212`.

`importBundle` unconditionally writes `companyId: opts.companyId` onto **every** inserted row
(`memory-etl.ts:212`), including `layer='global'` rows from a full-instance export. The result is a
hybrid `layer='global' AND company_id != NULL` row that matches **both** arms of the
`(company_id=X OR layer='global')` union — leaking into company X's scope AND treated as
cross-company global. Conversely a per-company export (`companyId=X`) silently **drops** all global
rows because `eq(companyId, X)` (`memory-etl.ts:58`) excludes NULL.

**Fix:** in `importBundle`, special-case global rows —
`companyId: row.layer === "global" ? null : opts.companyId`. In `buildExportBundle`, when
`companyId` is provided, additionally UNION the global rows
(`OR layer = 'global'`) so a per-company export carries the globals its rows depend on (or document
that per-company exports are intentionally global-free and require a separate global export).

### M5 — Agent-reachable HTTP query/manifest/list/get routes are fail-open (no `requireVerified`)
**Location:** `routes/memory.ts:335` (query), `:361` (manifest); `routes/authz.ts:37-39`;
`memory.ts:438-443` (default false); `scripts/lint-queryranked-callsites.mjs:217-230`.

`assertCompanyAccess` admits any agent for its own `companyId` (`authz.ts:37-39`).
`POST /companies/:id/memory/query` (`routes/memory.ts:335`) and `GET /memory/manifest` (`:361`)
call `queryRanked`/`buildManifest` with **no** `requireVerified`, and `QueryOptions` defaults it to
`false`. So an agent holding its own `agent_key` can pull unverified `agent-claim` bodies directly
with **no** "UNVERIFIED" label (that label is added only by the heartbeat render path, not by the
route JSON). The two runtime injection paths DO opt in, so the spine holds there — but the "EVERY
path" guarantee is unmet at the API surface. The lint that claims to gate this only checks
`argc >= 3` (`:217-230`); it never inspects `requireVerified`, so `memory.ts:335` passes lint
cleanly (`✓ 4 call site(s) checked`). Live exploitability depends on agent-harness wiring outside
this branch (no in-repo agent caller), so this is a surface/defense-in-depth gap, not a confirmed
live leak.

**Fix (defense-in-depth, recommended fail-closed):** flip `QueryOptions.requireVerified` to default
**true** and have the human-facing Browse/Verify routes opt OUT explicitly; OR, minimally, add
`requireVerified: actor.type === "agent"` at `routes/memory.ts:335` and `:361`. Then extend the
lint to parse the opts literal and fail when an agent-reachable call site omits `requireVerified`.

### M6 — Global memory layer has ZERO UI surface (unviewable, unauditable, uncuratable)
**Location:** `ui/src/pages/memory/MemoryBrowse.tsx:148-152`; `ui/src/api/memory.ts` (no global
method); `server/src/services/memory.ts:733,1311`.

Global entries are stored `companyId = null` (`memory.ts:1311`), but `listEntries` (the Browse
reader) filters `eq(companyId, opts.companyId)` against a concrete UUID (`memory.ts:733`) — null
never matches, so global rows are invisible in Browse for every company. The Browse Layer dropdown
offers only workspace/personal/shared (`MemoryBrowse.tsx:148-152`), and `memoryApi` has no global
method (verified: grep for `global` in `ui/src/api/memory.ts` returns nothing). An operator cannot
view, audit, or curate global facts from the 8-tab UI. Combined with M2, the global layer is
functionally inert AND unauditable.

**Fix:** add a global-aware path to `listEntries` (when `layer === 'global'`, filter
`isNull(companyId)` instead of `eq(companyId)`), add a `global` option to the Browse Layer dropdown
and the route whitelist (`routes/memory.ts:213`), and add `promote`/`listGlobal` methods to
`memoryApi`. Gate the global view/promote UI behind the existing instance-admin probe.

### M7 — Delegate-time first-wake race on the vetted passdown packet
**Location:** `routes/issues.ts:1277` (`void createHandoff`), `:1296` (`await wakeup`);
`agent-handoff.ts:186,218`; `heartbeat.ts:4034,5349`.

`createHandoff` is fired with `void` (un-awaited) at `issues.ts:1277`, then `heartbeat.wakeup` is
awaited ~20 lines later (`:1296`). `createHandoff` runs `buildPassdownPacket` (embedding +
`queryRanked` + an N+1 `getEntry` loop) at `agent-handoff.ts:186` BEFORE inserting the
`agent_handoffs` row at `:218`. On the real embedder path this is hundreds of ms, so the concurrent
wakeup's heartbeat run can read `getPendingHandoffBrief` (`heartbeat.ts:4034`) before the row
exists and inject no passdown context. **Not permanent data loss** — the row stays unconsumed until
`markHandoffConsumed` (`heartbeat.ts:5349`, run end on success), so a missed first read recovers on
a later wake, and the `requireVerified` self-retrieval still fires. But the EM-curated/pinned vetted
context — the thing that matters most on the sub-agent's FIRST run — can be absent on that first run.

**Fix:** `await createHandoff(...)` before `heartbeat.wakeup(...)` (the handler is already async),
so the row is committed before the wake dispatches. If the latency is a concern, build the packet
inside a transaction that inserts the row first, or have `wakeup` no-op when no handoff brief is yet
present and re-trigger on packet insert.

---

## Residual risks (not blocking, track post-merge)

1. **RLS is authored but DORMANT (documented no-op today).** `rls-scope.ts:27-29` self-states it
   is not wired; 0055 uses ENABLE not FORCE so the owner-connected app bypasses all policies;
   `withCompanyScope` has zero production callers (verified). The "RLS provides defense-in-depth"
   claim is FALSE today — isolation rests entirely on app-layer `assertCompanyAccess` + `eq(companyId)`
   SQL (which ARE sound for non-global layers). The `OR company_id IS NULL` arms on
   `memory_promotions`/`memory_usage` (0055:61-67) are dead branches (those columns are NOT NULL).
   Latent until the FORCE flip at team onboarding, at which point every request boundary must thread
   through `withCompanyScope`.
2. **Operator EMBEDDING_DIM not reconciled with `vector(1536)`.** `config.ts` accepts any positive
   dim; 0052 hardcodes `vector(1536)`. A non-default dim (e.g. 3072) makes `writeVectorColumns`
   throw a swallowed dimension error → `embedding_vec` universally NULL → ANN permanently dark while
   `versionCoveragePct = 1.0` reports falsely green. Default 1536 is safe. Add a startup assertion
   tying `embeddingDim` to the column width, or log a warning on the swallowed vector write.
3. **Global entries accumulate zero usage/reuse stats** — `memory_usage.company_id` is NOT NULL and
   `recordUsage` skips the insert when `companyId` is null (`memory.ts:1047`); the verifyQueue reuse
   count is company-filtered, so global reuse is always 0. Compounds the global inertness.
4. **`complexity` defaulted to `'small'` on 2 of 3 `createHandoff` producers** (reassignment, QA),
   yielding shared-only passdown. Not a break (receiver self-retrieval still fires) but an
   inconsistent default across the three producers of the same artifact.
5. **Small-tier channel asymmetry:** HOOK 1 writes the human answer to `layer='workspace'`
   (`issues.ts:1139`) but the small passdown tier retrieves `['shared']` only, so a small delegate's
   packet structurally cannot carry the human answer — recovered only via heartbeat self-retrieval.
   Producer/consumer layer disagreement masked by a redundant path.
6. **Type-vs-route divergence:** `GET /companies/:id/memory/entries` (`routes/memory.ts:213`)
   whitelists only workspace/personal/shared, coercing `layer=global` to undefined (full unfiltered
   list) rather than honoring it, while the shared `MemoryLayer` type permits `'global'`.
7. **Reembed backfill discards `redactedFindings`** (`memory-reembed.ts:115-141`) — a hash-era entry
   whose body newly trips the secret scanner during backfill is NOT re-quarantined, diverging from
   every live write path. Egress safety is intact (`scanBody` still redacts before embed); this is a
   retrieval-visibility gap, narrow because the hash path never scanned at write time either.
8. **UI bundle advisory** (main chunk 3.06MB, gzip 866kB, Rollup >500kB warning) — pre-existing, not
   introduced by this branch, but a standing deploy-size concern for the server-served artifact.

---

## Refuted (claims checked and found NOT to be problems)

- **Runtime agent-injection trust spine is sound** — both `heartbeat.ts:4185` and
  `em-passdown.ts:172` enforce `requireVerified: true` (+ `excludeSuperseded`, + minConfidence +
  personal-drop + verified-only curated-pin on passdown). The §5.3 dual-channel fix is genuinely
  closed.
- **Per-company isolation holds on workspace/shared/personal** — `loadCandidates`,
  `loadCandidatesByVector`, and `listEntries` all scope strictly to `company_id`; only the global
  arm is cross-company by design; `assertCompanyAccess` is fail-closed and rejects agents crossing
  companies. Integration test G3 proves no cross-company workspace leak.
- **The cosine guard works for explicit-version mismatches** (e.g. hash-64 vs API) — returns 0 when
  both versions are non-null and differ. The hole is ONLY the null-version legacy case (M1). The ANN
  pushdown path also filters `embedding_version = query.version`, so only the jsonb fallback is
  exposed.
- **Conflict/supersession cannot be weaponized** — board-only `resolveConflict`, group re-derived to
  `human-answer`, `supersededById` never agent-settable, `excludeSuperseded` defaults fail-closed.

---

## Production-ready verdict: `ship-with-fixes`

The feature is architecturally sound where it counts — the live agent-injection trust spine, the
write-gate, per-company isolation, redact-before-embed, and the build are all solid. **B1 (global
trust-laundering) must be fixed before merge** — it is a one-line guard and the cost of shipping it
latent is a future live cross-company hallucination the day global injection is wired. M1 (cross-
version scoring) and M2-M4 (the global layer's unreachability/idempotency/ETL trio) should land
together because they are one coherent "the global layer is half-built" story and fixing M2 in
isolation activates B1. M5-M7 are defense-in-depth/UX/race hardening that can follow in a fast
follow-up but should not be deferred indefinitely. RLS dormancy is acceptable **only** if the
production-readiness claims stop asserting RLS provides isolation today.
