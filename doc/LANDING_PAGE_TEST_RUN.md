# Landing-Page Test Run — live tracking

Repo: **basic landing page** · Company: **test** · Adapter: claude_local (Sonnet)
Watch the trace as you go: `tail -f /tmp/combyne-dev.log | grep ctxtrace`
(or one ticket's whole lifecycle: `grep '"issueId":"<KEY>"' /tmp/combyne-dev.log`)

Each ticket is built to prove ONE hop of the 2-DB context loop. Assign to the **EM**
(she decomposes + passes context down to an engineer); you act as the human board.

---

## T0 — (done) warm-up: fresh pull
You already assigned the CEO to take a fresh pull of the repo. That just confirms the
workspace + git + the Sonnet CLI are wired. No context-flow assertion here.

---

## T1 — (small) Add the hero CTA button  ·  proves: question → human answer → context DB
**Assign to:** EM → engineer
**Title:** Add the primary call-to-action button to the hero
**Body:**
```
Add the main call-to-action button in the hero section. It should link to our
signup page. Match our brand. Keep it to the hero only for now.
```
*(Deliberately missing: the signup URL, the button label, and the brand color — the
agent cannot guess these, so it must ASK.)*
- **You do:** answer the agent's question, e.g.
  *"Label: 'Get Started Free'. Link: https://example.com/signup. Brand color: #4F46E5 (indigo), white text, rounded-md."*
- **Watch for:** `ctxtrace:context_write` `{provenance:"human-answer", shared:true, entryId}` and the entry under **Memory → Browse** (verified, workspace).
- **Pass when:** your answer is a verified row in the **Cloud SQL** context DB.

---

## T2 — (small/med) Add a secondary CTA  ·  proves: prior answer FLOWS into new work
**Assign to:** EM → engineer
**Title:** Add a secondary "Learn more" button next to the primary CTA
**Body:**
```
Add a secondary button beside the primary CTA in the hero. Make it visually
consistent with the button conventions we already settled on.
```
- **Expected:** the agent reuses T1's decisions (indigo brand, rounded-md, label style)
  **without re-asking** — it pulled them from the context DB / EM passdown.
- **Watch for:** `ctxtrace:context_retrieve` `{returned:>0}` citing T1, and/or `ctxtrace:context_passdown` `{entriesCited:>0}`.
- **Pass when:** the secondary button matches T1's conventions and the agent did **not** re-ask. *(This is the core "context flows" proof.)*

---

## T3 — (medium) Add a responsive nav bar  ·  proves: agent → PR → approval → decision captured
**Assign to:** EM → engineer
**Title:** Add a responsive top navigation bar
**Body:**
```
Add a top nav with the logo on the left and links: Home, Features, Contact.
It should collapse to a mobile menu on small screens. Open a PR.
```
- **Expected:** engineer branches, implements, **opens a PR** (appears in the ADE **PR panel**).
- **You do:** review in-app. If you request changes, agents are **held** (human-gated) — release a round with **"Let agents fix."** When happy, **approve** with a short decision note, e.g.
  *"Approved. Convention: semantic `<nav>`, mobile breakpoint at 768px, hamburger below it."*
- **Watch for:** `ctxtrace:context_write` `{provenance:"pr-approval", entryId}` + the entry under **Memory → Browse**.
- **Pass when:** your approval note is a verified `pr-approval` row in the context DB.

---

## T4 — (large) Make the whole page responsive  ·  proves: approved decision conditions later work + WIDER tier
**Assign to:** EM → engineer
**Title:** Make the entire landing page responsive
**Body:**
```
Make the hero, the features grid, and the footer fully responsive, consistent
with the responsive approach we approved for the nav. Open a PR.
```
- **Expected:** retrieval/passdown surface **T3's approved convention** (768px breakpoint,
  semantic elements); because this is a **large** ticket, the passdown tier widens.
- **Watch for:** `ctxtrace:context_passdown` `{tier:"large", layers:["shared","workspace"], entriesCited:>0}` and the output reusing T3's 768px/semantic decision (not a divergent re-invention).
- **Pass when:** the work follows T3's approved convention and the passdown tier is **larger** than T1/T2's.

---

## T5 — (edge) Rebrand the button color  ·  proves: conflict surfaced + no cross-company bleed
**Assign to:** EM → engineer
**Title:** Reconsider the CTA button color (rebrand)
**Body:**
```
We're rebranding. Capture the new decision for the primary button color and
update the hero CTA accordingly. Open a PR.
```
- **You do:** answer with a color **different from T1**, e.g. *"Switch primary to #059669 (emerald)."* — this conflicts with T1's indigo decision on the **same subject**.
- **Watch for:** `ctxtrace:context_conflict` (or the item appearing under **Memory → Conflicts**) for you to **override / merge / edit**; and every `ctxtrace:context_retrieve.companyId` equals the **test** company (never another company's).
- **Pass when:** the disagreement is **surfaced** (not silently overwritten) and there is **zero** cross-company bleed.

---

## Resilience drill (optional but recommended) — proves: a rail outage never loses an answer
Mid-run, briefly remove your IP from the Cloud SQL **Authorized networks** (or stop the
instance), then answer a question on any ticket:
- The answer still posts (HTTP 201).
- You see `ctxtrace:context_capture_enqueue` (queued, **not** lost), not `context_write`.
- Restore connectivity → next heartbeat tick shows `ctxtrace:context_capture_drain` and the
  entry appears in **Memory → Browse**.

---

## 📋 Tracking sheet (mark as we go)

| # | Ticket | Hop it proves | Signal to confirm | Result |
|---|---|---|---|---|
| T0 | fresh pull | workspace/git/CLI wired | task completes | ☐ |
| T1 | hero CTA | Q&A answer → context DB | `context_write{human-answer}` + Memory row | ☐ |
| T2 | secondary CTA | prior answer flows in | `context_retrieve.returned>0` / `context_passdown.entriesCited>0`; no re-ask | ☐ |
| T3 | responsive nav | PR approval → context DB | `context_write{pr-approval}` + Memory row | ☐ |
| T4 | full responsive | decision conditions later work + wider tier | `context_passdown{tier:large, layers:[shared,workspace]}` | ☐ |
| T5 | rebrand color | conflict surfaced + no bleed | `context_conflict` / Memory→Conflicts; all `companyId == test` | ☐ |
| R | rail-down drill | answer queued then replayed | `context_capture_enqueue` → `context_capture_drain` | ☐ |

When all rows are ✅ the 2-DB context rail is proven end-to-end on this repo.

### Running notes (fill in as we test)
- T1:
- T2:
- T3:
- T4:
- T5:
- R:
