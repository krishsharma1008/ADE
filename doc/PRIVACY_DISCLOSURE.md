# Privacy Disclosure — Managed Embedding Egress

> Companion to `doc/MEMORY_UI_AND_QUALITY_PLAN.md` §1.0/§1.5 and
> `doc/CENTRAL_CONTEXT_DB_PLAN.md` §9. This is the canonical, plain-language
> statement of what leaves the deployment when the managed embedder is enabled.
> The reconciliation here is carried verbatim in three places: this file, the
> **Setup-screen acknowledge checkbox** (`ui/src/pages/memory/MemorySetup.tsx`),
> and the §9 resolved-decisions block of the core plan.

## The one external dependency, by explicit choice

ADE's memory store is **100% self-hosted Postgres + pgvector**. The only data
that ever leaves the deployment is the text sent to a **managed embedding API**
(default OpenAI `text-embedding-3-*`), and only when an embedding key is
configured and vector search is enabled. This is a **deliberate reversal** of the
prior "no third-party-held data" posture **on exactly one axis** — the embedder —
chosen because quality embeddings materially improve retrieval. Storage,
governance, and the rest of the locked posture are unchanged.

The two prior docs (`CENTRAL_DB_DEPLOYMENT_OPTIONS.md §0`,
`HALLUCINATION_AT_SCALE.md`) are **superseded on this single axis** and must not
be read as still binding it.

## What is sent

- `subject + body`, **post-redaction**, for every newly-captured entry.
- The **query text** on retrieval (issue identifier + title + description),
  **post-redaction**.

Both egress paths run the body-text secret scanner **before** any provider call.

## What is NOT sent

- The team-shared embedding API key is **never logged** (sanitized via
  `sanitizeRecord`) and **never returned** by any endpoint — it is write-only.
- `transcript_summaries` are **never embedded**.
- With no key configured (or vector search disabled), there is **zero egress** —
  every path falls back to the local hash-64 embedder.

## The redact-before-embed guarantee — and its explicit bound

The scanner removes **known credential shapes** (API keys, bearer/JWT, connection
strings, PEM private keys, high-entropy tokens behind secret-ish labels) before
egress, and **quarantines** any entry on detection (`verificationState =
'needs_review'`, held out of retrieval, surfaced in the Redaction tab).

**It does NOT make egress private.** Redaction is best-effort regex:

- It will **miss novel secret shapes** it does not recognize.
- It does **not redact non-secret-but-sensitive business content at all** — a
  proprietary algorithm description, or a password phrased as prose ("the prod
  password is hunter2"), is sent as-is.

> **The disclosure bounds CREDENTIAL leakage; it does not guarantee body
> confidentiality.** This is a stated residual and must not be read as closed.

## Reveal is a second egress surface

The raw body of a `needs_review` entry is delivered (board-gated) by the
redaction-queue endpoint. The UI **masks it in the DOM by default** and renders
the cleartext only on an explicit **Reveal** click — to prevent accidental
shoulder-surfing / screen-capture exposure, not as a separate egress control.
The revealed body is never persisted client-side. Note: Reveal itself is a
client-side toggle and is **not** currently audit-logged (only the resolve
actions are); treat the queue endpoint's board gate as the access control.

## How to disable

Unset `COMBYNE_EMBEDDING_API_KEY` (and `OPENAI_API_KEY`) or set
`COMBYNE_VECTOR_SEARCH_ENABLED=false`. Either coerces the system to the local
hash-64 path: **local-only, zero egress.**
