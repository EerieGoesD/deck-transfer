import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let licenseKey: string | null = null;
    let email: string | null = null;
    let checkOnly = false;

    if (req.method === "GET") {
      const url = new URL(req.url);
      licenseKey = url.searchParams.get("key");
      email = url.searchParams.get("email");
      checkOnly = url.searchParams.get("check_only") === "true";
    } else {
      const body = await req.json();
      licenseKey = body.key || null;
      email = body.email || null;
      checkOnly = body.check_only || false;
    }

    // Validate by license key
    if (licenseKey) {
      const { data, error } = await supabase
        .from("license_keys")
        .select("*")
        .eq("license_key", licenseKey.toUpperCase().trim())
        .eq("product", "deck-transfer")
        .limit(1);

      if (error) {
        return new Response(
          JSON.stringify({ valid: false, error: "Server error" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!data || data.length === 0) {
        return new Response(
          JSON.stringify({ valid: false, error: "Invalid license key" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const key = data[0];

      if (!key.active) {
        return new Response(
          JSON.stringify({ valid: false, error: "This license key has been deactivated" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!checkOnly && key.activations >= key.max_activations) {
        return new Response(
          JSON.stringify({ valid: false, error: `Maximum activations reached (${key.max_activations} devices)` }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Increment activation count only on actual activation, not check-only
      if (!checkOnly) {
        await supabase
          .from("license_keys")
          .update({ activations: key.activations + 1 })
          .eq("id", key.id);
      }

      return new Response(
        JSON.stringify({ valid: true, email: key.email, license_key: key.license_key }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Lookup by email (for auto-activation after payment)
    if (email) {
      const { data, error } = await supabase
        .from("license_keys")
        .select("*")
        .eq("email", email.toLowerCase().trim())
        .eq("product", "deck-transfer")
        .eq("active", true)
        .limit(1);

      if (error || !data || data.length === 0) {
        return new Response(
          JSON.stringify({ valid: false, license_key: null }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const key = data[0];

      return new Response(
        JSON.stringify({ valid: true, license_key: key.license_key, email: key.email }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ valid: false, error: "Provide a license key or email" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Check-pro error:", err);
    return new Response(
      JSON.stringify({ valid: false, error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
