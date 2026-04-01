import Stripe from "https://esm.sh/stripe@14.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-04-10",
      httpClient: Stripe.createFetchHttpClient(),
    });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const licenseKey: string | null = body.key || null;

    if (!licenseKey) {
      return new Response(
        JSON.stringify({ error: "License key required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Look up the license key
    const { data, error } = await supabase
      .from("license_keys")
      .select("*")
      .eq("license_key", licenseKey.toUpperCase().trim())
      .eq("product", "deck-transfer")
      .limit(1);

    if (error || !data || data.length === 0) {
      return new Response(
        JSON.stringify({ error: "License key not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const key = data[0];

    if (!key.stripe_customer_id) {
      return new Response(
        JSON.stringify({ error: "No Stripe customer linked to this key" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create a Stripe Customer Portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: key.stripe_customer_id,
      return_url: "https://eeriegoesd.com/deck-transfer",
    });

    return new Response(
      JSON.stringify({ url: session.url }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Manage sub error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
