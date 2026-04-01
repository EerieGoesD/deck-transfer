import Stripe from "https://esm.sh/stripe@14.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3?target=deno";
import { Resend } from "https://esm.sh/resend@3.2.0?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function generateLicenseKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segments = 4;
  const segLen = 4;
  const parts: string[] = [];
  for (let s = 0; s < segments; s++) {
    let seg = "";
    for (let i = 0; i < segLen; i++) {
      const arr = new Uint8Array(1);
      crypto.getRandomValues(arr);
      seg += chars[arr[0] % chars.length];
    }
    parts.push(seg);
  }
  return parts.join("-");
}

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

    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      return new Response(
        JSON.stringify({ error: "No signature" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      console.error("STRIPE_WEBHOOK_SECRET not set");
      return new Response(
        JSON.stringify({ error: "Server config error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret
    );

    console.log(`[WEBHOOK] Event: ${event.type}`);

    if (event.type === "checkout.session.completed" || event.type === "invoice.paid") {
      let email: string | null = null;
      let customerId: string | null = null;
      let subscriptionId: string | null = null;

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        email = session.customer_email || session.customer_details?.email || null;
        customerId = session.customer as string || null;
        subscriptionId = session.subscription as string || null;
      } else {
        const invoice = event.data.object as Stripe.Invoice;
        email = invoice.customer_email || null;
        customerId = invoice.customer as string || null;
        subscriptionId = invoice.subscription as string || null;
      }

      if (!email) {
        console.error("[WEBHOOK] No email found in event");
        return new Response(JSON.stringify({ error: "No email" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const emailLower = email.toLowerCase();

      // Check if a key already exists for this email + product
      const { data: existing } = await supabase
        .from("license_keys")
        .select("*")
        .eq("email", emailLower)
        .eq("product", "deck-transfer")
        .limit(1);

      let keyToEmail: string | null = null;

      if (existing && existing.length > 0) {
        // Update existing key (reactivate if needed) - don't re-send email
        console.log(`[WEBHOOK] Key already exists for ${emailLower}: ${existing[0].license_key}`);
        await supabase
          .from("license_keys")
          .update({
            active: true,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId || existing[0].stripe_subscription_id,
          })
          .eq("id", existing[0].id);
        // Don't set keyToEmail - no duplicate email
      } else {
        // Generate new license key
        const licenseKey = generateLicenseKey();
        console.log(`[WEBHOOK] Generated key for ${emailLower}: ${licenseKey}`);

        const { error: insertError } = await supabase
          .from("license_keys")
          .insert({
            license_key: licenseKey,
            email: emailLower,
            product: "deck-transfer",
            active: true,
            activations: 0,
            max_activations: 3,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
          });

        if (insertError) {
          if (insertError.code === "23505") {
            console.log(`[WEBHOOK] Key already created by concurrent event for ${emailLower}`);
          } else {
            console.error("[WEBHOOK] Insert error:", insertError);
            return new Response(
              JSON.stringify({ error: "Database error" }),
              { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        } else {
          keyToEmail = licenseKey;
        }
      }

      // Send license key email
      if (keyToEmail) {
        try {
          const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
          await resend.emails.send({
            from: "Deck Transfer <onboarding@resend.dev>",
            to: emailLower,
            subject: "Your Deck Transfer Pro License Key",
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #1a1b2e;">Deck Transfer Pro</h2>
                <p>Thank you for your purchase! Here is your license key:</p>
                <div style="background: #f4f4f8; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0;">
                  <code style="font-size: 24px; font-weight: 700; letter-spacing: 3px; color: #1a9fff;">${keyToEmail}</code>
                </div>
                <p><strong>How to activate:</strong></p>
                <ol>
                  <li>Open Deck Transfer</li>
                  <li>Click "Upgrade to Pro"</li>
                  <li>Paste your license key and click "Activate"</li>
                </ol>
                <p style="color: #666; font-size: 14px;">This key can be activated on up to 3 devices. Save this email for your records.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
                <p style="color: #999; font-size: 12px;">Deck Transfer by <a href="https://eeriegoesd.com" style="color: #1a9fff;">EERIE</a></p>
              </div>
            `,
          });
          console.log(`[WEBHOOK] License key email sent to ${emailLower}`);
        } catch (emailErr) {
          console.error(`[WEBHOOK] Failed to send email to ${emailLower}:`, emailErr);
          // Don't fail the webhook if email fails - key is still in the database
        }
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const subId = subscription.id;

      // Deactivate the license key
      const { error: updateError } = await supabase
        .from("license_keys")
        .update({ active: false })
        .eq("stripe_subscription_id", subId)
        .eq("product", "deck-transfer");

      if (updateError) {
        console.error("[WEBHOOK] Deactivation error:", updateError);
      } else {
        console.log(`[WEBHOOK] Deactivated key for subscription ${subId}`);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[WEBHOOK] Error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
