# Combyne AI — License Keys

Generated: 2026-03-23 | Version: 0.2.7 | Format: `COMB-XXXX-XXXX-XXXX`

## Active Licenses

| # | License Key | Plan | Max Activations | Valid Until | Status |
|---|-------------|------|-----------------|-------------|--------|
| 1 | `COMB-TKDP-B9JS-TAZ4` | pro | 5 | 2027-03-23 | active |
| 2 | `COMB-3TOZ-4SWX-3QL1` | pro | 5 | 2027-03-23 | active |
| 3 | `COMB-C5R8-QPMT-OJY6` | pro | 5 | 2027-03-23 | active |
| 4 | `COMB-0NAG-WOC9-51G6` | pro | 5 | 2027-03-23 | active |
| 5 | `COMB-VDVQ-JOGU-SHOK` | pro | 5 | 2027-03-23 | active |

## Provisioning SQL

Run this in the Supabase SQL Editor to insert all keys:

```sql
INSERT INTO public.licenses (license_key, status, valid_until, max_activations, plan_tier)
VALUES
  ('COMB-TKDP-B9JS-TAZ4', 'active', '2027-03-23T00:00:00+00', 5, 'pro'),
  ('COMB-3TOZ-4SWX-3QL1', 'active', '2027-03-23T00:00:00+00', 5, 'pro'),
  ('COMB-C5R8-QPMT-OJY6', 'active', '2027-03-23T00:00:00+00', 5, 'pro'),
  ('COMB-0NAG-WOC9-51G6', 'active', '2027-03-23T00:00:00+00', 5, 'pro'),
  ('COMB-VDVQ-JOGU-SHOK', 'active', '2027-03-23T00:00:00+00', 5, 'pro');
```

## Notes

- Each key allows up to 5 machine activations
- Keys are valid for 1 year from generation date
- To activate: enter the key on the Combyne AI first-launch screen
- To revoke: `UPDATE public.licenses SET status = 'revoked' WHERE license_key = '...';`
- See `doc/LICENSING.md` for full documentation
