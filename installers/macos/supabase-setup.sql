-- ─────────────────────────────────────────────────────────────────────────────
-- Combyne AI — License Tables for Supabase
-- Run this SQL in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ─────────────────────────────────────────────────────────────────────────────

-- Table: licenses
CREATE TABLE IF NOT EXISTS public.licenses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  license_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'revoked', 'suspended')),
  valid_until TIMESTAMPTZ NOT NULL,
  max_activations INTEGER NOT NULL DEFAULT 5,
  plan_tier TEXT NOT NULL DEFAULT 'starter'
    CHECK (plan_tier IN ('starter', 'pro', 'enterprise')),
  customer_email TEXT,
  customer_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table: license_activations
CREATE TABLE IF NOT EXISTS public.license_activations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  license_id UUID NOT NULL REFERENCES public.licenses(id) ON DELETE CASCADE,
  machine_fingerprint TEXT NOT NULL,
  machine_label TEXT,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  deactivated_at TIMESTAMPTZ,
  app_version TEXT,
  os_info TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_licenses_key ON public.licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON public.licenses(status);
CREATE INDEX IF NOT EXISTS idx_activations_license_id ON public.license_activations(license_id);
CREATE INDEX IF NOT EXISTS idx_activations_fingerprint ON public.license_activations(machine_fingerprint);

-- Unique constraint: one active activation per license+machine combo
CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_unique_active
  ON public.license_activations(license_id, machine_fingerprint)
  WHERE is_active = true;

-- Row Level Security: block direct access, all ops go through Edge Functions
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.license_activations ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS "No direct access" ON public.licenses;
DROP POLICY IF EXISTS "No direct access" ON public.license_activations;

CREATE POLICY "No direct access" ON public.licenses FOR ALL USING (false);
CREATE POLICY "No direct access" ON public.license_activations FOR ALL USING (false);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS licenses_updated_at ON public.licenses;
CREATE TRIGGER licenses_updated_at
  BEFORE UPDATE ON public.licenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: Generate a COMB-XXXX-XXXX-XXXX license key
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION generate_license_key()
RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result TEXT := 'COMB-';
  i INTEGER;
  g INTEGER;
BEGIN
  FOR g IN 1..3 LOOP
    IF g > 1 THEN result := result || '-'; END IF;
    FOR i IN 1..4 LOOP
      result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    END LOOP;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- Example: Issue a test license (valid for 1 year, pro tier)
-- Uncomment and run to create a test license:
-- ─────────────────────────────────────────────────────────────────────────────
-- INSERT INTO public.licenses (license_key, status, valid_until, max_activations, plan_tier, customer_email, customer_name)
-- VALUES (
--   generate_license_key(),
--   'active',
--   now() + interval '1 year',
--   5,
--   'pro',
--   'anurag@combyne.ai',
--   'Anurag Mahanto'
-- )
-- RETURNING license_key, id, valid_until;
