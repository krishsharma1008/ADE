/**
 * Combyne AI — Supabase Edge Function: validate-license
 *
 * Deploy to Supabase:
 *   1. Install Supabase CLI: brew install supabase/tap/supabase
 *   2. supabase login
 *   3. supabase functions deploy validate-license --project-ref cmkybsmznmhclytbjnwh
 *
 * Or copy this into the Supabase Dashboard → Edge Functions → New Function
 *
 * This function handles license activation, heartbeat, and deactivation.
 * It uses the service_role key internally to bypass RLS.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  license_key: string;
  machine_fingerprint: string;
  action: "activate" | "heartbeat" | "deactivate";
  app_version?: string;
  os_info?: string;
  machine_label?: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body: RequestBody = await req.json();

    if (!body.license_key || !body.machine_fingerprint || !body.action) {
      return jsonResponse(
        { valid: false, error: "invalid_request", message: "Missing required fields: license_key, machine_fingerprint, action" },
        400,
      );
    }

    // Look up the license
    const { data: license, error: licenseError } = await supabase
      .from("licenses")
      .select("*")
      .eq("license_key", body.license_key)
      .single();

    if (licenseError || !license) {
      return jsonResponse({
        valid: false,
        error: "license_not_found",
        message: "License key not found. Please check your key and try again.",
      });
    }

    // Check if revoked
    if (license.status === "revoked") {
      return jsonResponse({
        valid: false,
        error: "license_revoked",
        message: "This license has been revoked. Contact support@combyne.ai for assistance.",
      });
    }

    // Check if suspended
    if (license.status === "suspended") {
      return jsonResponse({
        valid: false,
        error: "license_suspended",
        message: "This license has been suspended. Contact support@combyne.ai for assistance.",
      });
    }

    // Check expiry
    const validUntil = new Date(license.valid_until);
    if (validUntil < new Date()) {
      // Auto-update status to expired
      await supabase
        .from("licenses")
        .update({ status: "expired" })
        .eq("id", license.id);

      return jsonResponse({
        valid: false,
        error: "license_expired",
        message: `Your license expired on ${validUntil.toISOString().split("T")[0]}. Visit https://combyne.ai to renew.`,
      });
    }

    // Handle actions
    switch (body.action) {
      case "activate":
        return await handleActivate(license, body);
      case "heartbeat":
        return await handleHeartbeat(license, body);
      case "deactivate":
        return await handleDeactivate(license, body);
      default:
        return jsonResponse(
          { valid: false, error: "invalid_request", message: `Unknown action: ${body.action}` },
          400,
        );
    }
  } catch (err) {
    console.error("validate-license error:", err);
    return jsonResponse(
      { valid: false, error: "internal_error", message: "An unexpected error occurred" },
      500,
    );
  }
});

async function handleActivate(license: any, body: RequestBody) {
  // Check if this machine already has an active activation
  const { data: existing } = await supabase
    .from("license_activations")
    .select("id, activated_at")
    .eq("license_id", license.id)
    .eq("machine_fingerprint", body.machine_fingerprint)
    .eq("is_active", true)
    .single();

  if (existing) {
    // Re-activation of same machine — just update heartbeat
    await supabase
      .from("license_activations")
      .update({
        last_heartbeat: new Date().toISOString(),
        app_version: body.app_version || null,
        os_info: body.os_info || null,
        machine_label: body.machine_label || null,
      })
      .eq("id", existing.id);

    return jsonResponse({
      valid: true,
      license: {
        status: license.status,
        plan_tier: license.plan_tier,
        valid_until: license.valid_until,
      },
      activation: {
        id: existing.id,
        activated_at: existing.activated_at,
      },
    });
  }

  // Check activation count
  const { count } = await supabase
    .from("license_activations")
    .select("id", { count: "exact", head: true })
    .eq("license_id", license.id)
    .eq("is_active", true);

  const activeCount = count ?? 0;

  if (activeCount >= license.max_activations) {
    return jsonResponse({
      valid: false,
      error: "max_activations_exceeded",
      message: `This license is already active on ${activeCount} machine(s) (max ${license.max_activations}). Deactivate another machine or upgrade your plan.`,
      details: {
        max_activations: license.max_activations,
        current_activations: activeCount,
      },
    });
  }

  // Create new activation
  const { data: activation, error: activationError } = await supabase
    .from("license_activations")
    .insert({
      license_id: license.id,
      machine_fingerprint: body.machine_fingerprint,
      machine_label: body.machine_label || null,
      app_version: body.app_version || null,
      os_info: body.os_info || null,
      last_heartbeat: new Date().toISOString(),
    })
    .select("id, activated_at")
    .single();

  if (activationError) {
    console.error("Activation insert error:", activationError);
    return jsonResponse(
      { valid: false, error: "activation_failed", message: "Failed to create activation" },
      500,
    );
  }

  return jsonResponse({
    valid: true,
    license: {
      status: license.status,
      plan_tier: license.plan_tier,
      valid_until: license.valid_until,
    },
    activation: {
      id: activation.id,
      activated_at: activation.activated_at,
    },
  });
}

async function handleHeartbeat(license: any, body: RequestBody) {
  // Find active activation for this machine
  const { data: activation, error } = await supabase
    .from("license_activations")
    .select("id, activated_at")
    .eq("license_id", license.id)
    .eq("machine_fingerprint", body.machine_fingerprint)
    .eq("is_active", true)
    .single();

  if (error || !activation) {
    return jsonResponse({
      valid: false,
      error: "not_activated",
      message: "No active activation found for this machine. Please activate your license first.",
    });
  }

  // Update heartbeat
  await supabase
    .from("license_activations")
    .update({
      last_heartbeat: new Date().toISOString(),
      app_version: body.app_version || null,
    })
    .eq("id", activation.id);

  return jsonResponse({
    valid: true,
    license: {
      status: license.status,
      plan_tier: license.plan_tier,
      valid_until: license.valid_until,
    },
    activation: {
      id: activation.id,
      activated_at: activation.activated_at,
    },
  });
}

async function handleDeactivate(license: any, body: RequestBody) {
  const { error } = await supabase
    .from("license_activations")
    .update({
      is_active: false,
      deactivated_at: new Date().toISOString(),
    })
    .eq("license_id", license.id)
    .eq("machine_fingerprint", body.machine_fingerprint)
    .eq("is_active", true);

  if (error) {
    console.error("Deactivation error:", error);
    return jsonResponse(
      { valid: false, error: "deactivation_failed", message: "Failed to deactivate" },
      500,
    );
  }

  return jsonResponse({
    valid: true,
    message: "License deactivated successfully on this machine.",
  });
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
