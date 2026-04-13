# Combyne AI — License Activation

Combyne AI uses a Supabase-backed license activation system to validate desktop app installations.

## How It Works

1. **First launch** — the app shows an activation screen asking for your license key
2. **Enter your key** — format: `COMB-XXXX-XXXX-XXXX`
3. **Validation** — the key is verified against Supabase (checks status, expiry, activation count)
4. **Running** — the app validates your license every hour via a background heartbeat
5. **Offline** — a 24-hour grace period allows the app to run without internet

## Quick Start

### For Users

1. Get a license key from your admin
2. Open the Combyne AI app
3. Enter your license key on the activation screen
4. Done — the app starts normally

### For Admins — Issuing Keys

**Via Supabase SQL Editor:**

```sql
INSERT INTO public.licenses (license_key, status, valid_until, max_activations, plan_tier, customer_email, customer_name)
VALUES (
  generate_license_key(),  -- generates COMB-XXXX-XXXX-XXXX
  'active',
  now() + interval '1 year',
  5,                       -- max 5 machines per key
  'pro',
  'user@example.com',
  'User Name'
)
RETURNING license_key;
```

### For Admins — Revoking Keys

```sql
UPDATE public.licenses SET status = 'revoked' WHERE license_key = 'COMB-XXXX-XXXX-XXXX';
```

The app will detect the revocation within 1 hour (next heartbeat).

## License Key Format

```
COMB-XXXX-XXXX-XXXX
```

- `COMB-` prefix (always uppercase)
- 3 groups of 4 alphanumeric characters (A-Z, 0-9)
- Example: `COMB-A7K2-M9P3-X4B8`

## Plan Tiers

| Tier | Description |
|------|-------------|
| `starter` | Basic features |
| `pro` | Full features |
| `enterprise` | Full features + priority support |

## License States

| State | Meaning |
|-------|---------|
| `active` | License is valid and working |
| `expired` | Past the `valid_until` date — renew to continue |
| `revoked` | Permanently disabled by admin |
| `suspended` | Temporarily disabled — contact support |

## Environment Variables

Set these to enable licensing on the server (the macOS Swift app sets them automatically):

| Variable | Default | Description |
|----------|---------|-------------|
| `COMBYNE_LICENSE_ENABLED` | `false` | Enable license checks |
| `COMBYNE_LICENSE_SUPABASE_URL` | — | Supabase project URL |
| `COMBYNE_LICENSE_SUPABASE_ANON_KEY` | — | Supabase anon (public) key |
| `COMBYNE_LICENSE_HEARTBEAT_INTERVAL_MINUTES` | `60` | How often to validate (15–1440 min) |
| `COMBYNE_LICENSE_GRACE_PERIOD_HOURS` | `24` | Offline grace period (1–168 hours) |

## API Endpoints

When the server is running with licensing enabled:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/license/status` | GET | Current license status |
| `/api/license/activate` | POST | Activate a key: `{ "licenseKey": "COMB-..." }` |
| `/api/license/deactivate` | POST | Deactivate this machine |
| `/api/health` | GET | Includes `licenseEnabled` and `licenseStatus` fields |

## Architecture

```
macOS App                         Supabase Cloud
┌──────────────┐                 ┌─────────────────────┐
│ Swift App    │── activate ──▶ │ Edge Function:       │
│              │                 │ validate-license     │
│ Node Server  │── heartbeat ──▶│                      │
│ (every 1hr)  │                 │ Tables:              │
│              │                 │ • licenses           │
│ license.json │◀── cache ──── │ • license_activations│
└──────────────┘                 └─────────────────────┘
```

**4 layers of protection:**
1. **Swift app** — checks cache before starting the server
2. **Server startup** — validates cache before initializing the database
3. **Hourly heartbeat** — periodic remote validation
4. **API middleware** — blocks requests when license is invalid

## Local Cache

Stored at `~/.combyne-ai/license.json`:

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

## Troubleshooting

**"License key not found"**
- Check the key is correct (case-insensitive, auto-uppercased)
- Verify the key exists in the `licenses` table in Supabase

**"License expired"**
- Update the `valid_until` field in Supabase: `UPDATE licenses SET valid_until = now() + interval '1 year', status = 'active' WHERE license_key = '...';`

**"Max activations exceeded"**
- Deactivate old machines in the `license_activations` table
- Or increase `max_activations` on the license row

**App blocked but license is valid**
```bash
rm ~/.combyne-ai/license.json   # Reset the local cache
# Restart the app — it will re-activate
```

## Files

| File | Purpose |
|------|---------|
| `server/src/services/license.ts` | License validation service |
| `server/src/middleware/license-gate.ts` | API blocking middleware |
| `server/src/routes/license.ts` | License REST endpoints |
| `installers/macos/supabase-setup.sql` | Supabase table creation SQL |
| `installers/macos/supabase-edge-function.ts` | Supabase Edge Function |
| `installers/macos/swift-app/CombyneAI.swift` | Swift app with activation UI |
| `doc/LICENSING.md` | Detailed technical reference |
