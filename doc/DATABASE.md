# Database

Combyne uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/).

## The 2-DB model (read this first)

Combyne runs **two logically separate databases**, by design:

| | **Ops DB** (local, per-machine) | **Context DB** (shared rail) |
|---|---|---|
| Holds | companies, agents, issues, PRs, approvals, auth, heartbeat runs, the durable capture outbox | `memory_entries`, `memory_promotions`, `memory_usage`, `agent_memory` (the trust-spine + embeddings) |
| Routed by | `DATABASE_URL` (unset → embedded PG `127.0.0.1:54329`) | `COMBYNE_CONTEXT_DATABASE_URL` (falls back to `DATABASE_URL` when unset) |
| Shared between teammates? | **No** — each teammate's ops DB is private | **Yes** — the only shared resource; the rail context rides |
| Lifecycle | **Throwaway** — recreate freely, wipe and re-migrate anytime | **Durable** — the irreplaceable source of shared truth |
| Code routing | `resolveContextDb(db)` returns the *ops* db when no context URL is set | `resolveContextDb(db)` returns the *context* db when the URL is set (`server/src/services/memory.ts`) |

The architecture is **local-first**: every teammate runs their own Combyne against their own
agent-CLI subscription, with a private local ops DB. The **context DB is the only shared rail** —
captured human answers, PR-approval decisions, and the embeddings/trust-spine flow through it so
context propagates across tickets (and, when teammates pin the same company id, across machines).

When `COMBYNE_CONTEXT_DATABASE_URL` is **unset**, both jobs collapse onto a single DB (the embedded
ops PG in local dev). That single-DB collapse is the zero-config dev default; the 2-DB split is what
production teams deploy. The deep architecture write-up lives in
[`doc/LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md`](LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md); the production
stand-up is [`doc/CENTRAL_DB_RUNBOOK.md`](CENTRAL_DB_RUNBOOK.md).

### Context-DB env knobs

These configure the shared rail (read by `server/src/config.ts`; `envVar("X")` reads
`process.env.COMBYNE_X`):

| Env var | Effect |
|---|---|
| `COMBYNE_CONTEXT_DATABASE_URL` | Point the context/memory tables at a **separate** PostgreSQL (the shared rail). Unset → context lives in the ops DB. UI-saved values in `config.json` are also honored (env wins). |
| `COMBYNE_CONTEXT_REQUIRED` | `true` → **refuse to boot** (fail-loud) if the context rail is configured but unreachable or schema-behind, instead of silently falling open to the ops DB. |
| `COMBYNE_CONTEXT_DB_MIGRATE` | `true` → this machine is the **designated migrator**: `pnpm db:migrate:context` applies the schema to the shared rail (advisory-locked). Teammate boots are **inspect-only** — they never auto-migrate the shared DB. |
| `COMBYNE_CONTEXT_COMPANY_ID` | Pin the canonical company UUID for the shared rail so every teammate's local company aligns to one tenant key (see "Company-pin" below). |
| `COMBYNE_CONTEXT_TRACE` | `1` → emit per-hop `ctxtrace:<event>` lines tracing the context lifecycle across the 2-DB boundary (off by default, no-op otherwise). See [`doc/TWO_DB_TESTING_PLAYBOOK.md`](TWO_DB_TESTING_PLAYBOOK.md). |

### Migrations are split

There are **two** migration commands — they target the two databases and must not be confused:

| Command | Targets | When / who |
|---|---|---|
| `pnpm db:migrate` | the **ops** DB (`DATABASE_URL`, or embedded) | every machine; also auto-applied on dev boot for an empty/behind local ops DB |
| `pnpm db:migrate:context` | the **context** DB (`COMBYNE_CONTEXT_DATABASE_URL`) | **only the designated migrator**, gated by `COMBYNE_CONTEXT_DB_MIGRATE=true`, under a Postgres **advisory lock** so concurrent runs are safe |

Teammate machines run only `pnpm db:migrate` (their throwaway ops DB); their boots **inspect** the
shared context schema and warn if it is behind, but never apply migrations to it. One designated
operator owns `pnpm db:migrate:context`. Both read their URL from env and are idempotent.

### Company-pin (one canonical tenant key)

`companies.id` defaults to a random UUID per machine, so two teammates each creating "Acme Eng" get
**different** company UUIDs — their context would silently land in disjoint partitions of the same
shared rail. To share context, one canonical UUID is pinned via `COMBYNE_CONTEXT_COMPANY_ID`, and
each teammate seeds their local `companies` row with that **explicit** id (the `pnpm db:company-pin`
glue) so all reads/writes to the shared rail align to one tenant. Without `COMBYNE_CONTEXT_COMPANY_ID`
set, the rail accepts any company id (local-first / solo). See
[`doc/LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md`](LOCAL_FIRST_SHARED_CONTEXT_PLAYBOOK.md) Part 1.

### The durable capture outbox

Human answers and PR-approval decisions are **never dropped** if the shared context DB is briefly
unreachable. The capture path enqueues the write to the **local ops DB** (the outbox) and **replays**
it on the heartbeat tick once the rail is back — so a connectivity blip queues, then drains, rather
than losing irreplaceable human-gated knowledge. Under `COMBYNE_CONTEXT_TRACE=1` this shows as
`context_capture_enqueue` then `context_capture_drain`.

### Backups are split

The two databases have **separate** backup stories:

- **Ops DB** — covered by the in-app automatic backup (`runDatabaseBackup` / `pnpm db:backup`). This
  is a destructive `DROP TABLE … CASCADE` dumper and is **ops-only by design** — it must never run
  against a live shared remote DB. Boot logs warn loudly that the context DB is **not** covered here.
- **Context DB** — the operator's responsibility. The primary DR is managed (e.g. Cloud SQL automated
  backups + PITR); a portable recovery point is a scheduled, non-destructive `pnpm db:memory-export`
  against `COMBYNE_CONTEXT_DATABASE_URL` (rollback via `pnpm db:memory-import`). Full procedure:
  [`doc/CENTRAL_DB_RUNBOOK.md`](CENTRAL_DB_RUNBOOK.md) "Context-DB Backup & Restore".

---

## Running the ops DB — three modes

The ops DB has three ways to run, from simplest to most production-ready. (The context DB is always
an external PostgreSQL pointed at by `COMBYNE_CONTEXT_DATABASE_URL`; see the runbook to stand it up.)

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates a `~/.combyne-ai/instances/default/db/` directory for storage
2. Ensures the `combyne` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in `~/.combyne-ai/instances/default/db/`. To reset local dev data, delete that directory.

This mode is ideal for local development and one-command installs.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/combyne` to keep DB state across container restarts (see `doc/DOCKER.md`).

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally, use the included Docker Compose setup:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Then set the connection string:

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://combyne:combyne@localhost:5432/combyne
```

Run migrations (once the migration generation issue is fixed) or use `drizzle-kit push`:

```sh
DATABASE_URL=postgres://combyne:combyne@localhost:5432/combyne \
  npx drizzle-kit push
```

Start the server:

```sh
pnpm dev
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted PostgreSQL provider. [Supabase](https://supabase.com/) is a good option with a free tier.

### Setup

1. Create a project at [database.new](https://database.new)
2. Go to **Project Settings > Database > Connection string**
3. Copy the URI and replace the password placeholder with your database password

### Connection string

Supabase offers two connection modes:

**Direct connection** (port 5432) — use for migrations and one-off scripts:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Connection pooling via Supavisor** (port 6543) — use for the application:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### Configure

Set `DATABASE_URL` in your `.env`:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

If using connection pooling (port 6543), the `postgres` client must disable prepared statements. Update `packages/db/src/client.ts`:

```ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

### Push the schema

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  npx drizzle-kit push
```

### Free tier limits

- 500 MB database storage
- 200 concurrent connections
- Projects pause after 1 week of inactivity

See [Supabase pricing](https://supabase.com/pricing) for current details.

## Switching between modes

The **ops DB** mode is controlled by `DATABASE_URL`:

| `DATABASE_URL` | Mode |
|---|---|
| Not set | Embedded PostgreSQL (`~/.combyne-ai/instances/default/db/`) |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The **context DB** is controlled independently by `COMBYNE_CONTEXT_DATABASE_URL` (see "The 2-DB model"
above). When it is unset, the context/memory tables live in whichever ops DB `DATABASE_URL` selects.

Your Drizzle schema (`packages/db/src/schema/`) stays the same regardless of mode. Note the migration
split: `pnpm db:migrate` migrates the ops DB; `pnpm db:migrate:context` migrates the shared context DB
(designated migrator only).

## Secret storage

Combyne stores secret metadata and versions in:

- `company_secrets`
- `company_secret_versions`

For local/default installs, the active provider is `local_encrypted`:

- Secret material is encrypted at rest with a local master key.
- Default key file: `~/.combyne-ai/instances/default/secrets/master.key` (auto-created if missing).
- CLI config location: `~/.combyne-ai/instances/default/config.json` under `secrets.localEncrypted.keyFilePath`.

Optional overrides:

- `COMBYNE_SECRETS_MASTER_KEY` (32-byte key as base64, hex, or raw 32-char string)
- `COMBYNE_SECRETS_MASTER_KEY_FILE` (custom key file path)

Strict mode to block new inline sensitive env values:

```sh
COMBYNE_SECRETS_STRICT_MODE=true
```

You can set strict mode and provider defaults via:

```sh
pnpm combyne configure --section secrets
```

Inline secret migration command:

```sh
pnpm secrets:migrate-inline-env --apply
```
