# RUNBOOK — Deploy the ADE / Combyne Central Context DB (Self-Hosted)

> **Status:** hand-off-ready. A DevOps engineer who has never touched this repo can execute this end to end.
> **Destination:** `doc/CENTRAL_DB_RUNBOOK.md`.
> **Locked decisions this runbook obeys** (do not re-litigate): (1) **self-hosted** Postgres on the user's own infra — Docker-Compose-on-a-VM is the recommended first topology, managed PG in the user's own cloud account is the growth path; **we** install pgvector, run pgbouncer, own backups/PITR, set `max_connections`. No third-party SaaS, no managed Supabase/Supavisor. (2) **strict human-gated** memory trust. (3) **multi-team** → Postgres **RLS is a HARD GATE** before company #2 / the first non-local teammate. (4) Postgres + the ADE memory UI is the **single system of record** (no Obsidian).
> **Companion docs (read alongside):** `doc/CENTRAL_CONTEXT_DB_PLAN.md` (the plan), `doc/CENTRAL_DB_DEPLOYMENT_OPTIONS.md` (topology/ops trade-offs), `doc/HALLUCINATION_AT_SCALE.md` (the guardrail metrics in §6), `doc/DATABASE.md`, `doc/DEPLOYMENT-MODES.md`, `doc/DOCKER.md`.
> **Grounding note:** every command, path, env var, and script below was verified against the repo at HEAD migration `0047`. Anything that does not exist yet is explicitly tagged **[TO BE BUILT — Phase N]**. Do not assume a tagged item exists; if you reach a step that needs one and it is missing, **stop** — that phase's engineering work is a prerequisite, not optional.

---

## 0. Audience, scope, RACI

**Audience.** A platform/DevOps engineer executing the deployment. Assumes comfort with Docker Compose, `psql`, and basic Postgres ops. Assumes **no** prior knowledge of this codebase.

**Scope.** Stand up a self-hosted central Postgres (with pgvector), migrate the dogfooded memory into it, cut the app over, and (at the team boundary) enable RLS. **In scope:** DB provisioning, pooling, migrations, backups/PITR, the cutover ETL gate, RLS enablement, monitoring. **Out of scope:** writing the net-new application code (the trust-spine migrations `0048/0049/0051`, the `db:memory-export/import` scripts, migration `0052/0053`, the robust pooler detection, the `SET LOCAL` middleware). Those are **app-dev** deliverables; this runbook tells you exactly where each gate sits and refuses to proceed without them.

**This is a config-only deployment against an existing switch.** The app already selects external Postgres when `DATABASE_URL` is set (`server/src/index.ts:277`) and embedded Postgres (`127.0.0.1:54329`) when it is unset (`index.ts:283`, the `else` branch); resolution is `databaseUrl: process.env.DATABASE_URL ?? fileDbUrl` (`server/src/config.ts:241`). You are flipping that switch safely — not re-platforming.

### RACI

| Activity | DevOps (you) | App-dev | Owner sign-off |
|---|---|---|---|
| Provision VM / managed PG, networking, firewall | **R/A** | C | Platform lead |
| Image swap to `pgvector/pgvector:pg17`, compose override | **R/A** | C | — |
| Move plaintext compose secrets → secret store | **R/A** | C | Security |
| One-shot migration run + advisory-lock gating | **R/A** | C | — |
| Write migrations `0048/0049/0051/0052/0053` | I | **R/A** | EM |
| Build `db:memory-export` / `db:memory-import` scripts | I | **R/A** | EM |
| Robust pooler detection + pool sizing (`client.ts`) | C | **R/A** | EM |
| Run the memory ETL cutover (export → import → verify) | **R/A** | C | EM (go/no-go) |
| pgbouncer install + transaction/session split | **R/A** | C | — |
| Backups/PITR config + tested restore drill | **R/A** | C | Platform lead |
| `SET LOCAL` per-request txn middleware (`auth.ts`) | I | **R/A** | EM |
| RLS migration `0053` + `BYPASSRLS` role + CI isolation suite | C | **R/A** | EM + Security (HARD GATE) |
| Monitoring / alerting wiring | **R/A** | C | Platform lead |
| Go / no-go on each cutover | C | C | **Owner** |

R = Responsible, A = Accountable, C = Consulted, I = Informed.

---

## 1. Pre-flight — prerequisites and checklist

### 1.1 Tooling (on the box you run commands from)

| Tool | Min version | Verify |
|---|---|---|
| Docker Engine | 24+ | `docker --version` |
| Docker Compose v2 | 2.20+ (plugin form `docker compose`, **not** `docker-compose`) | `docker compose version` |
| `psql` client | 15+ (16/17 preferred) | `psql --version` |
| Node.js | `>=20` (repo `engines.node`) | `node --version` |
| pnpm | `9.15.4` (repo `packageManager`) | `pnpm --version` |
| Postgres server image | `pgvector/pgvector:pg17` | pulled in A1 |

Install repo deps once from the repo root (`/Users/krishsharma/Desktop/ADE`):

```bash
cd /Users/krishsharma/Desktop/ADE
pnpm install
# Optional: a full workspace build. NOTE: `pnpm db:migrate` does NOT need this —
# it runs `tsx src/migrate.ts` and reads migrations from packages/db/src/migrations
# directly (not dist/). `pnpm -r build` is only required to produce the Docker/server
# image (server/dist/index.js) and the UI bundle.
pnpm -r build
```

### 1.2 Access required

- Shell on the target VM (Part B) or your laptop/staging box (Part A).
- Network reachability to the DB port (`5432` direct, `6432`/your-choice for pgbouncer).
- Where secrets come from: **today** `DATABASE_URL` and `BETTER_AUTH_SECRET` arrive via env. In `docker-compose.yml`, the `server` service sets `DATABASE_URL` as a literal `postgres://combyne:combyne@db:5432/combyne` (`docker-compose.yml:23`) and `BETTER_AUTH_SECRET` is `${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET must be set}` (`docker-compose.yml:29`, compose-substituted from your shell/`.env`, errors if unset). The DB password being a literal in the compose file is the thing Part B §B2 moves into a real secret store.
- A strong `BETTER_AUTH_SECRET` (≥32 random bytes): `openssl rand -base64 48`.

### 1.3 Pre-flight checklist (all must be ✅ before Part A)

- [ ] `docker compose version` ≥ 2.20, `psql --version` ≥ 15, `node --version` ≥ 20, `pnpm --version` = 9.15.4
- [ ] `pnpm install` succeeds (and `pnpm -r build` if you will build the Docker image)
- [ ] You can reach a throwaway Postgres on the target network
- [ ] `BETTER_AUTH_SECRET` generated and stored where compose can read it
- [ ] You have read `doc/CENTRAL_CONTEXT_DB_PLAN.md` §6, §8 and `doc/CENTRAL_DB_DEPLOYMENT_OPTIONS.md` §5
- [ ] You know which Phase-1 deliverables are merged (run §1.4 below) — Part A's A2/A4/A6 **block** on them

### 1.4 Confirm which net-new pieces exist yet (run this — do not assume)

```bash
cd /Users/krishsharma/Desktop/ADE

# HEAD migration (expect 0047 today; 0048-0053 are the planned sequence)
ls packages/db/src/migrations/ | grep -E '^00(48|49|51|52|53)_' || echo "WARN: trust-spine/RLS/pgvector migrations not yet merged"

# Memory ETL scripts (expect ABSENT today -> [TO BE BUILT Phase 1])
grep -E '"db:memory-(export|import)"' package.json || echo "WARN: db:memory-export/import NOT built yet (Phase 1 prerequisite for cutover)"

# RLS in any migration (expect NONE today -> [TO BE BUILT Phase 4])
grep -rl -E "CREATE POLICY|ENABLE ROW LEVEL|BYPASSRLS" packages/db/src/migrations/ || echo "OK/expected: zero RLS today"

# Robust pooler detection (today: prepare:false ONLY for port 6543, client.ts:14-17)
grep -n "6543" packages/db/src/client.ts
```

> **Verified facts driving this runbook** (re-confirmed in the live tree at HEAD `0047`):
> - `db:migrate` (`package.json:14`) = `pnpm --filter @combyne/db migrate` → `tsx src/migrate.ts` (`packages/db/package.json`). `migrate.ts` reads `DATABASE_URL` **from env** and throws `"DATABASE_URL is required for db:migrate"` if unset (`migrate.ts:3-7`) — there is **no** positional URL arg. Always run it as `DATABASE_URL=... pnpm db:migrate`.
> - `db:backup` (`package.json:17`) → `./scripts/backup-db.sh` → `pnpm combyne db:backup`. The script header says **the embedded postgres must be running** (`scripts/backup-db.sh:11`). The underlying CLI **does** honor `DATABASE_URL` (`cli/src/commands/db-backup.ts:20-21`) so it can target the external central DB — but the **output directory** is taken from the `--dir` flag / config file, **NOT** from `COMBYNE_DB_BACKUP_DIR` (that env var only drives the *scheduled in-process* backups via `config.ts:208`). For a one-off CLI backup to a custom dir, pass `--dir` (see A8/B8).
> - Headless boot **auto-applies migrations with no advisory lock**: `promptApplyMigrations` returns `true` whenever `!stdin.isTTY || !stdout.isTTY` (`index.ts:135`); the migrate path (`applyPendingMigrations`, `client.ts:647-681`) opens connections with `max:1` but takes **no** `pg_advisory_lock`. Safe at one replica, a race at two.
> - `prepare:false` fires **only** for URL port `6543` (`client.ts:14-17`, whose comment explicitly scopes it to the *Supabase pooler*). A self-hosted pgbouncer on any other port/host gets `prepare:true` and breaks under transaction pooling until the **[TO BE BUILT]** robust detection (`COMBYNE_DB_DISABLE_PREPARE` / host substring) lands.
> - `createDb` passes **no** `max` (`client.ts:50-53`) → postgres-js default `max:10` per process.
> - `envVar("X")` reads `process.env.COMBYNE_X` (prefix added internally, `config.ts:25-26`). So `DEPLOYMENT_MODE`/`DEPLOYMENT_EXPOSURE`/`DB_*` are set as `COMBYNE_DEPLOYMENT_MODE` etc., while `DATABASE_URL`, `PORT`, and `BETTER_AUTH_SECRET` are read raw. The compose `COMBYNE_DEPLOYMENT_MODE`/`COMBYNE_DEPLOYMENT_EXPOSURE` (`docker-compose.yml:26-27`) are therefore correct.
> - **Health endpoint is `/api/health`** (mounted `api.use("/health", ...)` at `app.ts:129`, under `app.use("/api", api)` at `app.ts:172`). The bare `/health` path does **not** exist. The health JSON includes `database.mode` (`"external-postgres"` vs `"embedded-postgres"`, `index.ts:600-639`, `routes/health.ts`) — use that field as the authoritative external-vs-embedded check.

---

## PART A — LOCAL DRY-RUN FIRST (prove everything on a laptop/staging before any prod)

**The whole point of Part A:** never touch prod with an unproven sequence. Every step has an explicit **verify**. Do not advance to Part B until the EXIT CRITERIA at the end of Part A are all green.

Work in a scratch directory; use a throwaway DB you can drop. Set a session var for clarity:

```bash
export DRY=$HOME/ade-dryrun && mkdir -p "$DRY" && cd /Users/krishsharma/Desktop/ADE
```

### A1 — Bring up local self-hosted Postgres + pgvector via a compose override

Create a **non-destructive override** that swaps only the `db` image to a pgvector build and pins a local data volume. This leaves `docker-compose.yml` untouched.

`$DRY/docker-compose.pgvector.yml`:
```yaml
services:
  db:
    image: pgvector/pgvector:pg17     # was postgres:17-alpine; adds the `vector` extension
    environment:
      POSTGRES_USER: combyne
      POSTGRES_PASSWORD: combyne
      POSTGRES_DB: combyne
    ports:
      - "5432:5432"
    volumes:
      - pgdata_dryrun:/var/lib/postgresql/data

volumes:
  pgdata_dryrun:
```

Bring up **only the db** (app comes later, in A3):
```bash
cd /Users/krishsharma/Desktop/ADE
docker compose -f docker-compose.yml -f "$DRY/docker-compose.pgvector.yml" up -d db
```

**Expected output:** a `Started` line for the db container. Its name is `<project>-db-1`, where `<project>` defaults to the lowercased repo directory name (e.g. `ade-db-1` if the repo dir is `ADE`). Don't hard-code the name — resolve it from `docker compose ps`.

**Verify:**
```bash
docker compose -f docker-compose.yml -f "$DRY/docker-compose.pgvector.yml" ps   # db = healthy (healthcheck is in docker-compose.yml)
PGPASSWORD=combyne psql -h 127.0.0.1 -p 5432 -U combyne -d combyne -c "select version();"
# vector extension must be AVAILABLE in this image (not yet created — that's A5):
PGPASSWORD=combyne psql -h 127.0.0.1 -p 5432 -U combyne -d combyne -c \
  "select name, default_version from pg_available_extensions where name='vector';"
```
Expect a `vector` row. If absent, you pulled the wrong image — stop and fix.

Set the dry-run URL once:
```bash
export LOCAL_DB_URL="postgres://combyne:combyne@127.0.0.1:5432/combyne"
```

### A2 — Run migrations one-shot and verify the schema (incl. 0048–0053)

Run the migrator against the empty DB **explicitly** (not via app boot):
```bash
cd /Users/krishsharma/Desktop/ADE
DATABASE_URL="$LOCAL_DB_URL" pnpm db:migrate
```

**Expected output:** `Applying N pending migration(s)...` then `Migrations complete` (`migrate.ts:13,20`), or `No pending migrations` on a re-run — it is idempotent (`migrate.ts:11`).

**Verify the schema and the migration journal:**
```bash
# applied migrations recorded by drizzle (table lives in the "drizzle" schema, see client.ts:154-160)
PGPASSWORD=combyne psql -h 127.0.0.1 -p 5432 -U combyne -d combyne -c \
  "select count(*) from drizzle.__drizzle_migrations;"
# core memory table exists
PGPASSWORD=combyne psql -h 127.0.0.1 -p 5432 -U combyne -d combyne -c "\d memory_entries"
```

**Verify the trust-spine columns are present** (these prove `0048/0049/0051` shipped — **[TO BE BUILT — Phase 1]**; at HEAD `0047` `memory_entries` has only `id, company_id, layer, owner_type, owner_id, subject, body, kind, tags, service_scope, source, embedding, status, usage_count, last_used_at, ttl_days, created_by, created_at, updated_at` — `schema/memory_layers.ts:28-50`. If the migrations are not merged, this check FAILS and Part A cannot prove the trust path — coordinate with app-dev before continuing):
```bash
PGPASSWORD=combyne psql -h 127.0.0.1 -p 5432 -U combyne -d combyne -c \
  "select column_name from information_schema.columns
   where table_name='memory_entries'
     and column_name in ('provenance','verification_state','confidence','author_type',
                         'subject_key','superseded_by_id','embedding_version');"
```
Expect those 7 trust-spine columns (from `0049`). Also confirm `owner_id` is `text` (migration `0048`; **today it is `uuid`** — `schema/memory_layers.ts:37`):
```bash
PGPASSWORD=combyne psql -h 127.0.0.1 -p 5432 -U combyne -d combyne -c \
  "select data_type from information_schema.columns
   where table_name='memory_entries' and column_name='owner_id';"   # today: uuid; after 0048: text
```
`0052` (pgvector) and `0053` (RLS) are validated in A5 and A6.

### A3 — Point the app at the local DB and smoke-test

Bring the app up against the same compose, with `DATABASE_URL` pointing at the dry-run DB. Because this is a single replica, boot-time auto-migration is safe; make it **explicit** so behavior is not incidental:

```bash
export BETTER_AUTH_SECRET="$(openssl rand -base64 48)"
COMBYNE_MIGRATION_AUTO_APPLY=true \
docker compose -f docker-compose.yml -f "$DRY/docker-compose.pgvector.yml" up -d server
```
(`docker-compose.yml`'s `server` already sets `DATABASE_URL=postgres://combyne:combyne@db:5432/combyne`, `COMBYNE_DEPLOYMENT_MODE=authenticated`, `COMBYNE_DEPLOYMENT_EXPOSURE=private`, `PORT=3100`, `SERVE_UI=true` — `docker-compose.yml:23-28`.)

**Verify — the authoritative check is the health JSON `database.mode`, not the log:**
```bash
# Correct path is /api/health (app.ts:129 + app.ts:172). NOT /health.
curl -fsS http://localhost:3100/api/health
# The JSON includes a `database` object: expect "mode":"external-postgres" (index.ts:600-639).
curl -fsS http://localhost:3100/api/health | grep -o '"mode":"[a-z-]*"'   # expect "mode":"external-postgres"
# Log line is a secondary confirmation:
docker compose -f docker-compose.yml -f "$DRY/docker-compose.pgvector.yml" logs server | grep -i "Using external PostgreSQL via DATABASE_URL/config"   # index.ts:281
```
Open the memory UI (`ui/src/pages/CompanyMemory.tsx`) and create one `workspace` entry; confirm it appears with `psql`. **Use only columns that exist at HEAD `0047`** — `verification_state`/`provenance` do NOT exist until `0049`:
```bash
PGPASSWORD=combyne psql -h 127.0.0.1 -p 5432 -U combyne -d combyne -c \
  "select id, layer, kind, subject, source, created_at from memory_entries order by created_at desc limit 5;"
# Once 0049 is merged, you may also select verification_state, provenance.
```

### A4 — Memory ETL dry-run (embedded → local), byte-identical embedding + owner-remap

> **[TO BE BUILT — Phase 1]** `db:memory-export` / `db:memory-import` do **not** exist yet (confirmed: not in `package.json`; `server/src/services/company-portability.ts` carries no memory table). **This step cannot run until app-dev ships them.** It is the single most dangerous gap: switching `DATABASE_URL` today boots an **empty** central DB and **loses all dogfooded memory**. Treat the scripts' contract below as the acceptance spec, and treat this step as a **refuse-to-proceed gate** for the real cutover (Part B §B5).

Required contract for the scripts (from `doc/CENTRAL_CONTEXT_DB_PLAN.md` §6.5):
- `db:memory-export` dumps `memory_entries` (+ promotions, + usage, + `agent_memory`; **NOT** `transcript_summaries`) to JSON, preserving layer/owner/tags + the **stored jsonb embedding byte-for-byte** (the column is `jsonb("embedding")` — `schema/memory_layers.ts:43`) + trust columns + `embeddingVersion`.
- `db:memory-import` inserts under the target company id via the memory service, idempotent on `(companyId, layer, subject, source)`, with an owner-remap for personal entries that maps the `local-board` principal (`server/src/middleware/auth.ts:24`) to a real `<userId>`.

**Dry-run procedure** (once built):
```bash
# 1. Source = the embedded DB you have been dogfooding (default ~/.combyne/instances/<id>/db,
#    per home-paths.ts:36-37). Start the source instance so its embedded PG is reachable on
#    127.0.0.1:54329 (index.ts:412), OR run export against its socket.
#    Source row count BEFORE export (the assertion baseline):
SRC_URL="postgres://combyne:combyne@127.0.0.1:54329/combyne"
PGPASSWORD=combyne psql "$SRC_URL" -c "select count(*) from memory_entries;"   # record N_src

# 2. Export
DATABASE_URL="$SRC_URL" pnpm db:memory-export --out "$DRY/memory-export.json"

# 3. Import into the local pgvector DB, remapping the local board principal to a real userId.
#    Confirm the exact --owner-remap flag spelling against the shipped script (see Unresolved).
DATABASE_URL="$LOCAL_DB_URL" pnpm db:memory-import \
  --in "$DRY/memory-export.json" \
  --owner-remap "local-board=<userId>"
```

**Verify (row-count parity + embedding fidelity):**
```bash
# Target count must equal source count (idempotent re-runs must NOT inflate it)
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c "select count(*) from memory_entries;"   # expect == N_src
# Re-run the import; count must be unchanged (idempotency on (companyId, layer, subject, source))
DATABASE_URL="$LOCAL_DB_URL" pnpm db:memory-import --in "$DRY/memory-export.json" --owner-remap "local-board=<userId>"
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c "select count(*) from memory_entries;"   # expect == N_src still
# Embedding must be byte-identical for a sampled row (compare jsonb on both sides by source)
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c \
  "select source, md5(embedding::text) from memory_entries order by source limit 5;"
# local-board personal rows must now be owned by <userId>, none left as 'local-board'.
# NOTE: owner_id is uuid at HEAD; the cast below is valid only AFTER migration 0048 widens it to text.
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c \
  "select count(*) from memory_entries where layer='personal' and owner_id::text='local-board';"   # expect 0
```
Any mismatch (count, embedding md5, or stray `local-board`) is a **stop**.

### A5 — Enable + verify pgvector (`CREATE EXTENSION vector`, an ANN query)

> Migration `0052` is **[TO BE BUILT — Phase 4]** and adds `CREATE EXTENSION vector` + a nullable `embedding_vec vector(N)` column with **no HNSW index yet** (HNSW built last, after the dimension is validated — `CENTRAL_CONTEXT_DB_PLAN.md` §10 row 0052). In Part A you prove the extension and a hand-rolled ANN query work on the pgvector image, so the prod path is de-risked.

```bash
# Enable the extension (idempotent)
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c "\dx vector"   # confirm installed
```
**Verify an ANN distance query works** (scratch table — proves operators are available without depending on `0052`):
```bash
PGPASSWORD=combyne psql "$LOCAL_DB_URL" <<'SQL'
CREATE TEMP TABLE vtest(id int, v vector(3));
INSERT INTO vtest VALUES (1,'[1,0,0]'),(2,'[0,1,0]'),(3,'[0.9,0.1,0]');
SELECT id, v <=> '[1,0,0]' AS cosdist FROM vtest ORDER BY v <=> '[1,0,0]' LIMIT 2;
SQL
```
Expect ids `1` then `3` (nearest first). If `0052` is merged, additionally confirm the real column + that **no HNSW index exists yet**:
```bash
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c "\d memory_entries" | grep -i embedding_vec
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c \
  "select indexname from pg_indexes where tablename='memory_entries' and indexdef ilike '%hnsw%';"   # expect empty until validated
```

### A6 — Enable + verify RLS locally (policies, `SET LOCAL` in a txn, BYPASSRLS scanner, cross-tenant test)

> Migration `0053` (RLS policies + `BYPASSRLS` role) and the per-request `SET LOCAL` middleware are **[TO BE BUILT — Phase 4]**. Author and CI-test them against the single dry-run tenant here so the team flip in Part C is a switch, not a build. If `0053` is not merged, run the **manual reproduction below** to prove the mechanism and the isolation property on the dry-run box.

**Verify the policies + role exist (when `0053` is merged):**
```bash
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c \
  "select tablename, policyname from pg_policies where tablename in ('memory_entries','memory_usage');"
PGPASSWORD=combyne psql "$LOCAL_DB_URL" -c \
  "select rolname, rolbypassrls from pg_roles where rolname in ('combyne_app','combyne_scheduler');"
# app role must NOT have BYPASSRLS; scheduler role MUST. (Final role names are defined by 0053 — match them.)
```

**Manual mechanism proof + cross-tenant isolation test** (works even before `0053`; demonstrates exactly what `0053` must encode). The INSERT below uses only columns that exist at HEAD `0047` (`subject`/`body` are `NOT NULL`; `kind` has a default; `schema/memory_layers.ts:28-50`):
```bash
PGPASSWORD=combyne psql "$LOCAL_DB_URL" <<'SQL'
-- two tenants, two rows (company_id is a real FK to companies; use ids that exist or relax the FK in this scratch DB)
INSERT INTO memory_entries (id, company_id, layer, kind, subject, body)
VALUES (gen_random_uuid(), '00000000-0000-0000-0000-00000000000A','workspace','fact','A-secret','only A')
ON CONFLICT DO NOTHING;
INSERT INTO memory_entries (id, company_id, layer, kind, subject, body)
VALUES (gen_random_uuid(), '00000000-0000-0000-0000-00000000000B','workspace','fact','B-secret','only B')
ON CONFLICT DO NOTHING;

-- the policy 0053 must create (illustrative):
ALTER TABLE memory_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_entries;
CREATE POLICY tenant_isolation ON memory_entries
  USING (company_id = current_setting('app.current_company', true)::uuid);

-- per-request pattern: SET LOCAL inside a txn (auto-cleared at COMMIT, pooler-safe)
BEGIN;
  SET LOCAL app.current_company = '00000000-0000-0000-0000-00000000000A';
  SELECT company_id, subject FROM memory_entries;   -- EXPECT: only A rows
COMMIT;

BEGIN;
  SET LOCAL app.current_company = '00000000-0000-0000-0000-00000000000B';
  SELECT company_id, subject FROM memory_entries;   -- EXPECT: only B rows (zero of A)
COMMIT;
SQL
```
> **FK caveat:** `memory_entries.company_id` is a real FK to `companies` (`schema/memory_layers.ts:32-34`). In a throwaway scratch DB either insert matching `companies` rows first or drop the FK for the test. This does **not** apply to `memory_usage.company_id`, which is a **bare uuid with no FK** (`schema/memory_layers.ts:113`) — the highest-volume, weakest-scoped tenancy table that `0053` must add both an FK and a policy to.

**Pass criteria:** company B's transaction returns **zero** of company A's rows and vice-versa. Then prove the **BYPASSRLS scanner** sees everything (this is what the heartbeat global scan `db.select().from(agents)` at `heartbeat.ts:6559` needs, or instance-wide processing silently returns zero rows):
```bash
PGPASSWORD=combyne psql "$LOCAL_DB_URL" <<'SQL'
CREATE ROLE combyne_scheduler BYPASSRLS LOGIN PASSWORD 'scheduler_pw';
GRANT SELECT ON memory_entries TO combyne_scheduler;
SQL
PGPASSWORD=scheduler_pw psql "postgres://combyne_scheduler@127.0.0.1:5432/combyne" -c \
  "select count(distinct company_id) from memory_entries;"   # EXPECT: 2 (sees all tenants)
```
**Clean up** the manual policy/role before continuing so they don't pollute later steps (`DROP POLICY`, `DROP ROLE`, delete the two test rows) — RLS proper lands via `0053` in Part C.

### A7 — pgbouncer in transaction mode locally (prepare-disabled + pool sizing)

> Robust pooler detection (`COMBYNE_DB_DISABLE_PREPARE` / host substring) is **[TO BE BUILT — Phase 2]**; today `prepare:false` fires only for port `6543` (`client.ts:14-17`, Supabase-specific). Until that ships, you MUST force `prepare:false` for pgbouncer transaction mode or named prepared statements break. Prove the wiring locally.

Add pgbouncer to the override (`$DRY/docker-compose.pgbouncer.yml`). **Note:** the `edoburu/pgbouncer` image listens on container port **5432**, not 6432 — map host `6432` → container `5432`:
```yaml
services:
  pgbouncer:
    image: edoburu/pgbouncer:latest
    environment:
      DB_HOST: db
      DB_USER: combyne
      DB_PASSWORD: combyne
      DB_NAME: combyne
      POOL_MODE: transaction          # transaction mode for stateless app traffic
      MAX_CLIENT_CONN: "200"
      DEFAULT_POOL_SIZE: "20"          # backends pgbouncer opens to Postgres
      LISTEN_PORT: "6432"              # if your image build honors it; otherwise keep container port 5432 below
    ports:
      - "6432:5432"                    # host 6432 -> container 5432 (edoburu default listener)
    depends_on:
      db:
        condition: service_healthy
```
```bash
docker compose -f docker-compose.yml -f "$DRY/docker-compose.pgvector.yml" -f "$DRY/docker-compose.pgbouncer.yml" up -d pgbouncer
```
**Verify pooling + prepared-statement disable** (point the app at pgbouncer and force prepare off; once Phase-2 detection lands, `COMBYNE_DB_DISABLE_PREPARE=true` replaces the manual force):
```bash
# Confirm you can reach pgbouncer on host 6432 and it is in transaction mode:
PGPASSWORD=combyne psql "postgres://combyne:combyne@127.0.0.1:6432/combyne" -c "show pool_mode;"   # expect: transaction
# Re-run the app against pgbouncer (in-network the app reaches pgbouncer on container port 5432):
DATABASE_URL="postgres://combyne:combyne@pgbouncer:5432/combyne" \
COMBYNE_DB_DISABLE_PREPARE=true \
COMBYNE_DB_POOL_MAX=10 \
docker compose -f docker-compose.yml -f "$DRY/docker-compose.pgvector.yml" -f "$DRY/docker-compose.pgbouncer.yml" up -d server
curl -fsS http://localhost:3100/api/health | grep -o '"mode":"[a-z-]*"'   # still external, now via pooler
```
> Until the **[TO BE BUILT — Phase 2]** `COMBYNE_DB_DISABLE_PREPARE` flag exists in `pgOptions` (`client.ts:14-17`), setting it has **no effect** — the only path that disables prepared statements today is URL port `6543`. So either (a) run pgbouncer on `6543` as a stopgap, or (b) land the Phase-2 detection before pooled traffic. Verify which is true in your tree before relying on this step.

**Pool sizing check** — confirm backends stay bounded (the budget math in §B7): `SHOW POOLS;` on pgbouncer's admin should show `cl_active` rising while `sv_active` stays ≤ `DEFAULT_POOL_SIZE`.

### A8 — Backup + restore drill

`db:backup` honors `DATABASE_URL` for the *connection* (`cli/src/commands/db-backup.ts:20-21`) but takes the *output dir* from `--dir` (or config), **not** from `COMBYNE_DB_BACKUP_DIR`. Pass the dir through pnpm with `--`:
```bash
cd /Users/krishsharma/Desktop/ADE
DATABASE_URL="$LOCAL_DB_URL" pnpm db:backup -- --dir "$DRY/backups"
ls -lh "$DRY/backups"
```
Also take a raw `pg_dump` you can restore independently (the portable artifact):
```bash
PGPASSWORD=combyne pg_dump -h 127.0.0.1 -p 5432 -U combyne -d combyne -Fc -f "$DRY/combyne.dump"
```
**Restore drill into a scratch DB and diff row counts (the part most teams skip):**
```bash
PGPASSWORD=combyne createdb -h 127.0.0.1 -p 5432 -U combyne combyne_restore
PGPASSWORD=combyne pg_restore -h 127.0.0.1 -p 5432 -U combyne -d combyne_restore "$DRY/combyne.dump"
for t in memory_entries memory_usage agent_memory; do
  echo -n "$t orig="; PGPASSWORD=combyne psql "$LOCAL_DB_URL" -tA -c "select count(*) from $t;"
  echo -n "$t rest="; PGPASSWORD=combyne psql "postgres://combyne:combyne@127.0.0.1:5432/combyne_restore" -tA -c "select count(*) from $t;"
done
```
**Pass criteria:** every `orig` == `rest`. Drop the scratch DB after.

### A9 — Rollback drill (DATABASE_URL back to embedded)

Prove you can revert to the pre-cutover state with zero data risk:
```bash
# Stop the external-pointed app and start it with NO DATABASE_URL -> embedded auto-starts at 127.0.0.1:54329 (index.ts:283 else-branch, :412)
docker compose -f docker-compose.yml -f "$DRY/docker-compose.pgvector.yml" stop server
# Run the binary/dev with DATABASE_URL unset to confirm embedded boot:
DATABASE_URL= pnpm dev   # or the container with the env removed
```
**Verify** the app booted embedded (the health JSON shows `"mode":"embedded-postgres"`; the log shows `Embedded PostgreSQL ready` / `Postgres ready at postgres://combyne:combyne@127.0.0.1:54329/...`, index.ts:422-425) and the embedded DB is intact:
```bash
curl -fsS http://localhost:3100/api/health | grep -o '"mode":"[a-z-]*"'   # expect embedded-postgres
PGPASSWORD=combyne psql "postgres://combyne:combyne@127.0.0.1:54329/combyne" -c "select count(*) from memory_entries;"
```
Embedded is untouched by anything in Part A — rollback is "unset `DATABASE_URL` and restart." Confirm it, then re-point forward.

### Part A — HARD EXIT CRITERIA (ALL must be green before Part B)

- [ ] **A1** pgvector image up, `vector` extension *available*
- [ ] **A2** `pnpm db:migrate` clean; trust-spine columns present and `owner_id = text` (or Phase-1 blocker logged)
- [ ] **A3** app health JSON shows `database.mode=external-postgres` (and log `Using external PostgreSQL via DATABASE_URL/config`); a UI-created entry visible in `psql`
- [ ] **A4** ETL export→import row counts equal source, **idempotent** on re-run, embedding md5 identical, zero stray `local-board` — OR the scripts are flagged **[TO BE BUILT]** and Part B §B5 is hard-blocked
- [ ] **A5** `CREATE EXTENSION vector` succeeds; ANN `<=>` ordering correct; no premature HNSW index
- [ ] **A6** cross-tenant test: company B reads **zero** of A's rows; BYPASSRLS scanner sees all tenants; app role lacks BYPASSRLS
- [ ] **A7** app runs through pgbouncer transaction mode with `prepare:false`; backends bounded by pool size
- [ ] **A8** restore drill: every restored table row count == original
- [ ] **A9** rollback to embedded confirmed, embedded data intact

If any box is unchecked, **do not start Part B.**

---

## PART B — PRODUCTION SELF-HOSTED DEPLOY (Option A: VM + Compose recommended)

### B1 — Provision

**Recommended (Option A):** one VM running `docker compose` with a Postgres container + the Combyne `server` container — the repo's existing `docker-compose.yml` with the image swapped to `pgvector/pgvector:pg17`. Smallest durable step beyond embedded; user controls 100% of the data.

- VM: 2–4 vCPU / 8 GB+ RAM, SSD with headroom for `pgdata` + WAL archive + backups. ($10–40/mo class.)
- Firewall: expose **only** the app port (`3100`) publicly behind TLS; keep `5432`/`6432` private (VPN/LAN/Tailscale). Per `doc/DEPLOYMENT-MODES.md`, `authenticated + private` is the target exposure for a private-network central DB (login required, Tailscale/VPN/LAN); use `authenticated + public` only behind a hardened ingress.
- Apply the production override on disk as `docker-compose.prod.yml` (same shape as `$DRY/docker-compose.pgvector.yml`, with a host-path or named volume you back up).

> **Alt (Option B, the growth path):** managed Postgres in the user's **own** AWS/GCP account (RDS or Cloud SQL — **not** Fly Postgres if you expect RDS-grade automated backups/PITR/failover; see `CENTRAL_DB_DEPLOYMENT_OPTIONS.md` rows on Fly). Same `DATABASE_URL` switch; only the endpoint changes. `CREATE EXTENSION vector`. Move here before onboarding a team — A's un-restore-tested backups are a data-loss waiting room for irreplaceable human-gated knowledge. First, answer the gating question: **which cloud are you on?** (B presumes RDS/Cloud SQL availability.)

### B2 — Move plaintext compose secrets into real secret management

The DB password lives as a literal in `docker-compose.yml` (the `server` service's `DATABASE_URL=postgres://combyne:combyne@db:5432/combyne`, `:23`; the `db` service's `POSTGRES_PASSWORD: combyne`, `:6`) and `BETTER_AUTH_SECRET` is compose-substituted from your shell (`:29`). For a shared/team instance this is unacceptable.

- Change the DB password from `combyne`; store both `DATABASE_URL` and `BETTER_AUTH_SECRET` in **Docker/Compose secrets**, **SOPS**, or a cloud secret manager — **not** in a committed file. Inject at runtime so the compose file carries no literal credential.
- The repo helps you find/relocate inline secrets: `pnpm secrets:migrate-inline-env` (`scripts/migrate-inline-env-secrets.ts`, `package.json:15`) and `COMBYNE_SECRETS_STRICT_MODE=true` (blocks new inline sensitive env). The `local_encrypted` provider already protects `company_secrets` at rest with a local master key (`doc/DATABASE.md:130-135`).
- Provision **three** least-privilege roles in the same posture you'll need for RLS later: an RLS-enforced **app** role (no BYPASSRLS), a **`BYPASSRLS` scheduler** role, and a **migration-only** role. (The BYPASSRLS role must be created in the same change as RLS in Part C — but provision the role separation now so secret rotation isn't a second migration.)

**Verify:** `grep -rn "combyne:combyne" docker-compose*.yml` returns nothing in the deployed file; `docker compose config` shows secrets sourced from the store, not literals.

### B3 — Install pgvector + set max_connections + pgbouncer

- **pgvector:** use the `pgvector/pgvector:pg17` image (Option A) or `CREATE EXTENSION vector` (Option B). Defer the actual `CREATE EXTENSION` to when `0052` lands, but run the pgvector image now so it's a no-op later.
- **`max_connections`:** **we** own this — set it explicitly on the Postgres container (e.g. `command: ["postgres","-c","max_connections=100"]` or via a mounted `postgresql.conf`). Tune `shared_buffers`/`work_mem`/autovacuum off the defaults (the pgvector image is Debian-based; still not production-tuned out of the box — `CENTRAL_DB_DEPLOYMENT_OPTIONS.md` row 57).
- **pgbouncer:** front Postgres with pgbouncer in **transaction** mode for stateless app traffic, and reserve a **session-mode endpoint (or direct `:5432`)** for the two classes transaction mode breaks: the per-request RLS `SET LOCAL` path and the `BYPASSRLS` background heartbeat scans. Use the A7 config (remember edoburu listens on container `5432`), sized per §B7.

**Verify:** `SHOW max_connections;` == your chosen cap; `psql` through pgbouncer shows `pool_mode = transaction`; a separate session endpoint is reachable for RLS/scanner traffic.

### B4 — One-shot migrate with `COMBYNE_RUN_MIGRATIONS_ON_BOOT=false` + advisory lock

> `COMBYNE_RUN_MIGRATIONS_ON_BOOT` and the **blocking** advisory lock around `applyPendingMigrations` are **[TO BE BUILT — Phase 1 guardrail]**. Today headless boot auto-applies with **no lock** (`index.ts:135`, `client.ts:647-681`) — safe at one replica, a race at two. Land the gate before you ever run a second app container.

**At single replica (today, Option A):** keep app-auto-apply but make it explicit — `COMBYNE_MIGRATION_AUTO_APPLY=true` (`index.ts:134`). **The moment you run 2+ app containers** (e.g. zero-downtime restart), switch to the one-shot model:

```bash
# 1. App containers must NOT migrate on boot  [requires Phase-1 gate; no effect until COMBYNE_RUN_MIGRATIONS_ON_BOOT exists]
export COMBYNE_RUN_MIGRATIONS_ON_BOOT=false
# 2. Exactly one migrate job, against the DIRECT :5432 endpoint (never the txn pooler)
DATABASE_URL="postgres://combyne:<pw>@<db-host>:5432/combyne" pnpm db:migrate
```
The migrate job must hold a **blocking** `pg_advisory_lock` on its own reserved `max:1` connection (the migrate path already uses `max:1`, `client.ts:651`/`:232` — add the lock). Use the **blocking** variant, not `pg_try_advisory_lock` (the repo's `summarizer-failures.ts:165` non-blocking variant lets racers *skip*; `summarizer-queue.ts:15-19` documents that pooled session locks land on different backends and silently stop serializing).

**Verify:** `select count(*) from drizzle.__drizzle_migrations;` matches the migration file count; app logs show it did **not** attempt to migrate; two concurrently-started app containers both come up healthy with no DDL error.

### B5 — ETL-import the dogfooded memory (REFUSE-TO-PROCEED on empty)

> **Hard gate.** **[TO BE BUILT — Phase 1]** scripts required. The central DB boots **empty**; without this import you silently lose every dogfooded entry. **Do not proceed on an empty or failed import.**

```bash
# Source row count from the embedded DB (the assertion baseline)
SRC_URL="postgres://combyne:combyne@127.0.0.1:54329/combyne"
N_SRC=$(PGPASSWORD=combyne psql "$SRC_URL" -tA -c "select count(*) from memory_entries;")
echo "source entries: $N_SRC"
test "$N_SRC" -gt 0 || { echo "ABORT: source memory is empty"; exit 1; }

# Export -> import into the central DB (direct :5432, not the pooler)
DATABASE_URL="$SRC_URL" pnpm db:memory-export --out /tmp/central-export.json
CENTRAL_URL="postgres://combyne:<pw>@<db-host>:5432/combyne"
DATABASE_URL="$CENTRAL_URL" pnpm db:memory-import --in /tmp/central-export.json --owner-remap "local-board=<userId>"

# REFUSE-TO-PROCEED assertion: imported count must equal source and be > 0
N_DST=$(PGPASSWORD=combyne psql "$CENTRAL_URL" -tA -c "select count(*) from memory_entries;")
echo "central entries: $N_DST"
test "$N_DST" -gt 0 && test "$N_DST" -eq "$N_SRC" || { echo "ABORT: import incomplete ($N_DST != $N_SRC)"; exit 1; }
```
**Verify:** `N_DST == N_SRC`, `> 0`; spot-check embedding md5 parity (as A4); zero personal rows still owned by `local-board`. If any assertion fails, **stop the cutover** and fix the ETL — a partial import is worse than no cutover.

### B6 — Point DATABASE_URL at pgbouncer + DEPLOYMENT_MODE + pool sizing

Only after B5 passes, point the app at the pooled endpoint:
```bash
# In the deployed compose/secret store:
DATABASE_URL=postgres://combyne:<pw>@<pgbouncer-host>:6432/combyne
COMBYNE_DB_DISABLE_PREPARE=true        # [Phase-2 robust detection] — NO effect until that lands; until then run pgbouncer on 6543 or ship the fix
COMBYNE_DB_POOL_MAX=10                  # [Phase-2] explicit; today the default is a silent 10 (client.ts:50-53) and this var is not yet read
COMBYNE_DEPLOYMENT_MODE=authenticated   # read as DEPLOYMENT_MODE via COMBYNE_ prefix (config.ts:121)
COMBYNE_DEPLOYMENT_EXPOSURE=private     # or public behind hardened ingress (config.ts:127)
BETTER_AUTH_SECRET=<from secret store>  # read raw (no COMBYNE_ prefix)
```
**Verify:** health JSON `database.mode=external-postgres` (`curl http://<host>:3100/api/health`); a write from the UI lands in the central DB; pgbouncer `SHOW POOLS;` shows traffic.

### B7 — Health checks + connection-budget math

**We own `max_connections`** — compute and enforce this per-deploy (nothing in the code does it for you):
```
app_pool_max × replicas
  + maintenance (max:1 × ~6 paths: inspectMigrations, applyPendingMigrationsManually,
                 reconcilePendingMigrationHistory, migratePostgresIfEmpty, ensurePostgresDatabase, the migrate job)
  + migration job
  + scanner/BYPASSRLS pool
  < our_max_connections
```
Example: `10 × 2 + 6 + 1 + 5 = 32 < 100`. (The ~6 maintenance paths each open a `max:1` connection — `client.ts:232,481,588,651,689,728`.) Let pgbouncer absorb fan-out so Postgres backends stay low (`DEFAULT_POOL_SIZE` bounds them). **Verify:** under expected load, `select count(*) from pg_stat_activity;` stays well under `max_connections`; pgbouncer `sv_active ≤ DEFAULT_POOL_SIZE`. Health probe: `curl http://<host>:3100/api/health`.

### B8 — Backups / PITR cadence via the config knobs

The **scheduled in-process** logical backups are config-driven (`server/src/config.ts:191-208`). These env knobs (prefix `COMBYNE_`) feed the server's scheduler — they do **not** affect the one-off `pnpm db:backup` CLI, which uses `--dir`:

| Knob | Env | Default | Source |
|---|---|---|---|
| Enable | `COMBYNE_DB_BACKUP_ENABLED` | `true` (or file config) | `config.ts:191-193` |
| Interval | `COMBYNE_DB_BACKUP_INTERVAL_MINUTES` | `60` (min 1) | `config.ts:195-199` |
| Retention | `COMBYNE_DB_BACKUP_RETENTION_DAYS` | `30` (min 1) | `config.ts:201-206` |
| Backup dir | `COMBYNE_DB_BACKUP_DIR` | `~/.combyne/instances/<id>/data/backups` | `config.ts:208`, `home-paths.ts:52-53` |

```bash
COMBYNE_DB_BACKUP_ENABLED=true
COMBYNE_DB_BACKUP_INTERVAL_MINUTES=60
COMBYNE_DB_BACKUP_RETENTION_DAYS=30
COMBYNE_DB_BACKUP_DIR=/srv/combyne/backups
```
For a **manual one-off** backup of the external DB, use the CLI form (env var does NOT set the dir here):
```bash
DATABASE_URL="$CENTRAL_URL" pnpm db:backup -- --dir /srv/combyne/backups
```
**But `pg_dump` cron is NOT PITR.** STRICT human-gated knowledge is the highest-value, least-regenerable data in the system. On Option A configure **WAL archiving + base backups (pgBackRest or `pg_basebackup` + `archive_command`)** and run a **tested restore drill** (the A8 procedure against prod artifacts) — or treat the window as short and move to Option B, where snapshots + PITR are checkboxes in your own account. **Verify:** a scheduled backup file appears on cadence; a restore drill into a scratch DB matches row counts.

### B9 — Go / no-go

- [ ] B5 import assertion passed (`N_DST == N_SRC > 0`)
- [ ] App on external/pooled DB, `/api/health` reports `database.mode=external-postgres`, UI write round-trips
- [ ] Secrets out of plaintext; DB password rotated off `combyne`
- [ ] Migration model correct for replica count (auto-apply explicit at 1; gate + one-shot + blocking lock at 2+)
- [ ] Connection budget computed and under `max_connections`
- [ ] Backup on cadence **and** a restore drill passed; WAL/PITR configured or window accepted as short
- [ ] Rollback (§5) rehearsed

Owner gives go/no-go. If no-go, execute the §5 Part B rollback.

---

## PART C — MULTI-TEAM RLS ENABLEMENT (HARD GATE before company #2)

> **This is a CI/cutover hard-stop, not a checklist line.** Enable RLS the moment **2+ companies share the instance OR the first non-local authenticated multi-user joins.** If skipped, you ship multi-tenant on a one-`WHERE`-clause-deep fence (today: `assertCompanyAccess` at `routes/authz.ts:18` short-circuits for `local_implicit`/`isInstanceAdmin` at `:25` and never rejects empty `companyId`). All pieces are **[TO BE BUILT — Phase 4]**; author and CI-test them against the single tenant during Part B, then flip here.

### C1 — Migration `0053` (RLS policies + BYPASSRLS role)

- Apply `0053_memory_rls_team_phase.sql`: `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` on memory tables, **including the missing FK + policy on `memory_usage`** (`schema/memory_layers.ts:113` declares `companyId` as a bare uuid with no `.references()` — the highest-volume, weakest-scoped tenancy table).
- Create the `BYPASSRLS` scheduler role **in the same change**; the **app role must NOT have BYPASSRLS**.
- Run it via the one-shot model (B4), against direct `:5432`.

**Verify:** `select tablename, policyname from pg_policies;` lists policies on `memory_entries` **and** `memory_usage`; `select rolname, rolbypassrls from pg_roles where rolname in ('combyne_app','combyne_scheduler');` shows app=`f`, scheduler=`t` (match the role names `0053` actually creates).

### C2 — BYPASSRLS role wired to every background scan

Under RLS, any cross-company path running outside a request actor returns **zero rows silently**. The audit is unbounded by nature — each path independently breaks. At minimum: the heartbeat global scan `db.select().from(agents)` (`heartbeat.ts:6559`, inside `tickTimers`), the other unscoped `.from(agents)` scans (`heartbeat.ts:706,2258,4124,5731,6085,6103`), `runDecayPass` (`memory.ts:672`), the summarizer, and the new memory ETL must run as the `BYPASSRLS` scheduler role. **Verify:** after enabling RLS in staging, heartbeat enqueue counts and `tickTimers` `checked` (`heartbeat.ts:6573-6594`) do **not** drop to zero; the scanner role sees all tenants (A6 BYPASSRLS check).

### C3 — `SET LOCAL` middleware inside a per-request transaction

There is **no per-request transaction today** — `actorMiddleware` sets `req.actor` then `next()` on the shared pool (`server/src/middleware/auth.ts:20-26`). A plain `SET app.current_company` on a transaction-pooled checkout is unsafe (the `SET` and query may land on different backends — `summarizer-queue.ts:15-19`). The fix: `SET LOCAL app.current_company = <claim>` inside an explicit `db.transaction()` that **also contains the query** (auto-cleared at COMMIT), and route RLS-scoped traffic through **pgbouncer SESSION mode** (or direct `:5432`), keeping transaction mode for stateless traffic only. Also **fail-closed on empty/undefined `companyId`** at the top of `assertCompanyAccess` (`authz.ts:18`) for ALL principals incl. `local_implicit`/`isInstanceAdmin`.

**Verify:** the A6 cross-tenant test passes against the running app (not just raw SQL) — company B's API reads return zero of A's rows; an empty `companyId` request returns 400/403, not 200.

### C4 — CI isolation suite green (the merge gate)

The cross-tenant isolation suite must be a **merge gate**: company B cannot read A via **every** retrieval path (`queryRanked`/`loadCandidates`, the heartbeat self-retrieval at `heartbeat.ts:3913`, the EM passdown, the unscoped usage-log path); empty `companyId` rejected; both retrieval channels reject `unverified`. **Verify:** the suite is wired into CI and **red blocks merge**; run it against staging before the flip.

### C5 — Per-tenant JWT (paired workstream, same boundary)

The agent JWT is signed by a **single global secret** (`agent-auth-jwt.ts:97-109` resolves one secret; `createLocalAgentJwt` at `:163-187` signs with it) and the middleware trusts `company_id` verbatim (`auth.ts:113-120`). A leaked secret forges any tenant's claim — and **RLS does not rescue you**, because the app sets the tenant GUC from that same trusted claim. Per-tenant key separation must land **with** RLS, not be assumed covered by it. **Verify:** a token signed for tenant A cannot be replayed to read tenant B; key rotation is per-tenant.

**Part C gate:** RLS migration applied + BYPASSRLS audit complete (no background path returns zero rows) + CI isolation suite green + per-tenant JWT separation live. **Refuse to onboard company #2 without all four.**

---

## 5. Rollback procedures

**Part A (dry-run):** disposable. `docker compose -f docker-compose.yml -f $DRY/docker-compose.pgvector.yml down -v` removes the scratch volume. Embedded DB is never touched.

**Part B (production cutover):**
1. Stop the external-pointed app: `docker compose ... stop server`.
2. **Revert the switch:** start the app with `DATABASE_URL` **unset** → embedded auto-starts at `127.0.0.1:54329` (`index.ts:283` else-branch, `:412`). The embedded DB still holds the pre-cutover memory (the ETL was copy-out, not move). This is the A9 drill against prod.
3. If you had already taken live writes on the central DB and want them, run `db:memory-export` from central and `db:memory-import` back into embedded **before** reverting — otherwise central-only writes are left behind.
4. Restore from backup if the central DB itself is corrupt: `pg_restore` the latest `db:backup`/`pg_dump` artifact (B8) into a fresh DB, repoint, re-verify row counts.

**Migration rollback:** migrations are forward-only (drizzle). To undo a bad migration, restore the pre-migration backup (always `pg_dump` immediately before applying a new migration in prod). Do **not** hand-edit `drizzle.__drizzle_migrations`.

**Part C (RLS):** RLS is reversible per-table: `ALTER TABLE memory_entries DISABLE ROW LEVEL SECURITY; DROP POLICY ...`. **But** do not disable RLS while 2+ tenants are live — that re-opens cross-tenant reads. If RLS causes a zero-rows background outage, the correct fix is to grant the missing path the `BYPASSRLS` scheduler role (C2), **not** to disable RLS instance-wide.

---

## 6. Monitoring / alerting

Wire these as alerts, not dashboards-nobody-watches. The hallucination-guardrail metrics are from `doc/HALLUCINATION_AT_SCALE.md`.

### 6.1 Infrastructure / ops

| Signal | Probe | Alert |
|---|---|---|
| **Migration lock contention** | app boot logs / migrate-job duration; `select * from pg_locks where locktype='advisory';` | Two boots contending the advisory lock, or migrate job exceeding SLA → page |
| **Pool saturation** | `select count(*) from pg_stat_activity;` vs `max_connections`; pgbouncer `SHOW POOLS` (`cl_waiting>0`, `sv_active` near `DEFAULT_POOL_SIZE`) | `pg_stat_activity > 80%` of `max_connections`, or `cl_waiting` sustained → page (opaque `connection-refused` is the symptom this prevents) |
| **Backup freshness + restore** | newest file in `COMBYNE_DB_BACKUP_DIR` age; last successful restore-drill timestamp | No backup within `INTERVAL_MINUTES`, or no passing restore drill in N days → page |
| **Embedded fallback** | `/api/health` JSON `database.mode` field (`index.ts:600-639`) | `database.mode != "external-postgres"` on the central app → page (silently fell back to embedded) |

### 6.2 RLS isolation CI gate (hard-stop, Part C)

| Signal | Probe | Alert |
|---|---|---|
| **Cross-tenant leak** | CI isolation suite (C4): agent of company A receives any row with `company_id != A` | **Red = block merge / block onboarding**; in prod, any such read → page |
| **RLS zero-rows outage** | after enabling RLS, `tickTimers` `checked: 0` across companies (`heartbeat.ts:6573-6594`); `lastHeartbeatAt` stops advancing | Heartbeat enqueue drops to zero instance-wide → page (a missing BYPASSRLS path) |
| **Both-channels verified gate** | grep guard: any `queryRanked`/`loadCandidates` call site (esp. `heartbeat.ts:3913`) missing `requireVerified`; test asserts both channels reject `unverified` | A diff adding the filter to one channel but not the other → block merge |
| **Empty-companyId bypass** | fuzz: request with `companyId === '' | undefined` returns 200 instead of 400/403 | Any 200 → block merge |

### 6.3 Hallucination-at-scale guardrail metrics (from `doc/HALLUCINATION_AT_SCALE.md`)

| Cluster | Early-warning signal (SQL/telemetry) | Watch for |
|---|---|---|
| Retrieval degradation (1.1) | per-query **semantic-score variance collapsing toward zero**; many entries sharing near-identical 64-dim vectors | hash-64 saturation → prioritize pgvector (`0052`) |
| Top-k near-dup (1.2) | **distinct-subject ratio within top-k** falling; `memory_usage` concentrating on few ids; dup-rate by normalized subject climbing | dedup/canonicalization needed |
| Candidate-cap (1.5/1.6) | candidate count hitting the **500 cap** on the unscoped heartbeat path; active `memory_entries` per company approaching/exceeding 500; **non-deterministic top-k for an identical repeated query** | add ORDER BY + pagination; the `.limit(500)`/`.limit(2000)` have no ORDER BY (`memory.ts:337`,`:680`) |
| Popularity loop (1.4) | `usageCount` distribution heavily skewed; **widening gap between `lastUsedAt` (recent) and `updatedAt` (old)** on top hits | recency-by-retrieval masking truth-age |
| Decay stalled (2.x) | **days since last `runDecayPass` per company** climbing unbounded (`memory.ts:672`) | decay/auto-distill never scheduled |
| Stale "verified" (rot) | verified entries with old `verifiedAt` (>180d) whose `sourceRefId` points at a reverted PR / deleted issue; `GROUP BY subjectKey HAVING count(distinct body)>1` on verified rows | "verified" is freshness-at-capture, not now |
| Duplicate capture | `count(*) GROUP BY (companyId, source) HAVING count(*)>1` — any value >1 is a duplicate today | idempotent `(companyId,source)` upsert needed |
| Secret deposit | bodies matching `sk-`, `ghp_`, `AKIA`, `Bearer`, `BEGIN PRIVATE KEY`, `postgres://user:pass@`, `password=` | redaction gate on human-answer/EM-note writes |
| Prompt-injection bodies | bodies with imperative/second-person directives (`you must`, `ignore`, `always run`) or fenced executable code/URLs | injection-resistant render + content scan |
| pgvector cross-tenant (after `0052`) | vector query for tenant A returns rows with `company_id != A` (pre-filter test) | push `company_id` into the ANN query or RLS the ANN path |

> **Honest framing (carry into the runbook hand-off):** even with the full stack, hallucination risk is **reduced and bounded, never zero**. Wrong-but-human-blessed and stale-but-once-verified content can still surface as fact. Ship with per-query provenance/confidence/age signals so the residuals are *observable and correctable*, not hidden.

---

## 7. Environment variable reference

`envVar("X")` reads `process.env.COMBYNE_X` (`config.ts:25-26`). So the columns below distinguish the **raw** name from the **`COMBYNE_`-prefixed** form. `DATABASE_URL`, `PORT`, `BETTER_AUTH_SECRET` are read **raw** (no prefix).

| Variable (as you set it) | Read by | Effect | Status |
|---|---|---|---|
| `DATABASE_URL` | `config.ts:241` | Set → external Postgres (`index.ts:277`); unset → embedded `127.0.0.1:54329` (`index.ts:283` else-branch) | exists |
| `PORT` | `config.ts:235` | App port (default 3100) | exists |
| `BETTER_AUTH_SECRET` | compose `${...:?}` (`docker-compose.yml:29`) | Auth signing secret; compose errors if unset | exists |
| `COMBYNE_DEPLOYMENT_MODE` | `config.ts:121` (`DEPLOYMENT_MODE`) | `local_trusted` \| `authenticated` | exists |
| `COMBYNE_DEPLOYMENT_EXPOSURE` | `config.ts:127` (`DEPLOYMENT_EXPOSURE`) | `private` \| `public` (auth mode) | exists |
| `COMBYNE_MIGRATION_AUTO_APPLY` | `index.ts:134` | `true` → auto-apply migrations on boot (make explicit at 1 replica) | exists |
| `COMBYNE_MIGRATION_PROMPT` | `index.ts:133` | `never` → never prompt (used by dev:watch) | exists |
| `COMBYNE_EMBEDDED_POSTGRES_PORT` | `config.ts:245` (`EMBEDDED_POSTGRES_PORT`) | Embedded PG port (default 54329) | exists |
| `COMBYNE_DB_BACKUP_ENABLED` | `config.ts:191` (`DB_BACKUP_ENABLED`) | Enable scheduled `pg_dump` backups | exists |
| `COMBYNE_DB_BACKUP_INTERVAL_MINUTES` | `config.ts:195` (`DB_BACKUP_INTERVAL_MINUTES`) | Backup cadence (default 60, min 1) | exists |
| `COMBYNE_DB_BACKUP_RETENTION_DAYS` | `config.ts:201` (`DB_BACKUP_RETENTION_DAYS`) | Backup retention (default 30, min 1) | exists |
| `COMBYNE_DB_BACKUP_DIR` | `config.ts:208` (`DB_BACKUP_DIR`) | Scheduled-backup output dir (default `~/.combyne/instances/<id>/data/backups`). **Does NOT affect the one-off `pnpm db:backup` CLI — use `--dir` there.** | exists |
| `COMBYNE_HOME` | `home-paths.ts:15` | Override the `~/.combyne` home root | exists |
| `COMBYNE_SECRETS_STRICT_MODE` | secrets path | Block new inline sensitive env | exists |
| `COMBYNE_RUN_MIGRATIONS_ON_BOOT` | new gate (planned at the external branch, `index.ts:277`) | `false` → app does NOT migrate on boot (use one-shot job) | **[TO BE BUILT — Phase 1]** |
| `COMBYNE_DB_DISABLE_PREPARE` | new in `pgOptions` (`client.ts:14-17`) | `true` → `prepare:false` for self-hosted pgbouncer (today only port 6543 triggers it) | **[TO BE BUILT — Phase 2]** |
| `COMBYNE_DB_POOL_MAX` | new in `createDb` (`client.ts:50-53`) | Explicit postgres-js `max` (today silent default 10) | **[TO BE BUILT — Phase 2]** |
| `COMBYNE_VECTOR_SEARCH_ENABLED` | new, `memory.ts` swap point | Gate pgvector ANN vs the hash-64 test oracle | **[TO BE BUILT — Phase 4]** |

---

## 8. Sign-off checklist

**Pre-flight**
- [ ] Tooling versions verified (§1.1); `pnpm install` clean (`pnpm -r build` if building the image)
- [ ] §1.4 run: known which of `0048–0053`, ETL, pooler-detection are merged vs **[TO BE BUILT]**
- [ ] `BETTER_AUTH_SECRET` generated and in the secret store

**Part A — exit criteria (all green)**
- [ ] A1 pgvector image up, extension available
- [ ] A2 `db:migrate` clean; trust-spine columns + `owner_id text`
- [ ] A3 app on external DB (`/api/health` → `database.mode=external-postgres`); UI write visible in `psql`
- [ ] A4 ETL row-count parity + idempotency + embedding md5 + zero stray `local-board` (or blocker logged)
- [ ] A5 `CREATE EXTENSION vector` + ANN `<=>` ordering; no premature HNSW
- [ ] A6 cross-tenant: B reads zero of A; BYPASSRLS scanner sees all; app role lacks BYPASSRLS
- [ ] A7 app via pgbouncer transaction mode, `prepare:false`, backends bounded
- [ ] A8 restore drill row counts match
- [ ] A9 rollback to embedded confirmed

**Part B — production**
- [ ] VM/managed provisioned; firewall (app public, DB private)
- [ ] Secrets out of plaintext; DB password rotated; 3 roles provisioned
- [ ] pgvector image; `max_connections` set; pgbouncer txn + session endpoints
- [ ] Migration model correct for replica count (explicit auto-apply at 1; gate + one-shot + **blocking** advisory lock at 2+)
- [ ] **B5 ETL import assertion passed** (`N_DST == N_SRC > 0`) — refuse-to-proceed honored
- [ ] App on pooled external DB; `/api/health` → `database.mode=external-postgres`; UI write round-trips
- [ ] Connection budget computed under `max_connections`
- [ ] Backups on cadence + restore drill passed; WAL/PITR configured or window accepted as short
- [ ] Owner go/no-go recorded

**Part C — RLS HARD GATE (before company #2)**
- [ ] `0053` RLS policies (incl. `memory_usage` FK + policy) + BYPASSRLS role applied
- [ ] BYPASSRLS audit complete: no background path returns zero rows
- [ ] `SET LOCAL`-in-txn middleware live; fail-closed on empty `companyId`
- [ ] CI cross-tenant isolation suite green as a **merge gate**
- [ ] Per-tenant agent-JWT key separation live
- [ ] Refuse-to-onboard until all five above are checked

**Monitoring**
- [ ] Migration-lock, pool-saturation, backup-freshness, embedded-fallback alerts live
- [ ] RLS isolation CI gate + zero-rows-outage alert live
- [ ] Hallucination guardrail signals (§6.3) instrumented

Signed: __________________  Date: __________  Owner go/no-go: __________
