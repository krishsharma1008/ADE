# Copy-Paste Tickets — Hiring + End-to-End Context-Flow Test

Companion to `doc/LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md`. Paste these into the ADE UI.
Replace `<REPO>` with your test repo and `<COMPANY_ID>` with the UUID you recorded in Playbook Part 3.

> Order: do **§A (hiring)** first, top-down, approving each hire in the Approvals panel.
> Then **§B (test tickets)** assigned to the EM (Maya), in order T1→T5.

---

## §A — Hiring tickets (create the org)

> Mechanics: agent creation is board-only; non-CEO hires need board approval (`requireBoardApprovalForNewAgents=true`) and sit in `pending_approval` until you approve. Adapter config is free-form JSON; for `claude_local`/`codex_local` the role/SOUL prompt goes in `instructionsFilePath` (point it at the file shown, or paste the prompt inline if your UI supports it).

### A1 — Hire the CEO (you create this one as board)
- **Name:** Atlas
- **Title/Role:** CEO
- **Reports to:** (none — top of org; you, the human, are the board above)
- **Adapter:** `claude_local`
- **Capabilities:** `can_create_agents: true`, `can_assign_tasks: true`
- **Budget:** small daily cap to start (enough for a few heartbeats)
- **Adapter config (`instructionsFilePath` → a file with this SOUL):**
  ```
  You are Atlas, CEO of <Company>. You set direction, hire and structure the
  engineering org, and convert board (human) goals into staffed work. You may
  create agents (subject to board approval). You do NOT write code yourself —
  you hire and delegate. When you lack information, ask the human board a
  question rather than guessing. Keep the org lean.
  ```

### A2 — CEO hires the Engineering Manager
*Create this as Atlas (or as board on Atlas's behalf), then approve it in Approvals.*
- **Name:** Maya
- **Title/Role:** Engineering Manager
- **Reports to:** Atlas (CEO)
- **Adapter:** `claude_local`
- **Capabilities:** `can_assign_tasks: true`, `can_create_agents: false`
- **Adapter config SOUL:**
  ```
  You are Maya, Engineering Manager. You receive tickets from the board/CEO,
  break them into engineer-sized work, and assign to your reports. Before
  passing work down, you compose a context packet from shared/workspace memory
  for the assignee. You review your engineers' PRs for fit before they reach
  the human board. If a ticket is underspecified, ask the human a precise
  question rather than letting an engineer guess. You do not write feature code
  yourself; you decompose, contextualize, and coordinate.
  ```

### A3 — EM hires Engineer "Rao" (claude_local)
- **Name:** Rao
- **Role:** Software Engineer
- **Reports to:** Maya (EM)
- **Adapter:** `claude_local`
- **Capabilities:** `can_assign_tasks: false`, `can_create_agents: false`
- **Adapter config SOUL:**
  ```
  You are Rao, a Software Engineer. You implement assigned tickets in the
  connected repo: create a branch, make the change, open a PR. Use the context
  packet your EM passes you and the shared memory; if a required decision is
  missing or ambiguous, ASK a question on the ticket instead of guessing.
  Follow accepted patterns already approved in this codebase. Keep PRs small
  and focused.
  ```

### A4 — EM hires Engineer "Lin" (codex_local)
- Same as A3 but **Name:** Lin, **Adapter:** `codex_local`. (Different runtime, same context DB — the cross-adapter check.)

### A5 — EM hires QA "Tess" (claude_local) *(optional but recommended)*
- **Name:** Tess, **Role:** QA Engineer, **Reports to:** Maya, **Adapter:** `claude_local`
- **SOUL:**
  ```
  You are Tess, QA. You verify that merged work matches the approved decision
  and the human's answers captured in memory. You flag regressions and
  mismatches between what was approved and what shipped.
  ```

**After §A you should have:** CEO Atlas → EM Maya → {Rao, Lin, Tess}, every hire approved, all `active`. This already tested the **hire → board-approval** path.

---

## §B — Test tickets (assign to EM "Maya", in order)

Each ticket below names the **hop it proves** and the **log/UI signal** to confirm (see Playbook Parts 6–7). Use a throwaway `<REPO>` so PRs are low-stakes.

### T1 — (small) Underspecified on purpose → forces a question → human answer captured
- **Title:** Add a `formatRelativeTime(date)` helper
- **Assign to:** Maya → an engineer
- **Body:**
  ```
  Add a helper that turns a timestamp into a human-relative string
  ("3 minutes ago"). Put it in the repo's util module and export it.
  ```
  *(Deliberately omits: which library? Intl vs a date lib? locale? "ago" vs "from now"?)*
- **Expected agent behavior:** asks a clarifying question on the ticket.
- **You do:** answer, e.g. *"Use native `Intl.RelativeTimeFormat`, en-US, past tense only, no extra deps."*
- **Proves:** HOOK 1 — answer → **context DB** (`provenance: human-answer`, verified, embedded).
- **Confirm:** `context_write{hook:"qa_answer", companyId:<COMPANY_ID>, issueId:<T1>, embedded:true}` log; entry under **Memory → Browse** (verified, workspace). 

### T2 — (small/medium) Depends on T1's answer → proves context *flows*
- **Title:** Use `formatRelativeTime` in the activity list
- **Body:**
  ```
  Render each activity row's timestamp using our relative-time helper.
  Match the conventions we already decided for that helper.
  ```
- **Expected:** the agent retrieves T1's verified answer (native `Intl`, en-US, past-only) from the context DB / EM passdown and follows it **without re-asking**.
- **Proves:** retrieval (requireVerified) + passdown citation across the 2-DB boundary.
- **Confirm:** `context_retrieve{issueId:<T2>, returned:>0}` including T1's entry; `context_passdown{entriesCited:>0}`. **This is the core "context flows" proof.**

### T3 — (medium) Real change → PR → human approval → decision captured
- **Title:** Add input validation to the `createIssue` form
- **Body:**
  ```
  Validate the title (non-empty, ≤120 chars) and show an inline error.
  Open a PR.
  ```
- **Expected:** engineer creates a branch + PR (outbound GitHub); appears in the ADE **PR panel**.
- **You do:** review in-app. If you request changes, agents are **held** (human-gated default) — release a round with **"Let agents fix."** When satisfied, **approve**.
- **Proves:** HOOK 2 — approval → **context DB** (`provenance: pr-approval`, verified).
- **Confirm:** `context_write{hook:"pr_approval", prNumber, issueId:<T3>, entryId}`; entry under **Memory → Browse**.

### T4 — (medium/large) Same subsystem as T3 → proves approved decision conditions later work + wider tier
- **Title:** Add validation to ALL create/edit forms, consistent with the issue form
- **Body:**
  ```
  Apply the same validation approach we approved for createIssue across the
  other create/edit forms. Keep it consistent.
  ```
- **Expected:** retrieval/passdown surface **T3's approved decision**; because this is a **large** ticket, the passdown tier widens (`large = ['shared','workspace']`, bigger budget) vs. T1/T2 small (`['shared']`, 1.5k).
- **Proves:** "right amount/quality of context per task size."
- **Confirm:** `context_passdown{tier:"large", layers:["shared","workspace"], truncated:false}`; the output reuses T3's pattern (not a divergent re-invention).

### T5 — (edge) No-bleed + conflict surfacing
- **Title:** Revisit the relative-time format decision
- **Body:**
  ```
  We're reconsidering: should relative time use a date library after all?
  Capture the new decision.
  ```
- **You do:** answer **differently** from T1 (e.g. *"Actually switch to `dayjs` relative time"*) to create a conflicting decision on the same subject as T1.
- **Proves (a) no bleed:** retrieval for T5 returns only `company_id=<COMPANY_ID>` (+ global) rows — never another company's.
- **Proves (b) conflict:** the T1-vs-T5 disagreement on the same `subjectKey` is **surfaced**, not silently overwritten.
- **Confirm:** `context_conflict{subjectKey, existingId, incomingId}` log; the conflict appears under **Memory → Conflicts** for you to **override / merge / edit**.

---

## §C — Pass/fail scorecard

| Hop | Ticket | Signal | Pass? |
|---|---|---|---|
| Q&A answer → context DB | T1 | `context_write{qa_answer}` + Memory entry (verified) | ☐ |
| Context flows to new ticket | T2 | `context_retrieve.returned>0` cites T1 + `context_passdown.entriesCited>0` | ☐ |
| PR approval → context DB | T3 | `context_write{pr_approval}` + Memory entry | ☐ |
| Decision conditions later work + wider tier | T4 | `context_passdown.tier=large, layers=[shared,workspace]` | ☐ |
| No cross-company bleed | T5 | every `context_retrieve.companyId == <COMPANY_ID>` | ☐ |
| Conflict surfaced (not silent overwrite) | T5 | `context_conflict` + Memory → Conflicts | ☐ |
| Whole lifecycle greppable | any | `grep '"issueId":"<id>"'` shows every hop in order | ☐ |

When all rows pass, the 2-DB context rail is proven end-to-end on one machine. Then do Playbook §6.6 (second instance, same `COMBYNE_CONTEXT_DATABASE_URL` + same `COMPANY_ID`) for the literal cross-teammate demonstration.
