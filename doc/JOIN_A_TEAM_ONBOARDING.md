# Join-a-Team Onboarding — Design & Implementation

## 1. What it does

A first-time user setting up a new ADE instance can now **join an existing team** instead of always creating a fresh company. From the onboarding wizard they can:

1. Connect to the **shared context database** (the central Postgres rail), or use one that is already configured via env/config-file.
2. **See the existing teams** registered on that DB (e.g. `Lending`).
3. **Pick one and join it**, so that this instance — and every agent it spawns — shares that team's context.

The mechanism is deliberately minimal: joining makes the **local ops company id identical to the shared team id**. Because `memory_entries.companyId` is a plain uuid with no foreign key (`server/src/db/memory_layers.ts:69`), a matching id is all that is needed for memory to route into the shared rail. No pin env var is set, no approval key is exchanged — join is open by design.

Local adoption (the company row + your membership + UI selection) is effective **immediately**. The memory-rail switch to the shared DB is **restart-gated** (the live pool is memoized per-URL in `services/context-db.ts`).

## 2. UX flow

Step 1 of the wizard (`ui/src/components/OnboardingWizard.tsx:786`) gains a two-button mode toggle at the top:

**Path A — Create a new company (default).** Byte-for-byte the existing flow (name + mission + the collapsible Database info panel), still routed through `handleStep1Next → companiesApi.create`. Gated to `step1Mode === 'create'` (wizard JSX at `:831`).

**Path B — Join an existing team** (`step1Mode === 'join'`, sub-panel at `:931`). Modeled on `MemoryDatabase.tsx`:

- **Connect.** On entering join mode the wizard calls `databaseApi.getStatus()`. If a context rail is **already configured** (`usingSeparateContextDb === true`), the URL field is hidden and a "Using already-configured shared context DB" note is shown; teams are listed with **no url** in the body. Otherwise a masked (`type=password`) "Shared context database URL" input is shown with a **Test connection** button (reuses `databaseApi.test`, renders the same reachable/unreachable probe block).
- **List.** "List teams" calls `databaseApi.listTeams(url?)` (`handleListTeams`, `OnboardingWizard.tsx:510-517`) and renders a clickable pick-list of `{id, name}`. Empty registry shows "No teams found … create a new company instead." Unreachable shows the probe error only — never the credential.
- **Pick.** Selecting a team sets `selectedTeamId` (`:1032`) and enables the Join button.
- **Join.** "Join team" calls `handleJoin()` (`:530-538`) → `databaseApi.join({ url?, teamId, teamName })`. On success it replicates `handleStep1Next`'s post-step-1 state: `setCompanyName(teamName)`, `setCreatedCompanyId`, `setCreatedCompanyPrefix`, `setSelectedCompanyId`, invalidate `companies.all` + (defensively) `contextDatabase.status`, then `setStep(2)`.
- **Restart note.** A yellow "**Restart required** — the shared context rail takes effect on the next boot; your team is adopted locally now" banner (`:1062`) is shown on success.

Steps 2–4 (agent, task, launch) are untouched and operate on the joined team's id exactly as for a created company. The footer Next is gated to create mode (`:1593`); a dedicated "Join team" button drives the transition in join mode (`:1607`). `Cmd+Enter` routes to `handleJoin()` when in join mode (`:717`).

## 3. New endpoints + server changes

All in `server/src/routes/context-database.ts`, inside `contextDatabaseRoutes(db)` where the injected `db` is the ops db (`server/src/app.ts:159`). Both routes are `assertInstanceAdmin(req)`-gated, identical to the existing three context-DB endpoints.

**Helper `listContextCompanies(url)` — `context-database.ts:133-164`.** Clones `probeContextDb`'s throwaway-connection pattern: `createDb(url, { connect_timeout: 30 })`, 2 attempts, **always** `$client.end({ timeout: 5 })` in `finally`, never throws. Runs `SELECT id, name FROM public.companies ORDER BY name`. Returns `{ ok, companies, error? }`, 200-safe. The error message is the exception message only — the url/credential is never echoed.

**`POST /instance/context-database/teams` — `context-database.ts:272-289`.** Lists joinable teams without persisting anything. Optional `url` (postgres-validated via `isPostgresUrl` when present, else `resolveContextDbUrl()`). In single-DB mode (no url resolved) returns `{ ok:false, companies:[], error:'No separate context database is configured' }` at 200. Otherwise returns `listContextCompanies(url)`.

**`POST /instance/context-database/join` — `context-database.ts:297-371`.** Adopts a team. Validated by `joinBodySchema = z.object({ url: z.string().min(1).optional(), teamId: z.string().uuid(), teamName: z.string().min(1) })` (`:172`) via `validate(...)` middleware. Flow:
1. `assertInstanceAdmin(req)` (`:301`).
2. Resolve URL: explicit body url (postgres-validated, 400 otherwise) else `resolveContextDbUrl()`; 400 `"No shared context database configured"` if empty (`:311-323`).
3. Re-list the registry (`:325`) and 400 `"Team not found in the shared context database registry"` if `teamId` absent — the open-join membership check (`:331`).
4. Persist the url via `writeConfigFile({ contextDatabaseUrl: url })` **only when a new url was supplied** (`:337`) — the same 0600 merge-write `POST /save` uses (`config-file.ts:82-101`).
5. `adoptPinnedCompany(db, { id: teamId, name: teamName })` (`:341`).
6. `accessService(db).ensureMembership(teamId, 'user', actor.actorId, 'owner', 'active')` (`:346`).
7. `logActivity(db, { companyId: teamId, action: 'company.joined', … })` (`:348`), mirroring the create route's audit convention.
8. Respond `{ joined:true, restartRequired: bodyUrl !== undefined, company:{id,name,issuePrefix}, redactedEndpoint: redactDbUrl(url), action }` (`:360-368`). `restartRequired` is true **only** when a new url was persisted.

Imports added at top of the file: `adoptPinnedCompany` from `../services/company-pin-adopt.js` (`:12`); `assertInstanceAdmin, getActorInfo` from `./authz.js` (`:7`); plus the already-present `accessService`/`logActivity`/`redactDbUrl`/`isPostgresUrl`/`writeConfigFile`/`resolveContextDbUrl`.

**Build-critical refactor.** `adoptPinnedCompany` (+ `AdoptResult` and the conflict detectors) was extracted out of `server/scripts/company-pin.ts` into a new `src/` module, `server/src/services/company-pin-adopt.ts`. The server build (`tsc`, `rootDir: "src"`, `include: ["src"]`) compiles only `src` into `dist`; importing from `../../scripts/company-pin.js` would have broken the rootDir constraint at build time and been absent from `dist` at runtime. `server/scripts/company-pin.ts` now re-exports from `../src/services/company-pin-adopt.js`, so the CLI and the existing `scripts/__tests__/company-pin.test.ts` keep their import path unchanged.

## 4. UI changes

- **`ui/src/api/database.ts`** — added `databaseApi.listTeams(url?)` (`:81`) and `databaseApi.join(payload)` (`:87`), plus the `ContextDatabaseTeamsResult` (`:53`) and `ContextDatabaseJoinResult` (`:65`) interfaces. `listTeams` posts `{ url }` only when a url is supplied (else `{}`), so the route honors an already-configured rail.
- **`ui/src/components/OnboardingWizard.tsx`** — `step1Mode` create/join toggle (`:123`); join-local state `joinUrl`, `joinProbe`, `joinTeams`, `selectedTeamId`, `joinLoading`, `joinError`, `contextDbStatus`; the join sub-panel (masked URL input + Test + List teams + pick-list + Join + restart banner); `handleListTeams()` and `handleJoin()`; footer Next gated to create mode and a "Join team" button for join. `reset()` clears all new join state and resets `step1Mode` to `'create'`.
- **`ui/src/lib/queryKeys.ts`** — no change needed; `queryKeys.contextDatabase.status` already existed for the defensive post-join invalidate.

## 5. How "join" adopts the team

The join works **purely by making the local ops company id equal the shared team id** — no pin env var is set or required.

- **Local company row at the canonical id.** `adoptPinnedCompany(db, { id: teamId, name: teamName })` creates the local `companies` row at `id === teamId` with a derived non-default `PIN<hex>` issue prefix. The id match is what lets memory route into the shared rail (`memory_entries.companyId` is a no-FK uuid, `memory_layers.ts:69`), with no referential link across DBs.
- **Idempotent / no-clobber.** A re-join finds the existing local row and returns `action:'kept'` — it never renames a live tenant (the no-clobber rule). `ensureMembership` updates rather than duplicates; `logActivity` records `action:'kept'`. Clicking Join twice is safe.
- **Open access.** No approval key, no pin handshake. The only gate beyond `assertInstanceAdmin` is the registry membership check (the team must exist on the shared DB).
- **Pin-fence no-op.** Join never sets `contextCompanyId` (that value is env-only), so `assertPinnedCompany`/`isPinnedCompany` stay inert — no 403 on subsequent memory routes. Routing succeeds entirely by local company id === team id.

## 6. Edge cases handled

- **Unreachable / invalid context DB url** — `listContextCompanies` mirrors `probeContextDb`: never throws, returns `{ ok:false, companies:[], error }` at 200. The error message never contains the url or credential. The join route returns 400 on a postgres-format failure or an unreachable probe, surfacing only the probe message.
- **Empty registry (zero teams)** — `/teams` returns `{ ok:true, companies:[] }`; UI shows "No teams found — create a new company instead" and disables Join. `/join` with any teamId 400s "Team not found …".
- **Re-join idempotency** — `action:'kept'`, no rename, no duplicate membership; response still `joined:true` so the UI selects + advances.
- **No separate-DB mode, no url supplied** — `/teams` returns `ok:false 'No separate context database is configured'`; `/join` 400s `'No shared context database configured'`. Only reachable via direct API call (the UI requires a listed url first).
- **Already-configured rail (env or config-file)** — UI hides the URL field and posts with no url; the route uses `resolveContextDbUrl()`; `restartRequired` comes back **false** (nothing re-persisted) while adoption is still immediate.
- **Local issue-prefix collision** — `adoptPinnedCompany`'s retry loop on `companies_issue_prefix_idx` derives `PIN<hex>` (then appends `A`s); join never crashes the UNIQUE index.
- **Restart semantics** — persisting the url only routes memory after a process restart (the live pool is memoized per-url); the yellow restart banner is mandatory. Local adoption + selection are effective immediately.
- **Non-instance-admin / agent actor** — both routes `assertInstanceAdmin(req)` first → 403; a rejected join writes no config file and adopts nothing. (Note on order: `validate(joinBodySchema)` runs before `assertInstanceAdmin`, so a *malformed* body from a non-admin 400s before the 403; a well-formed body correctly 403s.)
- **CompanyContext auto-select guard** — the joined local row exists server-side and `companies.all` is invalidated, so the stored `selectedCompanyId` survives `CompanyContext`'s auto-select effect instead of being discarded for `companies[0]`; the returned `issuePrefix` makes `/<prefix>/dashboard` navigation work.

## 7. Tests added + verification gate results

**Tests added**

- `server/src/routes/__tests__/context-database-routes.test.ts` (extended, stub harness): `/teams` and `/join` reject non-admin + agent actors with 403 (rejected `/join` writes no config file); `/teams` no-url single-DB → `ok:false` message; `/teams` against an unreachable TEST-NET-1 url (`postgres://user:topsecret@192.0.2.1:…`) → `ok:false` 200 with **no `topsecret` leak**; `/teams` + `/join` reject non-postgres url 400; `/join` rejects missing/invalid uuid teamId 400; `/join` no-url single-DB → 400. Uses the canonical `TEAM_ID = b405dc3d-3dbe-4d37-b1ad-3a3a8895192c`.
- `server/src/routes/__tests__/context-database-join.integration.test.ts` (NEW, two real embedded Postgres via `startTestDb` + `startIsolatedTestDb`): team-not-in-registry → 400; fresh adopt creates the local ops row at `id===teamId` with a non-default `PIN<hex>` prefix, grants membership, persists the url 0600, masks the credential; re-join idempotent (`action:'kept'`, no rename, no duplicate membership); `/teams` lists sorted; already-configured rail (no body.url) → `restartRequired:false`, no config write.
- `ui/src/components/__tests__/OnboardingWizardJoin.test.tsx` (NEW): mode toggle renders both buttons; join mode hides the URL field and calls `listTeams(undefined)` when a rail is configured; a successful join calls `setSelectedCompanyId(teamId)`, invalidates `["companies"]`, and advances to step 2.
- The existing `server/scripts/__tests__/company-pin.test.ts` (8 tests) still passes through the re-export, confirming the refactor preserved the adoption contract.

**Verification gate — GREEN**

- Typechecks: `@combyne/server`, `@combyne/ui`, `@combyne/shared` — all PASS (0 errors).
- Server production build (`tsc`): compiles clean; the new `company-pin-adopt` module lands in `dist`.
- Vitest server suites: `context-database-routes.test.ts` (26/26), `context-database-join.integration.test.ts` (5/5), `issues-agent-comment-question-extract.test.ts` (1/1) — 32/32 passed.
- Vitest UI: `OnboardingWizardJoin.test.tsx` — 3/3 passed.
- No `heartbeat.ts` or claude-local adapter changes are present in this working tree; no interference. Nothing was committed.

## 8. Follow-ups

- **Env-pin enforcement if a team later locks down.** Today join is open — any instance-admin who can reach the shared DB can adopt any team. The `assertPinnedCompany`/`contextCompanyId` fence stays inert because join never sets it. If a team later needs to be locked, set the `contextCompanyId` env pin on member instances; the fence then rejects cross-team memory routes. Joining a *pinned* team would need an approval/key handshake added to the open-join registry check (currently a pure membership-in-registry test). This is the natural place to gate access if/when a team goes private.
- **Live re-test from a fresh instance.** Stand up a clean ADE instance (no context url configured). In onboarding Step 1, choose "Join an existing team", enter the shared context DB url, "List teams", pick **Lending**, "Join team". Then confirm:
  1. The local ops `companies` row id `=== b405dc3d-3dbe-4d37-b1ad-3a3a8895192c` (the canonical Lending id).
  2. The join response carries `restartRequired:true` and a redacted endpoint (no credential).
  3. After restart, write a memory entry and verify `memory_entries.companyId = b405dc3d…` lands on the **shared rail** (queryable from the central DB, not the local ops DB).
  4. Re-running join is idempotent (`action:'kept'`, no rename).
- **Optional:** surface the joined team's existing memory/agents in the Step-4 launch summary so the user sees they are entering a populated team rather than an empty one.

Relevant files: `/Users/krishsharma/Desktop/ADE/server/src/routes/context-database.ts`, `/Users/krishsharma/Desktop/ADE/server/src/services/company-pin-adopt.ts`, `/Users/krishsharma/Desktop/ADE/server/scripts/company-pin.ts`, `/Users/krishsharma/Desktop/ADE/ui/src/api/database.ts`, `/Users/krishsharma/Desktop/ADE/ui/src/components/OnboardingWizard.tsx`, `/Users/krishsharma/Desktop/ADE/server/src/routes/__tests__/context-database-routes.test.ts`, `/Users/krishsharma/Desktop/ADE/server/src/routes/__tests__/context-database-join.integration.test.ts`, `/Users/krishsharma/Desktop/ADE/ui/src/components/__tests__/OnboardingWizardJoin.test.tsx`.