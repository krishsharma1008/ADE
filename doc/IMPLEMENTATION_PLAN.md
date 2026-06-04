# Central Context DB — Implementation Plan (PR-by-PR)

> Execution-ready slices derived from the doc/ plans. Each slice = one PR: build → critique → test, landed only when its **test gate** is green. Companion: `CENTRAL_CONTEXT_DB_PLAN.md`, `MEMORY_UI_AND_QUALITY_PLAN.md`, `TEST_PLAN_SCENARIOS.md`.

## How we build

Each slice is implemented on `feat/central-context-db`, reviewed by an adversarial critic (codex/critic), and must pass its **test gate** before the next dependent slice starts. Phase order: DB foundation (PR-1,2,3) → write-paths (PR-4,5) → render/ETL/scope (PR-6,7,8) → passdown+gate (PR-9,10) → embeddings+quality (PR-11,12) → UI (PR-13..16) → multi-team RLS hard gate (PR-17).

## Dependency order

```
PR-1   (start here)  — Migration 0048: owner_id uuid→text + relax validators
PR-2   needs PR-1  — Migration 0049 trust spine + WRITE-side force-unverified gate + subjectKey + idempotent (companyId,source)
PR-3   needs PR-2  — Retrieval-side requireVerified/minConfidence/excludeSuperseded on the canonical queryRanked, applied to BOTH heartbeat self-retrieval AND passdown call sites
PR-4   needs PR-2  — HOOK 1: human-answer capture (load question comment, redaction gate, assumption-flag trust)
PR-5   needs PR-2  — HOOK 2: deterministic EM PR-approval capture (no LLM)
PR-6   needs PR-3  — Render citations + UNVERIFIED label + non-executable fence (label-only, defense-in-depth)
PR-7   needs PR-2  — Memory ETL export/import scripts + refuse-on-empty cutover guard
PR-8   needs PR-1  — Migration 0051: issues.service_scope
PR-9   needs PR-3,PR-8  — EM passdown packet (artifactRefs) + size tiering + dual-channel verified filter
PR-10  needs PR-2,PR-8  — Sufficiency gate shipped DARK (no-op, telemetry only)
PR-11  needs PR-2,PR-3,PR-4  — Embeddings: migration 0052 pgvector + embedding-driver + redact-before-embed + version-guard + rankEntries query-embed lift
PR-12  needs PR-11  — Retrieval-quality eval harness (recall@k / MRR, hash oracle in CI + opt-in live tier)
PR-13  needs PR-2  — Memory UI Phase 1: tabbed shell + Browse with trust badges + DesignGuide section (label-only)
PR-14  needs PR-4,PR-5,PR-13  — Memory UI Phase 1b: Capture + Verify + Conflicts tabs (the explicit user ask) + board routes
PR-15  needs PR-11,PR-13  — Memory UI Phase 2: Setup + Redaction tabs (ship WITH the embedding swap) + privacy disclosure
PR-16  needs PR-9,PR-14  — Memory UI Phase 3: Questions + Passdown tabs + delegate-dialog MemoryPassdownPicker
PR-17  needs PR-2,PR-9  — Phase-4 gate: migration 0053 RLS + BYPASSRLS scheduler role + SET LOCAL middleware + cross-tenant isolation suite
```

---

## PR-1 — Migration 0048: owner_id uuid→text + relax validators

**Phase:** Phase 1 (trust spine, still embedded)  
**Depends on:** —  
**Risk:** Low. Type-widening ALTER is forward-safe; the only hazard is an owner_id comparison that assumed uuid — grep-confirmed none. Embedded test rig has no data so the USING cast is a no-op there.

**Files:**
- `packages/db/src/migrations/0048_memory_owner_id_text.sql`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/memory_layers.ts`
- `packages/shared/src/validators/memory.ts`
- `server/src/services/__tests__/memory-service.test.ts`

**What to build:**

Add migration 0048 widening memory_entries.owner_id from uuid to text and rebuilding the owner index. The SQL: DROP INDEX memory_entries_owner_idx; ALTER TABLE memory_entries ALTER COLUMN owner_id TYPE text USING owner_id::text; CREATE INDEX memory_entries_owner_idx ON memory_entries (company_id, owner_type, owner_id). Append the 0048 entry to meta/_journal.json (idx 48, version '7', breakpoints true) mirroring the 0047 row. In schema/memory_layers.ts:37 change ownerId from uuid('owner_id') to text('owner_id'). In packages/shared/src/validators/memory.ts relax the three ownerId zod uses (createMemoryEntrySchema :21, memoryQuerySchema :57, memoryManifestQuerySchema :67) from z.string().uuid() to z.string().min(1).max(128). Pre-flight grep for eq(memoryEntries.ownerId, <uuid>) call sites to confirm no uuid-typed comparison breaks (none expected — comparisons pass strings).

**Acceptance criteria:**
- [ ] pnpm db:migrate applies 0048 cleanly against a fresh embedded Postgres and meta/_journal.json lists tag 0048_memory_owner_id_text
- [ ] memory_entries.owner_id column type is text; memory_entries_owner_idx exists on (company_id, owner_type, owner_id)
- [ ] Creating a personal entry with a non-uuid ownerId (e.g. 'local-board') succeeds via createEntry and via POST /companies/:companyId/memory/entries
- [ ] memory-ranker.test.ts still passes unchanged (no embedText/ranker behavior touched)
- [ ] A new test asserts a user/agent cannot read another principal's personal entry through queryRanked owner-scoping

**Test gate (must pass to land):**
- `pnpm --filter @combyne/db migrate`
- `pnpm test:run -- memory-service memory-ranker`

---

## PR-2 — Migration 0049 trust spine + WRITE-side force-unverified gate + subjectKey + idempotent (companyId,source)

**Phase:** Phase 1 (trust spine, still embedded)  
**Depends on:** PR-1  
**Risk:** Medium. Largest schema change; backfill UPDATE must use the exact LIKE patterns. The write-gate must key on the actor-derived authorType not request body — a missed override leaks agent-verified. The unique partial index will reject any pre-existing duplicate (companyId,source) — none expected in embedded rig but verify on real dogfood DB before applying.

**Files:**
- `packages/db/src/migrations/0049_memory_trust_spine.sql`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/memory_layers.ts`
- `packages/db/src/schema/agent_memory.ts`
- `server/src/services/memory.ts`
- `server/src/routes/memory.ts`
- `server/src/routes/authz.ts`
- `server/src/services/accepted-work.ts`
- `packages/shared/src/types/memory.ts`
- `packages/shared/src/validators/memory.ts`
- `server/src/services/__tests__/memory-service.test.ts`

**What to build:**

Migration 0049 adds to memory_entries: provenance text, verification_state text NOT NULL DEFAULT 'unverified', confidence real NOT NULL DEFAULT 0.5, author_type text, author_id text, source_ref_type text, source_ref_id uuid, subject_key text, superseded_by_id uuid (self-FK), verified_by text, verified_at timestamptz, embedding_version text. Indexes: memory_entries_trust_idx (company_id, layer, verification_state, confidence); memory_entries_subjectkey_idx (company_id, subject_key); CREATE UNIQUE INDEX memory_entries_company_source_uniq ON memory_entries (company_id, source) WHERE source IS NOT NULL. Mirror the subset (provenance, author_type, confidence, verification_state) onto agent_memory. Backfill per CENTRAL_CONTEXT_DB_PLAN §3.5: source LIKE 'promotion:%' → verified-summary/verified/0.9; layer='shared' → verified; source LIKE 'accepted_work:%' → agent-claim/agent/unverified; else → agent-claim/unverified. Update meta/_journal.json (idx 49). In memory_layers.ts + agent_memory.ts add the drizzle columns. In memory.ts: extend CreateEntryInput with provenance/verificationState/confidence/authorType/authorId/sourceRefType/sourceRefId; compute subjectKey via the existing tokenize() (conservative, document it under-merges); WRITE-side gate — when authorType==='agent' and provenance NOT IN ('human-answer','pr-approval') force verificationState='unverified' and confidence<=0.4 regardless of input; make createEntry an onConflictDoNothing upsert on (companyId, source) that re-selects the existing row on conflict (idempotent). In routes/memory.ts:23-52 derive authorType from actor (agent vs board) and pass through; for agent actors override provenance/verificationState/confidence and reject any attempt to set verificationState='verified' or provenance IN ('human-answer','pr-approval') unless assertBoard passes. Tag accepted-work.ts:372 createMemoryFromEvent write with provenance:'agent-claim', authorType:'agent', verificationState:'unverified'. Extend MemoryEntry type + rowToEntry to surface the new fields.

**Acceptance criteria:**
- [ ] pnpm db:migrate applies 0049; all new columns + 3 indexes + the partial unique index exist; agent_memory has the 4 mirrored columns
- [ ] Backfill: a pre-existing layer='shared' row reads verification_state='verified'; a source LIKE 'accepted_work:%' row reads provenance='agent-claim'/unverified; a source LIKE 'promotion:%' row reads verified-summary/0.9
- [ ] An agent-actor createEntry requesting verificationState='verified' lands as unverified with confidence<=0.4 (write-gate proven by test)
- [ ] Two createEntry calls with the same (companyId, source) yield exactly one row (idempotent upsert proven by test); the second returns the existing row
- [ ] subjectKey is populated and stable for identical subjects; documented as conservative/under-merging
- [ ] memory-ranker.test.ts unchanged-green (ranker untouched)

**Test gate (must pass to land):**
- `pnpm --filter @combyne/db migrate`
- `pnpm test:run -- memory-service accepted-work agent-memory`

---

## PR-3 — Retrieval-side requireVerified/minConfidence/excludeSuperseded on the canonical queryRanked, applied to BOTH heartbeat self-retrieval AND passdown call sites

**Phase:** Phase 1 (label-only retrieval; flip is Phase 2)  
**Depends on:** PR-2  
**Risk:** Medium. Must NOT flip requireVerified=true yet (would empty the preamble pre-backfill — the starvation failure). Conflict resolution by subjectKey is conservative; document it under-detects paraphrases. The lint gate must allowlist legitimate call sites or it blocks CI.

**Files:**
- `server/src/services/memory.ts`
- `server/src/services/heartbeat.ts`
- `packages/shared/src/validators/memory.ts`
- `server/src/services/__tests__/memory-service.test.ts`
- `server/src/services/__tests__/memory-ranker.test.ts`
- `scripts/lint-queryranked-callsites.mjs`
- `package.json`

**What to build:**

Define the ONE canonical QueryRankedOpts signature (MEMORY_UI_AND_QUALITY_PLAN §0.3): extend QueryOptions in memory.ts with minConfidence?:number (default undefined=no floor), requireVerified?:boolean (default false), excludeSuperseded?:boolean (default true). In loadCandidates (memory.ts:322-337): add filters — when requireVerified, eq(verificationState,'verified'); when minConfidence set, gte(confidence,minConfidence); when excludeSuperseded, isNull(supersededById). Keep the .limit(500) for now (ORDER BY fix is a later quality slice) but apply an ORDER BY (updatedAt desc) to make the window deterministic. Add deterministic conflict resolution: group ranked hits by subjectKey, winner by precedence human-answer>pr-approval>verified-summary>agent-claim then recency, drop losers. Apply the new opts to BOTH retrieval channels: heartbeat self-retrieval at heartbeat.ts:3913 AND wherever em-passdown will call (this slice wires the self-retrieval call; passdown call is wired in PR-9 but the signature is fixed here). Default both heartbeat flags to label-only (requireVerified:false) — the flip to true is a Phase-2 one-line change. Add a CI lint/grep gate (scripts/lint-queryranked-callsites.mjs) that fails if any queryRanked call site outside the approved list omits the opts object, registered as an npm script and in the test gate.

**Acceptance criteria:**
- [ ] queryRanked({requireVerified:true}) returns only verification_state='verified' rows; with minConfidence:0.5 drops lower-confidence rows; excludeSuperseded:true (default) hides rows with supersededById set — all proven by unit test
- [ ] Conflict resolution: two entries same subjectKey, one human-answer one agent-claim → only the human-answer survives ranked output (precedence test)
- [ ] Heartbeat self-retrieval at :3913 passes the canonical opts object (label-only defaults); render at :3934-3947 unchanged in this slice
- [ ] The queryRanked call-site lint passes for current call sites and FAILS when a test fixture call omits opts
- [ ] memory-ranker.test.ts green: rankEntries still pure/sync, embedText untouched

**Test gate (must pass to land):**
- `pnpm test:run -- memory-service memory-ranker`
- `node scripts/lint-queryranked-callsites.mjs`

---

## PR-4 — HOOK 1: human-answer capture (load question comment, redaction gate, assumption-flag trust)

**Phase:** Phase 1 (write-paths)  
**Depends on:** PR-2  
**Risk:** Medium. The question-comment fetch is net-new work in the handler. Trust must key on actor.source not actorType (local_implicit returns actorType='user'). The redaction regex set is best-effort — document it bounds credential leakage only.

**Files:**
- `server/src/routes/issues.ts`
- `server/src/services/agent-question-routing.ts`
- `server/src/secret-scan.ts`
- `server/src/services/__tests__/issues-question-answer.test.ts`
- `server/src/services/__tests__/issues-internal-question-routes.test.ts`
- `server/src/services/__tests__/agent-question-routing.test.ts`

**What to build:**

Create server/src/secret-scan.ts exporting scanBody(text)→{clean,findings}: regex set for sk-/AKIA/ghp_/xoxb- keys, JWT (reuse JWT_VALUE_RE from redaction.ts:3), postgres:// connection strings, PEM blocks, and high-entropy tokens following secret-ish labels (reuse SECRET_PAYLOAD_KEY_RE from redaction.ts:1). In routes/issues.ts answer-question handler (:1045-1112), AFTER addComment(kind='answer') + markQuestionAnswered, add a best-effort try/catch HOOK 1: load the original question comment by questionCommentId (a getComment fetch — the required added work) to get the question body; run scanBody on the answer; if findings, write verificationState='needs_review'; else write createEntry({layer:'workspace',kind:'fact',subject:<question ~480 chars>,body:'Q: …\nA: …',source:'human-answer:<issueId>:<answerCommentId>',provenance:'human-answer',verificationState:'verified',confidence:0.95,authorType:'user',authorId:<userId>,sourceRefType:'comment',sourceRefId:<answerCommentId>}). Gate trust on a real human per §3.4: stamp verified only when req.actor.source !== 'local_implicit' AND a real userId exists; in local single-user mode local_implicit answers are treated as verified by design. Must not fail the answer response. Mirror in answerInternalManagerQuestion (agent-question-routing.ts:405-422): force verificationState='unverified'/provenance='agent-claim' when input.assumption===true — key off the CODE FLAG input.assumption, never the 'Assumption:' body prefix at :405.

**Acceptance criteria:**
- [ ] Answering a question via POST /issues/:id/answer-question creates exactly one memory_entries row with provenance='human-answer', verificationState='verified', source='human-answer:<issueId>:<answerCommentId>', subject derived from the loaded question comment
- [ ] An answer containing a fake 'sk-…' key is captured as verificationState='needs_review' (redaction gate), not verified
- [ ] answerInternalManagerQuestion with assumption=true writes verificationState='unverified'/provenance='agent-claim'; with assumption=false (genuine answer) writes verified
- [ ] If createEntry throws, the answer endpoint still returns 201 (best-effort proven)
- [ ] Re-firing the same answer (retry) does not create a duplicate (idempotent via PR-2 (companyId,source) upsert)

**Test gate (must pass to land):**
- `pnpm test:run -- issues-question-answer issues-internal-question-routes agent-question-routing`

---

## PR-5 — HOOK 2: deterministic EM PR-approval capture (no LLM)

**Phase:** Phase 1 (write-paths)  
**Depends on:** PR-2  
**Risk:** Low-medium. Pure deterministic string assembly; main risk is passing decisionNote/decidedByUserId through the route layer correctly and not double-capturing alongside the agent createMemoryFromEvent path (distinct source keys prevent collision).

**Files:**
- `server/src/services/issue-pull-requests.ts`
- `server/src/routes/issue-pull-requests.ts`
- `server/src/services/__tests__/issue-pull-requests.test.ts`
- `server/src/services/__tests__/accepted-work.test.ts`

**What to build:**

In issue-pull-requests.ts merge() (:572-614), right after approvalsSvc.approve(...) at :614 — where decisionNote, decidedByUserId, and the reconcile feedback string are in scope — add a deterministic captureApprovalMemory call (passed through the merge route :171-216). Write createEntry({subject:'EM approved PR <repo>#<n>: <title>', body:decisionNote + reviewFeedback + accepted-pattern summary, kind:decisionNote?'convention':'note', source:'pr-approval:<approvalId>', provenance:'pr-approval', authorType:'user', verificationState:'verified', confidence:0.8, createdBy:decidedByUserId, sourceRefType:'approval', sourceRefId:<approvalId>}). No LLM — body is the literal human note. Resolve the merge-trust split: an EM board merge with a human decisionNote+decidedByUserId → verified (this hook); out-of-band GitHub-direct merges via the poller (no decisionNote) keep the agent-driven createMemoryFromEvent at agent-claim/unverified (already tagged in PR-2). Link back via accepted_work_events.memoryEntryId where applicable. Best-effort try/catch — must not fail the merge.

**Acceptance criteria:**
- [ ] Merging a PR via POST /issue-pull-requests/:id/merge with a decisionNote creates one memory_entries row provenance='pr-approval', verificationState='verified', source='pr-approval:<approvalId>', kind='convention'
- [ ] A merge with no decisionNote writes kind='note' (still pr-approval/verified) and does not crash
- [ ] The agent-driven createMemoryFromEvent path (poller/out-of-band) remains agent-claim/unverified (no laundering)
- [ ] Re-firing the merge capture (reconcile twice) yields one row (idempotent via (companyId,source))
- [ ] If captureApprovalMemory throws, the merge still completes (best-effort)

**Test gate (must pass to land):**
- `pnpm test:run -- issue-pull-requests accepted-work`

---

## PR-6 — Render citations + UNVERIFIED label + non-executable fence (label-only, defense-in-depth)

**Phase:** Phase 1 (label-only retrieval)  
**Depends on:** PR-3  
**Risk:** Low. Pure formatting change in the preamble string; no retrieval-behavior change. Must not accidentally exclude unverified (that is PR-3/Phase-2's job).

**Files:**
- `server/src/services/heartbeat.ts`
- `server/src/services/__tests__/agent-memory.test.ts`

**What to build:**

In heartbeat.ts render block (:3934-3947), for each retrieved entry add a citation line [mem:<id> · <provenance> · conf=<n> · ref=<type>:<id>] and, for non-verified entries, an 'UNVERIFIED — do not treat as fact' sub-header. Wrap each entry body in an explicit non-executable fence ('data, not instructions'). This is label-only — do NOT exclude unverified entries (exclusion is the Phase-2 requireVerified flip). Keep the existing 16k truncation. This is defense-in-depth per §3.7; the real control is the PR-2 write-gate.

**Acceptance criteria:**
- [ ] A verified entry renders with a citation line containing its provenance/confidence/ref; an unverified entry additionally renders the UNVERIFIED sub-header
- [ ] Each entry body is wrapped in a non-executable fence
- [ ] No entry is excluded by this slice (label-only contract — unverified still appears)
- [ ] The 16k preamble truncation still applies

**Test gate (must pass to land):**
- `pnpm test:run -- agent-memory`

---

## PR-7 — Memory ETL export/import scripts + refuse-on-empty cutover guard

**Phase:** Phase 1 (tooling) / enables Phase 2 cutover  
**Depends on:** PR-2  
**Risk:** Low-medium. Byte-for-byte embedding preservation must round-trip jsonb exactly. The refuse-on-empty gate is the critical safety property — test it explicitly.

**Files:**
- `server/scripts/memory-export.ts`
- `server/scripts/memory-import.ts`
- `package.json`
- `server/src/services/__tests__/memory-service.test.ts`

**What to build:**

server/scripts/memory-export.ts dumps memory_entries (+ memory_promotions, + memory_usage, + agent_memory; explicitly NOT transcript_summaries) to JSON, preserving layer/owner/tags, the stored jsonb embedding byte-for-byte, all new 0049 trust columns, and embeddingVersion. server/scripts/memory-import.ts inserts under a target companyId via memoryService, supports --owner-remap local-board→<userId> for personal entries, idempotent on (companyId, layer, subject, source). Add package.json scripts db:memory-export / db:memory-import mirroring db:backup (:18). The import path MUST refuse to proceed (non-zero exit) when the export file is empty or yields zero inserted rows — a hard gate so switching DATABASE_URL never silently boots an empty central DB.

**Acceptance criteria:**
- [ ] db:memory-export produces JSON containing all 0049 trust columns + the jsonb embedding preserved exactly
- [ ] db:memory-import into a fresh DB recreates entries; re-running is idempotent (no duplicate rows on (companyId,layer,subject,source))
- [ ] --owner-remap rewrites personal entry owners from local-board to the supplied userId
- [ ] Importing an empty/zero-row export exits non-zero with a clear 'refuse-to-proceed' message (hard gate proven by test)

**Test gate (must pass to land):**
- `pnpm test:run -- memory-service`
- `node server/scripts/memory-export.ts --help && node server/scripts/memory-import.ts --help`

---

## PR-8 — Migration 0051: issues.service_scope

**Phase:** Phase 1 (trust spine prerequisite for passdown + sufficiency gate)  
**Depends on:** PR-1  
**Risk:** Low. Single additive nullable column; the only sequencing note is 0050 is deliberately omitted (markdown-vault, deferred) so the journal idx jumps 0049→0051.

**Files:**
- `packages/db/src/migrations/0051_issue_service_scope.sql`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/issues.ts`
- `packages/shared/src/types/issues.ts`
- `server/src/services/__tests__/issues-delegation-policy.test.ts`

**What to build:**

Migration 0051: ALTER TABLE issues ADD COLUMN service_scope text (mirroring the 0046 one-line ALTER pattern). Update meta/_journal.json (idx 51 — note 0050 is intentionally skipped/deferred per §10). Add serviceScope to the issues drizzle schema and the shared Issue type. This is the explicit retrieval target the EM passdown packet and the sufficiency gate key on. No behavior change beyond surfacing the column.

**Acceptance criteria:**
- [ ] pnpm db:migrate applies 0051; issues.service_scope text column exists; meta/_journal.json lists 0051
- [ ] The issues drizzle schema + shared Issue type expose serviceScope
- [ ] Existing issue create/read flows still pass (column is nullable, additive)

**Test gate (must pass to land):**
- `pnpm --filter @combyne/db migrate`
- `pnpm test:run -- issues-delegation-policy`

---

## PR-9 — EM passdown packet (artifactRefs) + size tiering + dual-channel verified filter

**Phase:** Phase 3 (EM passdown + first teammates)  
**Depends on:** PR-3, PR-8  
**Risk:** High. Touches the budget composer ordering, multiple adapters, and the heartbeat injection — the prompt-cache staleness window (§5.3) opens here. requireVerified now flips true on the self-retrieval channel, so the 0049 backfill + HOOK 1 must already be populating verified rows or the packet/preamble empties.

**Files:**
- `server/src/services/em-passdown.ts`
- `server/src/routes/issues.ts`
- `server/src/services/agent-handoff.ts`
- `server/src/services/heartbeat.ts`
- `packages/context-budget/src/composer.ts`
- `server/src/services/context-budget-telemetry.ts`
- `server/src/adapters/claude-local/execute.ts`
- `server/src/services/__tests__/issue-context-refs.test.ts`

**What to build:**

New server/src/services/em-passdown.ts → buildPassdownPacket({companyId,childIssueId,title,description,serviceScope,complexity,curatedMemoryEntryIds?}): (1) queryRanked over ['shared','workspace'] (NOT personal) keyed on child title+description+serviceScope WITH requireVerified/minConfidence (the canonical PR-3 opts); (2) UNION with EM-pinned curatedMemoryEntryIds; (3) drop score<0.15, conflict-resolve, token-budget by complexity tier (small=1-3 entries shared-only ~1.5k; medium=≤6 incl workspace conventions ~4k; large=≤12 spanning shared+workspace + recent human-answers/approvals ~8-10k). Persist the typed manifest into agent_handoffs.artifactRefs jsonb (replace the always-[] at agent-handoff.ts:162) — zero schema migration. In routes/issues.ts delegate (~1170-1268): accept curatedMemoryEntryIds[] + serviceScope, call buildPassdownPacket, store packet in artifactRefs. In heartbeat.ts: populate context.combynePassdownContext from artifactRefs after the handoff block, inject even for focused_small with a hard ~1.5k cap, AND apply requireVerified to the sub-agent self-retrieval at :3913 (the Phase-3 dual-channel completion). Register 'passdown' in composer.ts stableOrder (:158-167) after 'handoff' as priority-1 cacheStable with hard maxTokens, add the writeSectionBackToContext case, register in buildPreambleSectionsFromContext (context-budget-telemetry.ts:348). Concatenate combynePassdownContext in claude-local execute.ts (:407-421) and codex-local; for cursor/gemini/opencode/pi use the buildBriefMarkdown '## Vetted context from your manager' fallback.

**Acceptance criteria:**
- [ ] buildPassdownPacket returns only requireVerified entries from [shared,workspace] (no personal), unions curatedMemoryEntryIds, and respects the small/medium/large token tiers
- [ ] The packet is persisted into agent_handoffs.artifactRefs (no longer always [])
- [ ] Heartbeat injects combynePassdownContext even for focused_small under a ~1.5k cap, and the sub-agent self-retrieval at :3913 now passes requireVerified:true
- [ ] composer stableOrder places 'passdown' after 'handoff' as cacheStable priority-1; section round-trips via writeSectionBackToContext
- [ ] Adapters that consume memory fields concatenate the passdown context; brief-fallback adapters embed the '## Vetted context from your manager' section

**Test gate (must pass to land):**
- `pnpm test:run -- issue-context-refs memory-service`
- `pnpm test:run -- context-budget`

---

## PR-10 — Sufficiency gate shipped DARK (no-op, telemetry only)

**Phase:** Phase 1 land dark → Phase 3 ask-mode  
**Depends on:** PR-2, PR-8  
**Risk:** Medium. Must stay a true no-op until 0049+HOOK 1 populate verification_state, else it would fire insufficient on every retrieval (chatty regression). H1/H2 code paths exist but must be gated off; the danger is an accidental enable before calibration.

**Files:**
- `server/src/services/memory-sufficiency.ts`
- `server/src/services/sufficiency-budget.ts`
- `server/src/services/heartbeat.ts`
- `server/src/config.ts`
- `server/src/services/__tests__/memory-sufficiency.test.ts`

**What to build:**

server/src/services/memory-sufficiency.ts → evaluateSufficiency(input)→{verdict:'sufficient'|'insufficient'|'thin',reasons[],topScore,verifiedCovered,entityCoverage,requirementCoverage,missingEntities[]}. Pure/DB-free (mirrors rankEntries). Inputs: queryRanked result items (score, verificationState/provenance/confidence from 0049), serviceScope (0051), extracted requirement tokens, complexity. insufficient when ALL of: topScore<SUFFICIENCY_MIN_SCORE(0.22) OR no verified+(human-answer|pr-approval|verified-summary) item; entityCoverage===0; requirementCoverage<REQ_COVER_MIN(0.34). thin=borderline. Thresholds keyed by embedding_version (a {minScore,reqCover} map). server/src/services/sufficiency-budget.ts: per-issue ask budget (max 2), per-subjectKey cooldown reusing the existing existingKeys dedupe (agent-question-routing.ts:272-276). Add config COMBYNE_SUFFICIENCY_GATE_ENABLED (default OFF), SUFFICIENCY_MIN_SCORE, REQ_COVER_MIN to config.ts (envVar pattern at :25). Wire the H1 (withhold sub-threshold preamble) and H2 (call routeAgentQuestionsToManager directly + deterministic status transition) code paths into heartbeat after :3905-3947 BUT keep them DARK: gate-enabled=false → emit a sufficiency_verdict telemetry event only, never withhold, never ask. The ask-mode flip is a later (Phase-3) config change after calibration.

**Acceptance criteria:**
- [ ] evaluateSufficiency is pure and unit-tests without a DB; returns insufficient only when all three conditions hold; thin on a single condition
- [ ] With COMBYNE_SUFFICIENCY_GATE_ENABLED=off the heartbeat emits a sufficiency_verdict telemetry event but never withholds context and never posts a question (proven dark)
- [ ] Thresholds resolve from the embedding_version-keyed map; a missing threshold set for the active version is flagged (not silently defaulted)
- [ ] sufficiency-budget enforces ≤2 asks/issue and the per-subjectKey cooldown (unit-tested) — exercised only when enabled
- [ ] No regression to existing heartbeat memory injection while dark

**Test gate (must pass to land):**
- `pnpm test:run -- memory-sufficiency agent-question-routing agent-memory`

---

## PR-11 — Embeddings: migration 0052 pgvector + embedding-driver + redact-before-embed + version-guard + rankEntries query-embed lift

**Phase:** Phase 2 (self-hosted cutover + embedding swap)  
**Depends on:** PR-2, PR-3, PR-4  
**Risk:** High. The pure-ranker-preservation (query-embed lift out of rankEntries) is the load-bearing constraint — break it and the test oracle and determinism break. Embedded CI rig must never require pgvector (stay on hash oracle). Redact-before-embed must be airtight on BOTH egress paths. Async storage embed must never block/fail a write (hash fallback).

**Files:**
- `packages/db/src/migrations/0052_pgvector_embeddings.sql`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/memory_layers.ts`
- `server/src/config.ts`
- `server/src/services/embedding-driver.ts`
- `server/src/services/memory-embedder.ts`
- `server/src/services/memory-embed-cache.ts`
- `server/src/secret-scan.ts`
- `server/src/services/memory.ts`
- `server/scripts/memory-reembed.ts`
- `package.json`
- `server/src/services/__tests__/embedding-version.test.ts`
- `server/src/services/__tests__/memory-ranker.test.ts`

**What to build:**

Migration 0052: CREATE EXTENSION IF NOT EXISTS vector; ALTER TABLE memory_entries ADD embedding_vec vector(1536) NULL, embedding_version text, embedding_model text, embedding_dim integer, content_hash text. DO NOT build HNSW here (ship nullable, backfill, then CREATE INDEX CONCURRENTLY hnsw last). Keep the existing embedding jsonb as fallback + permanent test oracle (CI rig may lack pgvector). schema/memory_layers.ts: add a customType wrapping vector(1536) + the new columns. config.ts: add embeddingProvider/Model/Dim/ApiKey/vectorSearchEnabled/monthlyCapUsd/rpm (envVar pattern); coercion — empty key → vectorSearchEnabled=false (zero egress). server/src/services/embedding-driver.ts (NEW): clone summarizer-driver-anthropic.ts (resolveApiKey chain explicit→COMBYNE_EMBEDDING_API_KEY→OPENAI_API_KEY, AbortController 60s, !response.ok wrap, never log key, version=`${provider}:${model}:${dim}`, THROW on dim mismatch). server/src/services/memory-embedder.ts (NEW): the ONLY caller of the driver; embedForStorage(subject,body) and embedQuery(text) BOTH run scanBody (secret-scan.ts) before any driver call; any error → hash fallback embedText, never throw; content-hash cache via memory-embed-cache.ts. memory.ts: createEntry:235/updateEntry:269/createSharedFromPromotion:647 → await embedForStorage, write both embedding (jsonb oracle) and embedding_vec+embedding_version; updateEntry re-embeds only when content_hash changes; rankEntries:155 — REMOVE embedText(query); queryRanked:365 computes embedQuery first and passes queryEmbedding into rankEntries (pure ranker stays sync); cosineSimilarity:73 — add embedding_version equality guard, never cross-score two spaces; loadCandidates:322 — when vectorSearchEnabled use embedding_vec <=> $q ORDER BY LIMIT k. server/scripts/memory-reembed.ts (NEW) + db:memory-reembed: SELECT WHERE embedding_version!=current OR embedding_vec IS NULL, redact-before-embed, batch ~100 with backoff, idempotent/resumable; never auto-run on boot.

**Acceptance criteria:**
- [ ] pnpm db:migrate applies 0052 (extension guarded with IF NOT EXISTS); columns exist; NO HNSW index created by the migration
- [ ] With no API key: vectorSearchEnabled coerced false, createEntry writes hash-64 + 'hash-64:64', zero driver calls, never throws (proven)
- [ ] embedForStorage AND embedQuery both run scanBody before the (mocked) driver; a body/query with a fake sk- key is redacted before the driver sees it AND the entry is marked needs_review — tested on BOTH paths
- [ ] cosineSimilarity falls back to hash on embedding_version mismatch (no silent min-len score)
- [ ] rankEntries is still pure/sync and embedText still deterministic+L2-normalized — memory-ranker.test.ts green (oracle preserved)
- [ ] db:memory-reembed is idempotent/resumable and never runs on boot
- [ ] driver.embed is reachable only through memory-embedder.ts (no-restricted-imports lint on embedding-driver)

**Test gate (must pass to land):**
- `pnpm --filter @combyne/db migrate`
- `pnpm test:run -- embedding-version memory-ranker memory-service`

---

## PR-12 — Retrieval-quality eval harness (recall@k / MRR, hash oracle in CI + opt-in live tier)

**Phase:** Phase 2 (embedding swap)  
**Depends on:** PR-11  
**Risk:** Low-medium. The hash-oracle tier must be fully network-free and deterministic. Threshold choice needs to be stable across runs (seeded fixtures). The live tier must never run in CI.

**Files:**
- `server/src/services/__tests__/retrieval-quality.test.ts`
- `server/src/services/__tests__/fixtures/retrieval-eval.json`
- `server/src/routes/memory.ts`
- `package.json`

**What to build:**

server/src/services/__tests__/fixtures/retrieval-eval.json: labeled set [{query, expectedEntryIds[], seedEntries[]}] grounded in real ADE domains (kafka topic conventions, budget pause policy, auth middleware — same vocabulary as memory-ranker.test.ts). retrieval-quality.test.ts: seed via memoryService into the _test-db rig, run queryRanked, compute recall@1/@5/@10, MRR, right-context-retrieved-rate; runs against the deterministic hash-64 oracle in CI (no network) as a hard merge gate. Add a SECOND opt-in tier behind COMBYNE_EVAL_LIVE_EMBEDDINGS=true (skipped in CI) that runs the same fixtures through the managed embedder and asserts real-embedding recall@k > hash recall@k by a threshold (the input→output lift measurement). Add GET /memory/embedding-status route (per-company embedding_version coverage %, token spend, hash-fallback rate, re-embed backlog, needs_review/redaction-blocked count).

**Acceptance criteria:**
- [ ] pnpm test:run runs retrieval-quality.test.ts against the hash oracle (no network) and asserts recall@k/MRR thresholds — a CI merge gate
- [ ] The live-embedding tier is skipped unless COMBYNE_EVAL_LIVE_EMBEDDINGS=true and, when run, asserts real-embedding recall lift over hash
- [ ] GET /memory/embedding-status returns version coverage, hash-fallback rate, and redaction-blocked count per company

**Test gate (must pass to land):**
- `pnpm test:run -- retrieval-quality`

---

## PR-13 — Memory UI Phase 1: tabbed shell + Browse with trust badges + DesignGuide section (label-only)

**Phase:** Phase 1 (UI, label-only Release N)  
**Depends on:** PR-2  
**Risk:** Low-medium. Largest UI refactor (single-scroll → tabbed shell) but reuses verified primitives only. Must keep the flat /memory route working and not regress the existing CompanyMemory CRUD.

**Files:**
- `ui/src/pages/CompanyMemory.tsx`
- `ui/src/pages/memory/MemoryBrowse.tsx`
- `ui/src/components/memory/MemoryEntryCard.tsx`
- `ui/src/components/memory/MemoryTrustBadges.tsx`
- `ui/src/components/memory/MemoryEntryEditDialog.tsx`
- `ui/src/api/memory.ts`
- `packages/shared/src/types/memory.ts`
- `ui/src/App.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/lib/queryKeys.ts`
- `ui/src/pages/DesignGuide.tsx`
- `ui/src/pages/__tests__/MemoryEntryCard.test.tsx`

**What to build:**

Convert CompanyMemory.tsx into a path-driven tabbed shell using the Approvals.tsx:88-100 Tabs+PageTabBar pattern (yellow pill, navigate('/memory/<tab>')). Add memory/:tab child routes in App.tsx alongside :154, all rendering CompanyMemory. Ship the Browse tab (ui/src/pages/memory/MemoryBrowse.tsx): current search Input + a FilterBar row (Select) for layer/kind/provenance/verificationState/confidence-bucket/serviceScope/age; render each entry via MemoryEntryCard. MemoryTrustBadges.tsx: ProvenanceBadge, VerificationBadge (verified=green, unverified=amber, needs_review=red — reuse StatusBadge map), ConfidenceMeter (red<0.4/yellow<0.7/green), MemoryCitationLine (text-xs font-mono, format [mem:<id> · <provenance> · conf=<n> · ref=<type>:<id>]). MemoryEntryCard extends the existing inline-edit card (CompanyMemory.tsx:199-326) adding the badges + citation + supersededBy strike state. MemoryEntryEditDialog wraps the draft form (workspace/personal only — shared stays promotion-gated per packages/shared/src/validators/memory.ts:31-37). Extend ui/src/api/memory.ts listEntries to accept provenance/verificationState/minConfidence/serviceScope/age; extend MemoryEntry type with the 0049 trust fields; extend GET /companies/:companyId/memory/entries (routes/memory.ts:70-73) to filter on them. Add the sidebar Memory pending badge stub (Sidebar.tsx:113). Register the Memory section in DesignGuide.tsx (SKILL.md:293) showing badges in all states.

**Acceptance criteria:**
- [ ] /memory/browse renders the tabbed shell; Browse lists entries with ProvenanceBadge/VerificationBadge/ConfidenceMeter/MemoryCitationLine; unverified shows the amber chip (label-then-exclude Release-N contract)
- [ ] Filtering GET entries?provenance=agent-claim&verificationState=unverified returns only matching rows
- [ ] New entry dialog allows workspace/personal only; shared create is blocked by the shared validator
- [ ] DesignGuide shows the trust badges + MemoryEntryCard in verified/unverified/needs_review/superseded states
- [ ] Component test: MemoryEntryCard renders the correct badges + citation per provenance

**Test gate (must pass to land):**
- `pnpm --filter ui test -- MemoryEntryCard`
- `pnpm test:run -- memory`

---

## PR-14 — Memory UI Phase 1b: Capture + Verify + Conflicts tabs (the explicit user ask) + board routes

**Phase:** Phase 1 (UI, as hooks populate 0049)  
**Depends on:** PR-4, PR-5, PR-13  
**Risk:** Medium. Conflicts is the explicit user ask and must default-surface newest-by-that-user (not silent newest-wins). supersededById writes must preserve losers for audit. Verify-queue board gating must be enforced server-side.

**Files:**
- `ui/src/pages/memory/MemoryCaptureReview.tsx`
- `ui/src/pages/memory/MemoryVerifyQueue.tsx`
- `ui/src/pages/memory/MemoryConflicts.tsx`
- `ui/src/components/memory/MemoryConflictResolver.tsx`
- `ui/src/api/memory.ts`
- `server/src/routes/memory.ts`
- `packages/shared/src/types/memory.ts`
- `ui/src/lib/queryKeys.ts`
- `ui/src/pages/__tests__/MemoryConflictResolver.test.tsx`
- `server/src/routes/__tests__/memory-verify-routes.test.ts`

**What to build:**

Capture tab (MemoryCaptureReview.tsx): lists provenance IN ('human-answer','pr-approval') entries (Approvals queue shape) with source citation (issue#/PR#) and Confirm/Edit/Discard. Verify tab (MemoryVerifyQueue.tsx, hybrid SLA decision #3): (a) agent-claims hitting N distinct-issue reuse, (b) promotion proposals from listPromotions; wired to a new POST /memory/entries/:id/verify (assertBoard, mirroring routes/memory.ts:321-350, stamps verifiedBy/verifiedAt) and existing decidePromotion. Conflicts tab (MemoryConflicts.tsx + MemoryConflictResolver.tsx — the first-class decision #5): groups entries by subjectKey HAVING conflicting human-answers; resolver shows side-by-side cards (ApprovalDetail two-column precedent), newest-by-that-user pre-highlighted; three actions mapped to supersededById — OVERRIDE (supersede the other), MERGE (third editable Textarea seeded from both → new canonical, supersede both), EDIT (free-edit canonical); labeled 'Detected conflicts' (under-reports paraphrases). Add server routes: POST /memory/entries/:id/verify, POST /companies/:companyId/memory/conflicts/:subjectKey/resolve (assertBoard), GET capture-inbox/verify-queue/conflicts. Extend ui/src/api/memory.ts + queryKeys + shared types (MemoryConflictGroup). Wire the sidebar pending badge to capture+verify+conflicts depth.

**Acceptance criteria:**
- [ ] Capture tab lists human-answer/pr-approval entries with source citations and Confirm/Edit/Discard actions
- [ ] Verify tab shows agent-claims with distinct-issue reuse evidence + promotion proposals; POST /memory/entries/:id/verify rejects non-board and stamps verifiedBy/verifiedAt
- [ ] Conflicts tab groups by subjectKey; resolver pre-highlights newest-by-that-user; OVERRIDE/MERGE/EDIT fire resolveConflict with the right payload and MERGE supersedes both originals via supersededById
- [ ] Non-board cannot resolve conflicts (route test)
- [ ] Component test: MemoryConflictResolver newest-by-that-user pre-highlighted; MERGE seeds from both bodies

**Test gate (must pass to land):**
- `pnpm --filter ui test -- MemoryConflictResolver`
- `pnpm test:run -- memory-verify-routes`

---

## PR-15 — Memory UI Phase 2: Setup + Redaction tabs (ship WITH the embedding swap) + privacy disclosure

**Phase:** Phase 2 (UI, ships with embeddings)  
**Depends on:** PR-11, PR-13  
**Risk:** Medium-high. Reveal is a second egress surface — masked-by-default and the audited board-only endpoint are security-critical. Key must be stored via the secrets path, never a plaintext setting. The disclosure must not overclaim redaction=privacy.

**Files:**
- `ui/src/pages/memory/MemorySetup.tsx`
- `ui/src/pages/memory/MemoryRedactionQueue.tsx`
- `ui/src/components/memory/MemoryRedactionCard.tsx`
- `ui/src/api/memory.ts`
- `server/src/routes/memory.ts`
- `doc/PRIVACY_DISCLOSURE.md`
- `ui/src/pages/__tests__/MemoryRedaction.test.tsx`

**What to build:**

Setup tab (MemorySetup.tsx, decision #1): InstanceGeneralSettings.tsx-template Card to paste the team-shared embedding API key (masked password input, stored via the secrets path NEVER plaintext, never echoed back), choose provider/model (Select: text-embedding-3-small/-large), shows resolved embedding_version/dim. Prominent privacy-disclosure panel carrying the §1.0/§1.5 reconciliation verbatim with an explicit acknowledge checkbox REQUIRED before save (save blocked until acked). Cost/rate fields (monthly cap USD, RPM). The §1.9 status surface (version coverage %, hash-fallback count, token spend vs cap, redaction-blocked count, last re-embed). 'Run re-embed' + 'Run retrieval eval' explicit-trigger actions. Redaction tab (MemoryRedactionQueue.tsx + MemoryRedactionCard.tsx): lists verificationState='needs_review'/sensitive entries (held out of retrieval); body MASKED by default (CopyText/reveal), matched secret spans highlighted, actions Reveal/Redact-span/Approve-as-clean/Reject. Reveal is an explicit board-principal click against an AUDITED POST /memory/entries/:id/redaction/reveal (assertBoard) returning cleartext only to that principal, never persisted client-side, never logged (the reveal action is audit-logged, not the body). Add POST /memory/entries/:id/redaction/resolve + /reveal, GET redaction-queue/embedding-config/embedding-status. Create doc/PRIVACY_DISCLOSURE.md (the single-external-dependency disclosure, bounds-credential-leakage-not-confidentiality).

**Acceptance criteria:**
- [ ] Setup save is BLOCKED until the privacy disclosure acknowledge checkbox is checked; the masked key input never echoes a saved key
- [ ] Setup status surface shows embedding_version coverage, hash-fallback rate, token spend, redaction-blocked count
- [ ] Redaction queue renders bodies MASKED by default — no secret span is in the DOM before Reveal (regression guard test)
- [ ] Reveal hits an assertBoard audited endpoint; non-board cannot reveal/resolve (route test); revealed cleartext is never persisted client-side or logged
- [ ] doc/PRIVACY_DISCLOSURE.md exists and states what is/isn't sent + that redaction bounds credential leakage, not body confidentiality

**Test gate (must pass to land):**
- `pnpm --filter ui test -- MemoryRedaction`
- `pnpm test:run -- memory`

---

## PR-16 — Memory UI Phase 3: Questions + Passdown tabs + delegate-dialog MemoryPassdownPicker

**Phase:** Phase 3 (UI, with passdown + ask-mode)  
**Depends on:** PR-9, PR-14  
**Risk:** Low-medium. Mostly read-only audit surfaces; the picker integrates into the existing delegate dialog so it depends on PR-9's artifactRefs persistence being live.

**Files:**
- `ui/src/pages/memory/MemoryQuestions.tsx`
- `ui/src/pages/memory/MemoryPassdown.tsx`
- `ui/src/components/memory/MemoryPassdownPicker.tsx`
- `ui/src/api/memory.ts`
- `server/src/routes/memory.ts`
- `packages/shared/src/types/memory.ts`
- `ui/src/pages/__tests__/MemoryPassdown.test.tsx`

**What to build:**

Questions tab (MemoryQuestions.tsx): the sufficiency-gate loop made visible — gate-authored question → answered → captured entry, sourced from the question-comment flow. Passdown tab (MemoryPassdown.tsx): read-only audit of EM passdown packets from agent_handoffs.artifactRefs (GET passdown-packets). MemoryPassdownPicker.tsx: a Checkbox-list of verified entries matching the child issue's title/serviceScope, embedded in the existing issue-delegate dialog (where complexity/serviceScope already resolve), letting the EM pin curatedMemoryEntryIds. Add GET questions/passdown-packets routes + MemoryQuestionItem/MemoryPassdownPacket shared types. Add the staleness UX note (a 'change may take up to <cache TTL> to reach running agents' note on edit/redact/supersede/conflict-resolve).

**Acceptance criteria:**
- [ ] Questions tab shows gate-authored questions and their answered→captured lineage
- [ ] Passdown tab renders read-only EM packets from artifactRefs
- [ ] MemoryPassdownPicker in the delegate dialog lists verified entries for the child's serviceScope and pins curatedMemoryEntryIds into the passdown call
- [ ] Edit/redact/supersede/conflict-resolve surfaces the cache-TTL staleness note

**Test gate (must pass to land):**
- `pnpm --filter ui test -- MemoryPassdown`
- `pnpm test:run -- memory`

---

## PR-17 — Phase-4 gate: migration 0053 RLS + BYPASSRLS scheduler role + SET LOCAL middleware + cross-tenant isolation suite

**Phase:** Phase 4 (HARD GATE before company #2)  
**Depends on:** PR-2, PR-9  
**Risk:** High. The per-request transaction wrapper (SET LOCAL inside db.transaction) is the real cost of RLS and the highest-blast-radius change — a plain SET on transaction-mode pgbouncer silently leaks across tenants. BYPASSRLS background scans lose the RLS net exactly where they are most powerful, so they need dedicated isolation tests. Per-tenant JWT must land WITH RLS (RLS does not rescue a forged claim). This is a hard gate — must not ship multi-tenant without it.

**Files:**
- `packages/db/src/migrations/0053_memory_rls_team_phase.sql`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/memory_layers.ts`
- `server/src/middleware/auth.ts`
- `server/src/routes/authz.ts`
- `server/src/services/heartbeat.ts`
- `server/src/services/agent-auth-jwt.ts`
- `server/src/services/__tests__/cross-tenant-isolation.test.ts`

**What to build:**

Migration 0053: enable RLS on memory_entries/memory_promotions/memory_usage with company-keyed policies; ADD the missing FK + RLS policy on memory_usage (memory_layers.ts:113 declares companyId as a bare uuid with no .references() — add it); CREATE ROLE <scheduler> BYPASSRLS for the heartbeat global scans (heartbeat.ts:6559 tickTimers, decay, summarizer, ETL) and ensure the app role does NOT have BYPASSRLS. Request-path: actorMiddleware (auth.ts:20-25) sets SET LOCAL app.current_company inside an explicit db.transaction() that also contains the query (never plain SET — pgbouncer transaction-mode pinning hazard); route RLS-scoped traffic through pgbouncer SESSION mode or direct :5432. Harden authz.ts:18 assertCompanyAccess to fail-closed (throw) on empty/undefined companyId for ALL principals incl. local_implicit/isInstanceAdmin (currently skips membership at :25). Per-tenant agent-JWT key separation (agent-auth-jwt.ts:97-109 single global secret) lands WITH RLS. CI cross-tenant isolation suite as a merge gate: company B cannot read A via every retrieval path; empty companyId rejected; the BYPASSRLS background scans have their own isolation tests; the unscoped memory_usage path covered. Author and CI-test all of this against the single tenant; the FLIP is the boundary trigger (2+ companies or first non-local multi-user) — a CI/cutover hard-stop, not a checklist line.

**Acceptance criteria:**
- [ ] pnpm db:migrate applies 0053; RLS enabled on all three memory tables; memory_usage has a companyId FK + policy; a BYPASSRLS scheduler role exists and the app role lacks BYPASSRLS
- [ ] Under RLS, company B cannot read company A entries via queryRanked/listEntries/manifest/usage — proven for every retrieval path
- [ ] assertCompanyAccess throws on empty/undefined companyId for local_implicit and isInstanceAdmin (no longer skipped)
- [ ] The heartbeat global scan (tickTimers/decay/summarizer) runs as the BYPASSRLS role and still sees all companies; an app-role query under RLS returns zero cross-company rows
- [ ] Per-tenant agent-JWT key separation in place; a token signed for tenant A cannot assert tenant B
- [ ] The cross-tenant isolation suite is wired as a merge gate

**Test gate (must pass to land):**
- `pnpm --filter @combyne/db migrate`
- `pnpm test:run -- cross-tenant-isolation`
- `node scripts/lint-queryranked-callsites.mjs`

---

