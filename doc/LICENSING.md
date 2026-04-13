# Combyne AI — Licensing Flow

This document describes the license activation and validation system for the Combyne AI desktop app.

## Architecture

```
┌─────────────────────────┐            ┌──────────────────────────────┐
│  macOS Desktop App      │            │  Supabase (Cloud)            │
│                         │            │                              │
│  ┌───────────────────┐  │            │  ┌────────────────────────┐  │
│  │ Swift App          │  │  activate  │  │ Edge Function:         │  │
│  │ (first launch UI) │──┼───────────▶│  │ validate-license       │  │
│  └────────┬──────────┘  │            │  └───────────┬────────────┘  │
│           │              │            │              │               │
│  ┌────────▼──────────┐  │  heartbeat │  ┌───────────▼────────────┐  │
│  │ Node.js Server     │  │  (hourly)  │  │ Tables:                │  │
│  │ - license service  │──┼───────────▶│  │ • licenses             │  │
│  │ - license gate MW  │  │            │  │ • license_activations  │  │
│  └────────┬──────────┘  │            │  └────────────────────────┘  │
│           │              │            └──────────────────────────────┘
│  ┌────────▼──────────┐  │
│  │ ~/.combyne-ai/    │  │
│  │ license.json      │  │  ◀── local cache
│  └───────────────────┘  │
└─────────────────────────┘
```

## License Key Format

```
COMB-XXXX-XXXX-XXXX
```
- Prefix: `COMB-` (always uppercase)
- 3 groups of 4 alphanumeric characters (A-Z, 0-9)
- Example: `COMB-A7K2-M9P3-X4B8`

## How It Works

### 1. Activation (First Launch)

1. User opens Combyne AI for the first time
2. Swift app checks `~/.combyne-ai/license.json` — not found
3. **Activation screen** appears: user enters their license key
4. Swift app calls Supabase Edge Function directly (`POST /functions/v1/validate-license`)
5. Edge Function validates:
   - Key exists in `licenses` table
   - Status is `active`
   - `valid_until` is in the future
   - Active activation count < `max_activations`
6. If valid: creates a row in `license_activations`, returns success
7. Swift app writes `~/.combyne-ai/license.json` cache, starts the Node.js server
8. App loads normally

### 2. Heartbeat (Every 1 Hour)

1. Node.js server runs a license heartbeat every `COMBYNE_LICENSE_HEARTBEAT_INTERVAL_MINUTES` (default: 60)
2. Reads `license.json`, calls Supabase Edge Function with `action: "heartbeat"`
3. Edge Function updates `last_heartbeat` timestamp, returns current license status
4. **If valid**: updates `lastValidated` in cache
5. **If expired**: sets in-memory `licenseState` to `"expired"`, API middleware blocks requests
6. **If revoked**: sets `licenseState` to `"revoked"`, blocks immediately
7. **If network error**: keeps running — grace period applies

### 3. Grace Period (24 Hours Default)

When Supabase is unreachable, the app uses the cached validation:

| Scenario | Behavior |
|----------|----------|
| Supabase reachable, license valid | Normal operation. Cache updated. |
| Supabase reachable, license expired | **Blocked.** "License Expired" screen. |
| Supabase reachable, license revoked | **Blocked immediately.** Cache cleared. |
| Supabase unreachable, cache < 24h old | Normal operation. Warning logged. |
| Supabase unreachable, cache > 24h old | **Blocked.** "Cannot validate" screen. |
| No cache at all | **Blocked.** Activation screen shown. |

### 4. Server Startup Gate

On every server start, the license is validated:
1. Read `license.json` cache
2. If cache is valid and within grace period → proceed
3. If cache is stale → try one remote validation
4. If validation fails → set license state, log warning (app may show UI gate)

### 5. API Middleware Gate

The `licenseGateMiddleware` blocks all API requests (except `/api/health` and `/api/license/*`) when the license state is `"expired"` or `"revoked"`. This is an in-memory check — no network call per request.

## Supabase Setup

### Project Details

- **URL**: `https://cmkybsmznmhclytbjnwh.supabase.co`
- **Anon Key** (public, embedded in app): safe to distribute
- **Service Role Key** (Edge Function only): never embedded in the app

### 1. Create Tables

Run `installers/macos/supabase-setup.sql` in the Supabase SQL Editor:
- Dashboard → SQL Editor → New query → paste SQL → Run

This creates:
- `licenses` table with RLS
- `license_activations` table with RLS
- Indexes and triggers
- `generate_license_key()` helper function

### 2. Deploy Edge Function

The Edge Function source is at `installers/macos/supabase-edge-function.ts`.

**Option A — Supabase CLI:**
```bash
supabase login
supabase functions deploy validate-license --project-ref cmkybsmznmhclytbjnwh
```

**Option B — Dashboard:**
1. Dashboard → Edge Functions → New Function
2. Name: `validate-license`
3. Paste the contents of `supabase-edge-function.ts`
4. Deploy

## Issuing License Keys

### Via Supabase Dashboard (Quick)

1. Dashboard → Table Editor → `licenses`
2. Insert Row:
   - `license_key`: Run `SELECT generate_license_key();` to get a key
   - `status`: `active`
   - `valid_until`: e.g., `2027-03-17 00:00:00+00`
   - `max_activations`: `5`
   - `plan_tier`: `starter`, `pro`, or `enterprise`
   - `customer_email`: customer's email
   - `customer_name`: customer's name
3. Save → give the `license_key` to the customer

### Via SQL

```sql
INSERT INTO public.licenses (license_key, status, valid_until, max_activations, plan_tier, customer_email, customer_name)
VALUES (
  generate_license_key(),
  'active',
  now() + interval '1 year',
  5,
  'pro',
  'user@example.com',
  'User Name'
)
RETURNING license_key, id, valid_until;
```

### Via CLI (Planned)

```bash
combyne license issue --email user@example.com --plan pro --duration 1y
combyne license list
combyne license revoke COMB-XXXX-XXXX-XXXX
```

## Revoking a License

```sql
UPDATE public.licenses SET status = 'revoked' WHERE license_key = 'COMB-XXXX-XXXX-XXXX';
```

The next heartbeat (within 1 hour) will detect the revocation and block the app.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMBYNE_LICENSE_ENABLED` | `false` | Enable license validation |
| `COMBYNE_LICENSE_SUPABASE_URL` | (project URL) | Supabase project URL |
| `COMBYNE_LICENSE_SUPABASE_ANON_KEY` | (anon key) | Supabase public anon key |
| `COMBYNE_LICENSE_HEARTBEAT_INTERVAL_MINUTES` | `60` | Heartbeat frequency (15-1440) |
| `COMBYNE_LICENSE_GRACE_PERIOD_HOURS` | `24` | Offline grace period (1-168) |
| `COMBYNE_MACHINE_FINGERPRINT` | (auto-detected) | Machine fingerprint override |

## Local Cache File

**Path:** `~/.combyne-ai/license.json`

```json
{
  "licenseKey": "COMB-A7K2-M9P3-X4B8",
  "machineFingerprint": "sha256...",
  "lastValidated": "2026-03-17T10:00:00.000Z",
  "validUntil": "2027-03-17T00:00:00.000Z",
  "activationId": "uuid",
  "planTier": "pro",
  "status": "active"
}
```

## Machine Fingerprint

The fingerprint is a SHA-256 hash of the macOS hardware UUID (`IOPlatformUUID`). It is:
- **Stable** across reboots, OS updates, and app reinstalls
- **Unique** per physical machine
- **Privacy-preserving** — only the hash is sent to Supabase, not the raw UUID

On non-macOS systems, a fallback using hostname + arch + platform is used.

## Troubleshooting

### "License key not found"
- Verify the key is entered correctly (COMB-XXXX-XXXX-XXXX format)
- Check the `licenses` table in Supabase — does the row exist?
- Keys are case-insensitive (auto-uppercased)

### "License expired"
- Check `valid_until` in the `licenses` table
- Update: `UPDATE licenses SET valid_until = now() + interval '1 year', status = 'active' WHERE license_key = '...';`

### "Max activations exceeded"
- Check `license_activations` table for active rows (`is_active = true`)
- Deactivate old machines: `UPDATE license_activations SET is_active = false, deactivated_at = now() WHERE license_id = '...' AND machine_fingerprint = '...';`
- Or increase `max_activations` on the license

### "Cannot validate license" (network issues)
- App will keep running for up to 24 hours (grace period)
- Check internet connection
- Verify Supabase is up: `curl https://cmkybsmznmhclytbjnwh.supabase.co/functions/v1/validate-license`

### Reset activation cache
```bash
rm ~/.combyne-ai/license.json
```
Then restart the app — it will show the activation screen.

### App blocked but license is valid
1. Delete the cache: `rm ~/.combyne-ai/license.json`
2. Restart the app
3. Re-enter your license key

### Check active activations for a license
```sql
SELECT la.*, l.license_key
FROM license_activations la
JOIN licenses l ON l.id = la.license_id
WHERE l.license_key = 'COMB-XXXX-XXXX-XXXX'
  AND la.is_active = true;
```

## Files

| File | Purpose |
|------|---------|
| `server/src/services/license.ts` | Core license service (validation, cache, fingerprint) |
| `server/src/middleware/license-gate.ts` | API gate middleware |
| `server/src/routes/license.ts` | License API endpoints |
| `server/src/config.ts` | License config loading |
| `packages/shared/src/config-schema.ts` | License config Zod schema |
| `installers/macos/supabase-setup.sql` | Supabase table creation SQL |
| `installers/macos/supabase-edge-function.ts` | Supabase Edge Function source |
| `installers/macos/swift-app/CombyneAI.swift` | Swift app with activation UI |
| `doc/LICENSING.md` | This document |
