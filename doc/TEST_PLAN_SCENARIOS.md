# Central Context DB — Scenario-Driven Test Plan

> The actual user-described flows (S1–S12), each as Given/When/Then, mapped to the implementation slices. Negative/security scenarios are first-class. Run unit/integration via `pnpm test:run`, e2e via `pnpm test:e2e`, UI via `pnpm --filter ui test`.

## Scenario catalog

| ID | Title | Persona | Priority | Phase |
|---|---|---|---|---|
| S1 | Operator dogfoods 4-layer memory TODAY (embedded, zero deploy) | Solo operator (local board, local_implicit principal) | p0 | Phase 0 (use today, no code changes) |
| S2 | Clarifying-question answer is captured to central DB and not re-asked (HOOK 1 loop) | Operator/human answering an agent's clarifying question across small/medium/large tickets | p0 | Phase 1 (trust spine + write-paths) |
| S3 | EM PR-approval captures decision/feedback/accepted-pattern as a convention (HOOK 2, deterministic no-LLM) | Human EM (board principal) approving and merging a PR | p0 | Phase 1 (trust spine + write-paths) |
| S4 | EM delegates a size-tiered, CITED, requireVerified passdown packet to small/medium/large sub-agents | EM agent delegating to a sub-agent at ticket-creation time | p0 | Phase 3 (EM passdown + first teammates) |
| S5 | Ask-don't-hallucinate HARD sufficiency gate withholds weak context and posts a gate-authored question | Sub-agent on a ticket with insufficient/low-confidence retrieved context | p0 | Phase 3 (gate flipped to ask-mode) |
| S6 | Conflict: two users answer the same subject differently → UI override/merge/edit into one canonical entry | Operator/board reviewer resolving conflicting human-answers | p0 | Phase 1/3 (Conflicts is a must-have UI ask) |
| S7 | Redaction: an answer containing a secret/credential is caught before embed+write and quarantined | Human answering a credentials/access question (the escalate-to-human channel) | p0 | Phase 2 (ships WITH the embedding swap) |
| S8 | Embedding quality: right context retrieved (recall@k); unset team key degrades to local hash-64 with zero egress | Operator measuring retrieval quality / running with or without the team embedding key | p0 | Phase 2 (embedding swap) |
| S9 | Central cutover: dogfooded embedded memory migrated to self-hosted via ETL with parity; refuses on empty/failed import | Operator promoting from embedded to self-hosted central Postgres | p1 | Phase 2 (self-hosted cutover, Option A) |
| S10 | Multi-team isolation: company B cannot read company A's memory; empty companyId fails closed; BYPASSRLS scans still work | Second company/teammate onboarding (multi-tenant boundary) | p0 | Phase 4 (RLS multi-team gate) |
| S11 | Scale/hallucination guardrails: stale/duplicate/conflicting/superseded facts do not surface as authoritative | Operator/observer as the corpus grows large | p1 | Phase 4 (scale defenses + re-verification/observability) |
| S12 | Memory management UI: 8-tab shell with provenance/confidence/age, capture/verify/redaction/conflict queues, setup | Operator/board curator managing the memory layer | p1 | Phase 1 (Browse+badges first) → fast-follow queues |

---

### S1 — Operator dogfoods 4-layer memory TODAY (embedded, zero deploy)

**Persona:** Solo operator (local board, local_implicit principal) · **Priority:** p0 · **Phase:** Phase 0 (use today, no code changes)

- **Given** ADE runs in single-user embedded mode (DATABASE_URL unset → embedded Postgres auto-starts at 127.0.0.1:54329; index.ts:284). HEAD is migration 0047, no trust spine yet; hash-64 embedder is active; memory UI is single-scroll CompanyMemory.tsx.
- **When** The operator writes a workspace convention via the memory REST surface (POST /companies/:companyId/memory/entries, routes/memory.ts:23 → createEntry layer:'workspace', memory.ts:228), then an agent picks up an issue and the heartbeat self-retrieval (heartbeat.ts long-term block ~3895-3947) runs queryRanked over ['workspace','shared','personal'] and injects matching entries into combyneLongTermMemoryPreamble; the operator then proposes the entry for the shared layer and approves it via board promotion (decidePromotion, routes/memory.ts:321-350).
- **Then** The convention is created as an active, immediately-retrievable workspace entry (no trust gate yet at 0047); it appears verbatim in the agent prompt render (heartbeat.ts:3934-3947, '## subject / Layer / Tags / body' with no provenance); recordUsage bumps usageCount/lastUsedAt; the board-approved promotion creates a shared entry (the only writer of layer='shared'). All works with zero deploy on the embedded rig.

**Exercises:** `server/src/services/memory.ts`, `server/src/routes/memory.ts`, `server/src/services/heartbeat.ts`, `ui/src/pages/CompanyMemory.tsx`, `ui/src/api/memory.ts`, `server/src/services/__tests__/memory-service.test.ts`, `server/src/services/__tests__/memory-ranker.test.ts`

---

### S2 — Clarifying-question answer is captured to central DB and not re-asked (HOOK 1 loop)

**Persona:** Operator/human answering an agent's clarifying question across small/medium/large tickets · **Priority:** p0 · **Phase:** Phase 1 (trust spine + write-paths)

- **Given** Migration 0049 trust spine + 0051 service_scope have landed; HOOK 1 is wired into the answer-question handler; the redaction body-scan gate is in place. An agent on an issue posts a clarifying question (extractAndPostQuestions → awaiting_user, or sub-agent /ask-user → internal manager question).
- **When** The human answers via POST /issues/:id/answer-question (routes/issues.ts:1045-1112) or the internal-manager path answerInternalManagerQuestion (agent-question-routing.ts:380-422). HOOK 1 fires AFTER addComment(kind='answer')+markQuestionAnswered: it loads the original question comment by questionCommentId, runs the §4.4 body redaction scan, then createEntry({layer:'workspace',kind:'fact',subject:<question>,body:'Q:…\nA:…',source:'human-answer:<issueId>:<answerCommentId>',provenance:'human-answer',verificationState:'verified',confidence:0.95,authorType:'user'}). Later a different ticket triggers the SAME subjectKey gap.
- **Then** A verified human-answer workspace entry is captured idempotently (unique (companyId,source) partial index; re-fired answers onConflictDoNothing) without failing the answer response (best-effort try/catch); for local_implicit the operator is treated as the trusted human (verified), for authenticated real userId also verified (authz §3.4); the next heartbeat self-retrieval surfaces that verified entry so the agent does NOT re-ask the same question.

**Exercises:** `server/src/routes/issues.ts`, `server/src/services/agent-question-routing.ts`, `server/src/services/memory.ts`, `server/src/services/heartbeat.ts`, `server/src/routes/authz.ts`, `server/src/__tests__/issues-question-answer.test.ts`, `server/src/__tests__/issues-internal-question-routes.test.ts`, `server/src/services/__tests__/agent-question-routing.test.ts`, `server/src/services/__tests__/memory-service.test.ts`

---

### S3 — EM PR-approval captures decision/feedback/accepted-pattern as a convention (HOOK 2, deterministic no-LLM)

**Persona:** Human EM (board principal) approving and merging a PR · **Priority:** p0 · **Phase:** Phase 1 (trust spine + write-paths)

- **Given** Migration 0049 has landed; HOOK 2 captureApprovalMemory is wired into the merge path. A sub-agent has opened a PR with a tracked merge_pr approval row; the EM has a decisionNote and reconcile feedback string.
- **When** The EM merges via the PR panel → merge() (issue-pull-requests.ts:572) calls approvalsSvc.approve(approvalId, decidedByUserId, decisionNote). HOOK 2 fires right after approve, with decisionNote/decidedByUserId/reviewFeedback in scope, and deterministically (never agent-summarized) writes createEntry({subject:'EM approved PR <repo>#<n>: <title>',body:decisionNote+reviewFeedback+accepted-pattern,kind: decisionNote?'convention':'note',source:'pr-approval:<approvalId>',provenance:'pr-approval',authorType:'user',verificationState:'verified',confidence:0.8}).
- **Then** A verified pr-approval convention entry is captured and linked back via accepted_work_events.memoryEntryId; an EM board merge with decisionNote+decidedByUserId → verified, while the parallel agent-driven createMemoryFromEvent (accepted-work.ts:365) and out-of-band GitHub-direct merges stay agent-claim/unverified (the merge-trust split); the convention is later reused as vetted context in retrieval and EM passdown.

**Exercises:** `server/src/services/issue-pull-requests.ts`, `server/src/services/accepted-work.ts`, `server/src/services/memory.ts`, `server/src/services/__tests__/issue-pull-requests.test.ts`, `server/src/services/__tests__/accepted-work.test.ts`, `server/src/services/__tests__/combyne-skill-pr-review.test.ts`

---

### S4 — EM delegates a size-tiered, CITED, requireVerified passdown packet to small/medium/large sub-agents

**Persona:** EM agent delegating to a sub-agent at ticket-creation time · **Priority:** p0 · **Phase:** Phase 3 (EM passdown + first teammates)

- **Given** em-passdown.ts (NET-NEW) exists; 0049 trust spine + 0051 service_scope landed; the delegate route accepts curatedMemoryEntryIds[]+serviceScope; agent_handoffs.artifactRefs jsonb is repurposed (was always [] at agent-handoff.ts:162). Verified shared+workspace entries exist for the serviceScope.
- **When** The EM delegates via POST /issues/:id/delegate (routes/issues.ts:1170) with resolved complexity (1178-1179); buildPassdownPacket({companyId,childIssueId,title,description,serviceScope,complexity,curatedMemoryEntryIds?}) runs queryRanked over ['shared','workspace'] (NOT personal) with requireVerified/minConfidence (the §0.3 canonical signature), UNIONs EM-pinned curated IDs, confidence-filters (drop score<0.15), conflict-resolves, token-budgets by tier, and persists the typed manifest into agent_handoffs.artifactRefs; createHandoff (1218) carries it; heartbeat injects combynePassdownContext even for focused_small (hard ~1.5k cap) and the sub-agent self-retrieval gets the same requireVerified filter.
- **Then** small → 1-3 highest-confidence verified shared-only entries (~1.5k tok); medium → ≤6 incl. workspace conventions for serviceScope (~4k tok); large → ≤12 spanning shared+workspace + recent human-answers/approved-PR decisions (~8-10k tok)+parent digest; every injected entry carries a citation line [mem:<id> · <provenance> · conf=<n> · ref=<type>:<id>]; only verified entries reach the packet (unverified quarantined on BOTH channels). A call-site lint guards that no retrieval path skips the trust filter.

**Exercises:** `server/src/routes/issues.ts`, `server/src/services/agent-handoff.ts`, `server/src/services/memory.ts`, `server/src/services/heartbeat.ts`, `packages/context-budget/src/composer.ts`, `server/src/services/context-budget-telemetry.ts`, `server/src/services/__tests__/agent-handoff.test.ts`, `server/src/services/__tests__/issue-context-refs.test.ts`, `server/src/__tests__/issues-user-context.test.ts`, `server/src/services/__tests__/issues-delegation-policy.test.ts`

---

### S5 — Ask-don't-hallucinate HARD sufficiency gate withholds weak context and posts a gate-authored question

**Persona:** Sub-agent on a ticket with insufficient/low-confidence retrieved context · **Priority:** p0 · **Phase:** Phase 3 (gate flipped to ask-mode)

- **Given** 0049 + HOOK 1 are live (gate is a NO-OP before that, §2.8); memory-sufficiency.ts + sufficiency-budget.ts (NET-NEW) shipped; COMBYNE_SUFFICIENCY_GATE_ENABLED flipped to ask-mode after the label-only calibration pass; thresholds keyed by embedding_version (SUFFICIENCY_MIN_SCORE 0.22 / REQ_COVER_MIN 0.34 for hash-64).
- **When** At heartbeat self-retrieval (after ~3895-3947) and at EM passdown, evaluateSufficiency(queryRankedResult, trust fields, serviceScope, requirement tokens, complexity) returns 'insufficient' (topScore<min OR no verified human-answer/pr-approval item; entityCoverage===0; requirementCoverage<min). The HARD gate applies H1: it does NOT set combyneLongTermMemoryPreamble from sub-threshold entries (the agent never receives the weak context); and H2: it calls routeAgentQuestionsToManager (agent-question-routing.ts:205) with the gate's suggestedQuestion directly and transitions the issue to a blocked/awaiting state — independent of agent output (NOT the advisory extractAndPostQuestions path which only fires on outcome==='succeeded' at heartbeat.ts:5382).
- **Then** The agent does not fabricate from weak context (it never saw it); a question IS posted regardless of agent compliance; the issue blocks/awaits; the human's answer feeds HOOK 1 (S2) so the next evaluateSufficiency over the same subjectKey returns 'sufficient' (loop closed); guardrails hold — per-issue ask budget (max 2), per-subjectKey cooldown reusing existingKeys dedupe (agent-question-routing.ts:272-276), ask-only-when-decision-critical (entityCoverage===0), and assumption-flagged answers forced unverified by the input.assumption code flag (NOT the 'Assumption:' body prefix at :405); ask-rate alarm fires if >15% sustained.

**Exercises:** `server/src/services/heartbeat.ts`, `server/src/services/agent-question-routing.ts`, `server/src/services/agent-question-extract.ts`, `server/src/services/memory.ts`, `server/src/routes/issues.ts`, `server/src/services/__tests__/agent-question-extract.test.ts`, `server/src/services/__tests__/agent-question-routing.test.ts`, `server/src/__tests__/issues-question-answer.test.ts`

---

### S6 — Conflict: two users answer the same subject differently → UI override/merge/edit into one canonical entry

**Persona:** Operator/board reviewer resolving conflicting human-answers · **Priority:** p0 · **Phase:** Phase 1/3 (Conflicts is a must-have UI ask)

- **Given** 0049 trust spine with subjectKey + supersededById landed; two verified human-answer entries (HOOK 1, S2) on different tickets share the same normalized subjectKey but disagree; the Conflicts tab (MemoryConflicts.tsx + MemoryConflictResolver.tsx, NET-NEW) is shipped under /memory/conflicts.
- **When** The user opens the Conflicts tab — entries grouped by subjectKey HAVING conflicting human-answers, labeled 'Detected conflicts' (conservative key under-reports paraphrases). MemoryConflictResolver shows side-by-side bordered cards (ApprovalDetail precedent) with newest-by-that-user pre-highlighted (decision #5 default-surface), and the user picks OVERRIDE (one canonical, supersede other via supersededById), MERGE (third editable Textarea seeded from both → brand-new canonical, supersedes BOTH, both preserved for audit), or EDIT (free-edit canonical) → POST /companies/:companyId/memory/conflicts/:subjectKey/resolve (assertBoard).
- **Then** Exactly one canonical verified entry survives retrieval; losers are supersededById-excluded from queryRanked (excludeSuperseded); the sufficiency gate counts an unresolved-conflict subjectKey as covered (newest-by-that-user default-surfaced, so the agent is not starved) but the tab still raises it; a staleness note warns the correction may take up to the prompt-cache TTL to reach running agents; resolveConflict fires with the correct action payload and non-board principals are rejected.

**Exercises:** `ui/src/pages/CompanyMemory.tsx`, `ui/src/api/memory.ts`, `server/src/routes/memory.ts`, `server/src/services/memory.ts`, `server/src/services/__tests__/memory-service.test.ts`

---

### S7 — Redaction: an answer containing a secret/credential is caught before embed+write and quarantined

**Persona:** Human answering a credentials/access question (the escalate-to-human channel) · **Priority:** p0 · **Phase:** Phase 2 (ships WITH the embedding swap)

- **Given** secret-scan.ts (NET-NEW; redaction.ts is key-based only, SECRET_PAYLOAD_KEY_RE:1/JWT_VALUE_RE:3, cannot scan free-text bodies) and the Redaction queue tab (MemoryRedactionQueue.tsx) are shipped; the routing prompt explicitly escalates credentials to humans (agent-question-routing.ts:194), making the typed answer body a credential-bearing channel by design.
- **When** A human's answer (HOOK 1 body, S2) contains an sk-…/AKIA…/ghp_…/xoxb-…/bearer-JWT/postgres://user:pass@…/PEM key. Before any embedder egress AND before write, scanBody(text) runs (in both embedForStorage and embedQuery paths). On detection it redacts the span in 'clean' AND sets verificationState='needs_review' on the entry.
- **Then** The secret never both egresses to the managed embedder AND lands in the highest-trust never-expiring workspace tier; the entry is held in needs_review and EXCLUDED from retrieval until cleared; it surfaces in the Redaction queue rendered MASKED by default (no secret span in the DOM before an explicit board-only audited Reveal at POST /memory/entries/:id/redaction/reveal — a second egress surface controlled: cleartext to that principal only, never persisted client-side or logged); Approve-as-clean clears needs_review→verified, Redact-span rewrites and re-queues. The scanner is tested on BOTH the storage (createEntry) and query (embedQuery) paths.

**Exercises:** `server/src/redaction.ts`, `server/src/services/memory.ts`, `server/src/routes/issues.ts`, `server/src/routes/memory.ts`, `ui/src/pages/CompanyMemory.tsx`, `ui/src/api/memory.ts`, `server/src/__tests__/redaction.test.ts`

---

### S8 — Embedding quality: right context retrieved (recall@k); unset team key degrades to local hash-64 with zero egress

**Persona:** Operator measuring retrieval quality / running with or without the team embedding key · **Priority:** p0 · **Phase:** Phase 2 (embedding swap)

- **Given** 0052 pgvector columns (nullable, no HNSW yet) landed; embedding-driver.ts + memory-embedder.ts + memory-embed-cache.ts (NET-NEW) shipped; config follows the envVar pattern (COMBYNE_EMBEDDING_API_KEY→OPENAI_API_KEY, COMBYNE_VECTOR_SEARCH_ENABLED); the rankEntries query-embedding lift is in place and the cosineSimilarity version-equality guard added (memory.ts:71). The retrieval-quality harness (retrieval-quality.test.ts + fixtures/retrieval-eval.json, NET-NEW) exists.
- **When** (a) With the team key SET: createEntry/updateEntry/promotion async embedForStorage writes embedding_vec+embedding_version (redact-before-embed first), queryRanked computes embedQuery then pgvector pushdown (embedding_vec <=> $q ORDER BY … LIMIT k), and the harness runs queries against labeled expectedEntryIds. (b) With the key UNSET: vectorSearchEnabled is coerced false at config load → every path falls back to embedText hash-64 (no provider call, no egress) — createEntry writes hash-64+'hash-64:64' and never throws.
- **Then** recall@1/@5/@10, MRR, and right-context-retrieved-rate are computed; the CI tier runs against the deterministic hash-64 jsonb oracle (no network) as a hard merge gate, and the memory-ranker.test.ts oracle still passes (embedText deterministic+L2-normalized, cosine ordering preserved because the query-embedding was lifted OUT of rankEntries which stays pure+sync); the opt-in live-embedding tier asserts real-embedding recall@k > hash recall@k by a threshold; version-mismatch never cross-scores two spaces (falls back to hashing both sides); unset key = zero crash, zero egress, hash-64 local-only.

**Exercises:** `server/src/services/memory.ts`, `packages/db/src/schema/memory_layers.ts`, `server/src/services/__tests__/memory-ranker.test.ts`, `server/src/services/__tests__/memory-service.test.ts`, `server/src/config.ts`

---

### S9 — Central cutover: dogfooded embedded memory migrated to self-hosted via ETL with parity; refuses on empty/failed import

**Persona:** Operator promoting from embedded to self-hosted central Postgres · **Priority:** p1 · **Phase:** Phase 2 (self-hosted cutover, Option A)

- **Given** memory-export.ts / memory-import.ts (NET-NEW) + db:memory-export/import scripts exist (company-portability.ts carries NO memory table, so a naive DATABASE_URL swap silently boots an empty central DB and loses all dogfooded memory). docker-compose.yml is swapped to pgvector/pgvector:pg17; the central endpoint is migrated via pnpm db:migrate at direct :5432.
- **When** The operator runs db:memory-export from ~/.combyne-ai (dumps memory_entries + promotions + usage + agent_memory, NOT transcript_summaries, preserving layer/owner/tags/stored jsonb embedding byte-for-byte + trust columns + embedding_version), then db:memory-import --owner-remap local-board→<userId> against the central DB (idempotent on (companyId,layer,subject,source)), then points app DATABASE_URL at the central endpoint and switches DEPLOYMENT_MODE to authenticated+private. The cutover doc then verifies row+embedding parity.
- **Then** All dogfooded entries land in the central DB with row-count and stored-embedding parity (byte-for-byte jsonb); local-board personal rows are owner-remapped so they remain reachable; the cutover REFUSES to proceed without a verified non-empty import (hard gate, not a checklist line); after cutover requireVerified is flipped at both retrieval channels (Release N+1); transcript_summaries are never carried into the central store as fact.

**Exercises:** `server/src/services/company-portability.ts`, `server/src/services/memory.ts`, `packages/db/src/migrate.ts`, `docker-compose.yml`, `server/src/index.ts`

---

### S10 — Multi-team isolation: company B cannot read company A's memory; empty companyId fails closed; BYPASSRLS scans still work

**Persona:** Second company/teammate onboarding (multi-tenant boundary) · **Priority:** p0 · **Phase:** Phase 4 (RLS multi-team gate)

- **Given** Multi-team is locked; before company #2 or the first non-local authenticated multi-user, migration 0053 RLS policies (incl. the missing memory_usage FK+policy — memory_layers.ts:113 declares companyId as a bare uuid) + a CREATE ROLE … BYPASSRLS scheduler role are required; actorMiddleware does SET LOCAL app.current_company inside a per-request transaction; authz is hardened to fail-closed on empty companyId for ALL principals incl. local_implicit/isInstanceAdmin (authz.ts:12,25 currently skip the membership check); per-tenant agent-JWT key separation lands WITH RLS.
- **When** Company B (its agents, board, and every retrieval path — queryRanked, EM passdown, self-retrieval, usage-log) attempts to read company A's memory_entries/memory_usage; and a request arrives with empty/undefined companyId; and the background global heartbeat scan (heartbeat.ts:6559 db.select().from(agents) with no company filter) plus the scheduled decay/auto-distill run cross-company.
- **Then** Company B reads ZERO of company A's rows via every path (the CI cross-tenant isolation suite is a merge gate); empty/undefined companyId is rejected at the top of assertCompanyAccess for every principal (fail-closed); the background scans still return rows because they run as the BYPASSRLS scheduler role (the app role does NOT have BYPASSRLS) — instance-wide processing does not silently halt to zero-rows; SET LOCAL inside an explicit transaction (not plain SET on a pgbouncer transaction-mode checkout) prevents tenant leak across pooled backends.

**Exercises:** `server/src/routes/authz.ts`, `server/src/services/memory.ts`, `server/src/services/heartbeat.ts`, `packages/db/src/schema/memory_layers.ts`, `server/src/services/__tests__/memory-service.test.ts`, `server/src/services/__tests__/heartbeat-workspace-isolation.test.ts`, `server/src/__tests__/companies-route-path-guard.test.ts`, `server/src/services/__tests__/heartbeat-workspace-session.test.ts`

---

### S11 — Scale/hallucination guardrails: stale/duplicate/conflicting/superseded facts do not surface as authoritative

**Persona:** Operator/observer as the corpus grows large · **Priority:** p1 · **Phase:** Phase 4 (scale defenses + re-verification/observability)

- **Given** The scaling-defense stack (CENTRAL_CONTEXT_DB_PLAN §7) and HALLUCINATION_AT_SCALE clusters are implemented: provenance-aware decay (agent-claim 30d / verified-summary 180d / human-answer & pr-approval no-expiry), scheduled decay/auto-distill wired into the heartbeat scheduler, loadCandidates/runDecayPass given ORDER BY + pagination (removing the unordered .limit(500)/.limit(2000) windows, memory.ts:337/680), recency keyed off updatedAt (truth-age, breaking the rich-get-richer loop), auto-distill on COUNT(DISTINCT issue_id) excluding self-retrieval, supersededById conflict resolution, and the re-verification job demoting drifted verified rows to needs_review.
- **When** The DB accumulates many entries: a once-verified fact ages past freshness; duplicate captures re-fire (idempotent (companyId,source) upsert); two human-answers conflict on a subjectKey; an entry is superseded; a PR is reverted/issue deleted (sourceRefId drift); an unverified wrong entry climbs usage.
- **Then** Stale/duplicate/conflicting/superseded/drifted facts do NOT surface as authoritative in retrieval (superseded excluded, decay archives stale agent-claims, conflict losers excluded, drifted verified demoted to needs_review); the globally-best/stalest row is never invisible behind an arbitrary physical-slice window; guardrail metrics fire — candidate-cap-hit rate, semantic-score variance collapse, distinct-subject ratio in top-k, days-since-decay, verifiedAt age distribution, dup-rate, verified-rot; the residual (human-verified-but-wrong, stale-but-once-verified) is OBSERVABLE via per-query provenance/confidence/age telemetry, not hidden.

**Exercises:** `server/src/services/memory.ts`, `server/src/services/heartbeat.ts`, `server/src/routes/memory.ts`, `packages/db/src/schema/memory_layers.ts`, `server/src/services/__tests__/memory-service.test.ts`, `server/src/services/__tests__/memory-ranker.test.ts`

---

### S12 — Memory management UI: 8-tab shell with provenance/confidence/age, capture/verify/redaction/conflict queues, setup

**Persona:** Operator/board curator managing the memory layer · **Priority:** p1 · **Phase:** Phase 1 (Browse+badges first) → fast-follow queues

- **Given** CompanyMemory.tsx is converted to a path-driven tabbed shell using the Approvals.tsx Tabs+PageTabBar pattern; the eight tabs (Browse default, Capture, Verify, Conflicts, Redaction, Questions, Passdown, Setup) render under /memory/:tab; new reusable components (MemoryEntryCard, MemoryTrustBadges with ProvenanceBadge/VerificationBadge/ConfidenceMeter/MemoryCitationLine, MemoryConflictResolver, MemoryPassdownPicker, MemoryEntryEditDialog) are registered in DesignGuide.tsx; ui/src/api/memory.ts is extended beyond the thin {layer,status} shape.
- **When** The user browses entries with layer/kind/provenance/verificationState/confidence-bucket/serviceScope/age filters (FilterBar+Select); reviews newly-captured human-answer/pr-approval entries in the Capture inbox (Confirm/Edit/Discard); board-verifies agent-claims that hit N distinct-issue reuse + promotion proposals in the Verify queue (hybrid SLA, POST /memory/entries/:id/verify assertBoard); resolves conflicts (S6); clears redaction quarantine masked-by-default (S7); watches the sufficiency-gate Questions loop; audits EM passdown packets (read-only, from agent_handoffs.artifactRefs); and on Setup pastes the team-shared embedding key (masked, stored via secrets path, never echoed) with a required privacy-disclosure acknowledge checkbox before save plus Run-re-embed / Run-retrieval-eval actions.
- **Then** Each entry renders trust badges (verified=green/unverified=amber/needs_review=red), a confidence meter, age, and a [mem:<id> · <provenance> · conf=<n> · ref=…] citation; new-entry is workspace/personal-only (shared stays promotion-gated per packages/shared/src/validators/memory.ts:31-37, NOT server/src/validators); a sidebar pending badge on the Memory nav item sums capture+verify+conflicts+redaction depth; Setup save is BLOCKED until the disclosure is acked and the masked key is never echoed back; component (vitest/RTL) + route (assertBoard rejection) + filter + E2E (all 8 tabs navigate, pending pill matches queue depth) tests pass.

**Exercises:** `ui/src/pages/CompanyMemory.tsx`, `ui/src/api/memory.ts`, `server/src/routes/memory.ts`, `packages/shared/src/validators/memory.ts`, `packages/shared/src/types/memory.ts`, `server/src/services/__tests__/memory-service.test.ts`

---

## Enrichment sources

- doc/CENTRAL_CONTEXT_DB_PLAN.md (§3 trust spine, §4 write-hooks, §5 EM passdown, §6 cutover ETL, §7 scaling defenses, §8 RLS/pgvector, §9 resolved decisions, §10 migrations 0048-0053, §11 phased roadmap, §13 residuals)
- doc/MEMORY_UI_AND_QUALITY_PLAN.md (§0.3 canonical queryRanked, §1 embedding backend + redact-before-embed + retrieval-quality harness, §2 HARD sufficiency gate H1/H2, §3 8-tab UI incl. Conflicts/Redaction/Setup, §3.10 tests)
- doc/HALLUCINATION_AT_SCALE.md (Cluster 1 retrieval degradation 1.1-1.6, Cluster 2 fact lifecycle 2.1-2.6, Cluster 3 adversarial/trust 3.1-3.6, Cluster 4 tenant/scope 4.1-4.6)
- doc/QA.md (Combyne QA company-scoped workflow — separate subsystem, not memory; out of scope for this catalog)
- doc/SPEC.md (board governance, agent context delivery fat-payload/thin-ping, delegation lines — general framing, no memory-specific scenarios)
- dev_documentation.txt (no memory-specific scenarios — only a useCompanyPageMemory storage-key reference)
- server/src/services/memory.ts (embedText hash-64:34, cosineSimilarity:71, rankEntries:147, createEntry:228, loadCandidates:320, queryRanked, recordUsage, decay/auto-distill)
- server/src/services/heartbeat.ts (self-retrieval long-term block ~3895-3947, render verbatim ~3934-3947, extractAndPostQuestions gate at 5382 only on outcome==='succeeded')
- server/src/services/agent-question-routing.ts (routeAgentQuestionsToManager:205, answerInternalManagerQuestion:380, assumption flag:50/405, escalate-credentials prompt:194, existingKeys dedupe:272-276)
- server/src/services/issue-pull-requests.ts (merge():572 → approvalsSvc.approve with decisionNote/decidedByUserId — HOOK 2 fire point)
- server/src/services/accepted-work.ts (createMemoryFromEvent:365 agent-claim accepted_work write)
- server/src/services/agent-handoff.ts (createHandoff:143, artifactRefs always []:162, buildBriefMarkdown:24)
- server/src/redaction.ts (key-based sanitizeRecord; SECRET_PAYLOAD_KEY_RE:1, JWT_VALUE_RE:3 — cannot scan free-text body)
- server/src/routes/issues.ts (answer-question:1045-1112 HOOK 1 fire point; delegate:1170 → createHandoff:1218, complexity:1178-1179)
- server/src/routes/memory.ts (entries GET:67 layer/status filters; verify/promotions decidePromotion:321-350 assertBoard)
- server/src/routes/authz.ts (assertCompanyAccess:18; local_implicit/isInstanceAdmin bypass:12,25; actorType:'user':47)
- packages/db/src/schema/memory_layers.ts (memory_entries HEAD-0047 — no trust columns; embedding jsonb:44; memory_usage companyId bare uuid no FK:113)
- server/src/services/__tests__/memory-ranker.test.ts (the oracle: embedText determinism + L2-norm + cosine ordering — breaks if embedText goes async)
- server/src/services/__tests__/memory-service.test.ts (4-layer: shared-via-promotion, company-scoped queryRanked:304, promotion propose→approve)
- server/src/services/__tests__/agent-question-extract.test.ts (extractQuestionsFromText pure + extractAndPostQuestions DB integration, dedupe/cooldown)
- server/src/services/__tests__/agent-question-routing.test.ts (manager-first routing, EM internal answer wakes child)
- server/src/__tests__/issues-internal-question-routes.test.ts (sub-agent /ask-user → internal manager question → answer wakes child)
- server/src/__tests__/redaction.test.ts (key-based redaction oracle — extend for body-text secret-scan)
