/**
 * Combyne AI — Supabase Edge Function: get-agent-personas
 *
 * Deploy to Supabase:
 *   supabase functions deploy get-agent-personas --project-ref cmkybsmznmhclytbjnwh
 *
 * Returns agent persona files gated by license plan_tier.
 * Validates the license before serving any content.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Plan tier hierarchy: enterprise includes pro, pro includes starter
const TIER_INCLUDES: Record<string, string[]> = {
  starter: ["starter"],
  pro: ["starter", "pro"],
  enterprise: ["starter", "pro", "enterprise"],
};

interface RequestBody {
  license_key: string;
  machine_fingerprint: string;
  persona_key?: string;  // optional filter: 'ceo', 'cto', etc.
  file_name?: string;    // optional filter: 'HEARTBEAT.md', 'AGENTS.md'
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body: RequestBody = await req.json();

    if (!body.license_key || !body.machine_fingerprint) {
      return jsonResponse(
        { error: "invalid_request", message: "Missing required fields: license_key, machine_fingerprint" },
        400,
      );
    }

    // Validate license
    const { data: license, error: licenseError } = await supabase
      .from("licenses")
      .select("id, status, valid_until, plan_tier")
      .eq("license_key", body.license_key)
      .single();

    if (licenseError || !license) {
      return jsonResponse({ error: "license_not_found", message: "Invalid license key" }, 403);
    }

    if (license.status === "revoked" || license.status === "suspended") {
      return jsonResponse({ error: `license_${license.status}`, message: `License is ${license.status}` }, 403);
    }

    if (new Date(license.valid_until) < new Date()) {
      return jsonResponse({ error: "license_expired", message: "License has expired" }, 403);
    }

    // Verify active activation exists for this machine
    const { data: activation } = await supabase
      .from("license_activations")
      .select("id")
      .eq("license_id", license.id)
      .eq("machine_fingerprint", body.machine_fingerprint)
      .eq("is_active", true)
      .single();

    if (!activation) {
      return jsonResponse(
        { error: "not_activated", message: "No active activation for this machine" },
        403,
      );
    }

    // Get accessible tiers based on plan
    const accessibleTiers = TIER_INCLUDES[license.plan_tier] ?? ["starter"];

    // Build query
    let query = supabase
      .from("agent_personas")
      .select("persona_key, file_name, content, plan_tier, version, updated_at")
      .in("plan_tier", accessibleTiers)
      .eq("is_active", true)
      .order("persona_key")
      .order("file_name");

    if (body.persona_key) {
      query = query.eq("persona_key", body.persona_key);
    }
    if (body.file_name) {
      query = query.eq("file_name", body.file_name);
    }

    const { data: personas, error: personasError } = await query;

    if (personasError) {
      console.error("Personas query error:", personasError);
      return jsonResponse({ error: "query_failed", message: "Failed to fetch personas" }, 500);
    }

    // Deduplicate: if same persona_key+file_name exists at multiple tiers,
    // prefer the highest tier version (more specific override)
    const deduped = new Map<string, typeof personas[0]>();
    const tierPriority: Record<string, number> = { starter: 0, pro: 1, enterprise: 2 };

    for (const p of personas ?? []) {
      const key = `${p.persona_key}:${p.file_name}`;
      const existing = deduped.get(key);
      if (!existing || (tierPriority[p.plan_tier] ?? 0) > (tierPriority[existing.plan_tier] ?? 0)) {
        deduped.set(key, p);
      }
    }

    return jsonResponse({
      plan_tier: license.plan_tier,
      personas: Array.from(deduped.values()).map((p) => ({
        persona_key: p.persona_key,
        file_name: p.file_name,
        content: p.content,
        version: p.version,
        updated_at: p.updated_at,
      })),
    });
  } catch (err) {
    console.error("get-agent-personas error:", err);
    return jsonResponse({ error: "internal_error", message: "An unexpected error occurred" }, 500);
  }
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
