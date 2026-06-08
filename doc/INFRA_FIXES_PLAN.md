# Infra-Fixes Plan — close the 2-DB discovery gaps & keep docs current

Branch `central-db`. Closes the five gaps from the discovery review, each surgical, each keeping the
server suite (892) + UI suite (26) + lint gates green. Ordered by leverage; phases A–D are independently
shippable, E is a documented future gate (not implemented now).

**Confirmed decisions (2026-06-08):** embedding config = **UI canonical** (Phase A as written); central DB
= **memory/context only**, but multi-modal Q&A answers (PDF/image) must be processed + captured (new
**Phase F**); production shared rail = **Cloud SQL** (Phase C target); global layer = **sparse,
admin-curated** (no broad enablement now).

---

## Phase A — Config wiring: activate UI-saved embedding settings  ·  `config.ts`, `config-file.ts`
**Problem (verified):** `routes/context-database.ts:216-219` writes `embeddingProvider/embeddingModel/
embeddingApiKey` to `config.json`, but `config.ts:315-319` reads them **env-only** — so UI-saved embedding
settings persist but never activate on restart. (The context URL was already wired this session; embeddings
are the remaining asymmetry. There's also a misleading comment at `context-database.ts:214` claiming
"loadConfig resolves the key.")

**Fix** (mirror the established `readConfigFileContextDatabaseUrl` bypass-reader pattern — no strict-schema change):
- `config-file.ts`: add `readConfigFileEmbedding(): { apiKey, provider, model, dim } | null` (bypass-schema
  read of the same keys `writeConfigFile` persists; never logs the key).
- `config.ts` (env-wins, then config.json):
  - `embeddingApiKey = envVar("EMBEDDING_API_KEY") ?? process.env.OPENAI_API_KEY ?? readConfigFileEmbedding()?.apiKey ?? ""`
  - same fall-through for `embeddingProvider` / `embeddingModel` / `embeddingDim`.
  - `vectorSearchEnabled` then naturally flips true once the resolved key is non-empty (existing coercion).
- `context-database.ts:214`: delete the inaccurate "loadConfig resolves the key" comment; replace with the
  truth ("activated on next restart; env still wins").
- (Optional, cleaner long-term) add the embedding block to `combyneConfigSchema` so the strict reader keeps
  it too — but the bypass reader is the minimal, consistent move.

**Test:** extend `config-context-db.test.ts` — write a `config.json` with the embedding block, no env →
`loadConfig().embeddingApiKey` resolves it and `vectorSearchEnabled === true`; env still overrides.
**Acceptance:** set the key in the UI Memory→Setup tab → restart → boot logs `hasKey:true` + vector ON with
**no env var set**. **Effort: S.**

---

## Phase B — Company-pin enforcement + `db:company-pin`  ·  `routes/memory.ts`, new seed script
**Problem (verified):** `contextCompanyId` exists only in `config.ts`; grep finds **zero** enforcement. The
shared rail can be addressed with any `companyId`, and teammates have no way to adopt one canonical UUID
(`companies.id` is `defaultRandom()`), so their context silently diverges.

**Fix:**
- **Enforce the pin** — in `routes/memory.ts` right after each `assertCompanyAccess(req, companyId)`
  (lines 40, 182, 239) and in the capture hooks: `if (resolveContextDbUrl() && cfg.contextCompanyId &&
  companyId !== cfg.contextCompanyId) throw forbidden("companyId does not match the pinned context tenant")`.
  Centralize as `assertPinnedCompany(companyId)` so it's one chokepoint. Fail-closed (403).
- **Adopt-the-pin glue** — new `pnpm db:company-pin --id <uuid> --name "<name>"`: insert/upsert the local
  `companies` row with an **explicit** id (instead of `defaultRandom()`) so every teammate's local company
  matches the shared UUID. ~20 lines using `createDb` + an upsert; mirrors the existing `db:*` script shape.
- Boot log: warn if `contextCompanyId` is set but no local company with that id exists yet.

**Test:** memory route — a `POST .../{OTHER}/memory/entries` with `OTHER !== contextCompanyId` (context DB
configured) → 403; the pinned id → 201. Script test: `db:company-pin --id X` creates `companies.id === X`.
**Acceptance:** with `COMBYNE_CONTEXT_COMPANY_ID` set, only the pinned company can read/write the shared rail;
a second machine `db:company-pin`-ing the same UUID shares context. **Effort: S–M.**

---

## Phase C — Context-DB backup guidance + recovery point  ·  runbook + optional scheduled export
**Problem (verified):** the app backup path is **ops-only** by design (the destructive `DROP TABLE … CASCADE`
dumper must never run against a live shared remote DB). The irreplaceable shared context DB has no app-level
recovery point — it's the operator's responsibility, undocumented.

**Fix (operational + doc, minimal code):**
- **Primary**: document enabling **Cloud SQL automated backups + PITR** on the context instance (the correct
  DR for a managed shared rail) in `doc/CENTRAL_DB_RUNBOOK.md`.
- **Portable add-on** (optional code): a scheduled / cron-able `pnpm db:memory-export` against
  `COMBYNE_CONTEXT_DATABASE_URL` (already context-DB-aware, non-destructive JSON bundle) → a second recovery
  format; rollback via `db:memory-import`. Document the cadence + retention.
- Keep the in-app `runDatabaseBackup` ops-only (it already warns about the shared rail at boot — keep that warn).
**Acceptance:** the runbook has a one-page "context-DB backup & restore" section; Cloud SQL automated backups
are on; an operator can restore the shared rail. **Effort: S** (mostly ops + docs).

---

## Phase D — Docs alignment ("make sure we're updated")  ·  `DATABASE.md`, `DEVELOPING.md`, `README.md`
**Problem (verified):** `doc/DATABASE.md` + `doc/DEVELOPING.md` still describe a single-DB world; `README.md`
and some docs reference `db:migrate` where the context path is `db:migrate:context`.

**Fix:**
- `doc/DATABASE.md`: document the **2-DB model** — local ops (embedded PG `:54329`, throwaway) vs shared
  context (`COMBYNE_CONTEXT_DATABASE_URL`, the rail); the env knobs (`CONTEXT_REQUIRED`, `CONTEXT_DB_MIGRATE`,
  `CONTEXT_COMPANY_ID`, `CONTEXT_TRACE`); the migration split (`db:migrate` ops vs `db:migrate:context`
  designated-migrator); the outbox; backups split.
- `doc/DEVELOPING.md`: the local-first dev flow + how to point at a shared context DB (Docker PG for dev).
- `README.md`: fix the `db:migrate` → add `db:migrate:context`; link the playbooks
  (`LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK`, `TWO_DB_TESTING_PLAYBOOK`, `CENTRAL_DB_RUNBOOK`, `IMPROVEMENT_PLAN`).
- Add a short "docs index" pointer so future changes keep these in sync.
**Acceptance:** a new reader of `DATABASE.md`/`DEVELOPING.md` sees the current 2-DB model and the correct
migrate commands; no doc references a single-DB-only world. **Effort: M** (writing).

---

## Phase E — RLS hardening path (DOCUMENT + TRACK; do NOT implement now)
**State (verified):** RLS is `ENABLE`-not-`FORCE` (dormant for the owner connection); isolation is currently
app-layer `WHERE company_id` (proven no-bleed in the T5 live test). This is correct for the local-first /
trusted-team case. Hard DB-level isolation is the **untrusted-multi-tenant** gate.

**Plan item (no code now):** write the **FORCE-flip runbook** — add a non-owner app role; `ALTER TABLE
memory_entries/memory_promotions/memory_usage/agent_memory FORCE ROW LEVEL SECURITY`; route every context
read/write through `withContextScope`/`withCompanyScope` (infra already built) so the GUC is bound on the
remote connection; flip with the cross-tenant non-owner test green. Track as a single ticket gated on the
**first untrusted team sharing one instance**. Effort when done: **L** — explicitly deferred.

---

## Phase F — Multi-modal Q&A answer capture (PDF / image → processed → central DB)  ·  *new feature*
**Requirement:** when a human answers a Q&A question with a **PDF or image** (attached to the answer), the
attachment's **content** must be processed and captured into the central DB — embedded + retrievable — not
left as an opaque "see attached".
**Gap (verified):** attachments link to the answer comment (`issue_attachments.issueCommentId`) and the
route already handles image mime types + serves `/api/attachments/:id/content`, but HOOK 1
(`captureHumanMemoryDurable`) captures **only the answer text** via `scanBody(answer)`. There is **no
PDF/image content extraction anywhere** in the codebase, so the attachment's content never reaches
`memory_entries` and is invisible to retrieval.

**Design** (the trust + timing choices are flagged — confirm before build):
- **Detect** attachments on the answer comment in the answer-question route (`issues.ts:1059`) and the
  internal-manager-answer path; gate on supported types (PDF, png/jpg/webp/gif).
- **Extract / process the content.** Two sub-paths:
  - **PDF** → server-side text extraction (a small lib, e.g. `pdf-parse`/pdfjs) — cheap, deterministic.
  - **Image** → a **vision** pass (describe + OCR). "Processed by the agent" → route this through the
    agent's Claude model (vision-capable) rather than a separate OCR engine, for in-context understanding.
- **Capture path (recommended: durable, deferred — reuses the outbox pattern):** at answer time, capture
  the text answer immediately (HOOK 1 as today) AND enqueue an **attachment-extraction job** keyed to the
  answer comment. A processor (server-side for PDF; the assigned agent / a vision call for images) extracts
  the content, runs **redact-before-embed** (`scanBody`), and **enriches/links a memory entry**
  (`sourceRefType:'attachment'`, the asset id) so the full Q&A — including the attached doc/image content —
  is embedded + retrievable. Failures retry via the same outbox mechanism (never lost).
- **Trust posture (decision):** the human *provided* the source (human-sourced), but the *extraction* is
  model-generated. Recommended: capture the extracted content as **provenance `human-answer` /
  `verified`** when it's a faithful transcription of a human-supplied PDF (the human vouched for it), and
  as **`verified-summary`** for a vision *description* of an image (a machine summary of a human-supplied
  source) — keeping the existing trust-spine semantics. Confirm which.
- **Edge cases:** large PDFs (cap + chunk to the embed budget); multi-page / multi-image answers (one
  linked entry per source or a concatenated capture); unsupported types (skip + note in the entry);
  extraction failure (keep the text answer, flag for retry); cost (vision calls are per-image — throttle).

**Tests:** answer-with-PDF → the extracted text lands in `memory_entries` (verified, embedded) sourceRef'd
to the attachment, redaction applied; answer-with-image → a description/OCR entry is captured; extraction
failure → text answer still captured + a pending-extraction outbox row exists; a follow-up `memory/query`
retrieves the attachment-derived content. **Effort: M–L** (largest item; it's a feature, not a gap-fix).

> This is the one **net-new feature** in the plan (you added it to the central-DB scope); the rest (A–E)
> are gap-closures. It's independent of A–E and can sequence last, or be split into its own PR.

## Sequencing & verification
A → B → C → D → F; E is documentation-only now. A and B are the two that most undermine the context DB if
left (a UI-set key that doesn't activate; a shared rail with no tenant boundary), so ship those first; F
(the multi-modal feature) is the largest and can land as its own PR. Run the full server suite + UI suite +
lint gates at every phase boundary; keep all green. Phases A/B/E touch code (small) + tests; C/D are docs +
one optional export cadence; F adds an extractor + a vision/agent path + the outbox-backed enrich job.

## Resolved + remaining decisions
**Resolved (2026-06-08):** UI-canonical embeddings · memory/context scope + multi-modal capture · Cloud SQL
production rail · sparse admin-curated global.
**Remaining (Phase F only, confirm before build):** (1) the **trust posture** for extracted content
(human-answer/verified for PDF transcription, verified-summary for image descriptions — as recommended?);
(2) the **image-processing path** — route through the assigned agent's Claude vision (in-context, matches
"processed by the agent") vs a dedicated server-side vision call (simpler, synchronous). I'll proceed with
the recommendation unless you say otherwise.
