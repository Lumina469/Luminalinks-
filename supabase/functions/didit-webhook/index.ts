import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DIDIT_WEBHOOK_SECRET = Deno.env.get("DIDIT_WEBHOOK_SECRET")!;

// Verifies the webhook actually came from Didit, not an impostor hitting this
// URL directly — HMAC-SHA256 over the raw request body, using the webhook
// secret only Didit and this function know.
async function verifySignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(DIDIT_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computed = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computed === signature;
}

async function sendPush(pushToken: string | null, title: string, body: string, userId?: string) {
  if (userId) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await supabase.from("notifications").insert({ user_id: userId, title, body });
    } catch (_) { /* non-fatal */ }
  }
  if (!pushToken) return;
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: pushToken, title, body, sound: "default" }),
    });
  } catch (_) { /* non-fatal */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-signature-v2, x-timestamp",
      },
    });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-signature-v2");
  const timestamp = req.headers.get("x-timestamp");

  // Reject stale requests — protects against a captured, replayed webhook
  // being sent again later.
  if (timestamp && Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    return new Response(JSON.stringify({ error: "Request too old" }), { status: 401 });
  }

  const validSignature = await verifySignature(rawBody, signature);
  if (!validSignature) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  try {
    const payload = JSON.parse(rawBody);
    const status = payload.status; // APPROVED, DECLINED, IN_REVIEW, RESUBMITTED, IN_PROGRESS, NOT_STARTED
    const userId = payload.vendor_data; // the driver's profile id, set when we created the session

    if (!userId) {
      return new Response(JSON.stringify({ error: "Missing vendor_data" }), { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await supabase.from("profiles").select("push_token, full_name").eq("id", userId).maybeSingle();

    if (status === "APPROVED") {
      await supabase.from("profiles").update({
        is_verified: true,
        kyc_submitted: true,
        didit_status: "approved",
      }).eq("id", userId);
      await sendPush(profile?.push_token, "Verification Approved! ✅", "You're verified and can start receiving rides now.", userId);
    } else if (status === "DECLINED") {
      await supabase.from("profiles").update({
        is_verified: false,
        didit_status: "declined",
        suspension_reason: "Automated identity verification was declined — please contact support.",
      }).eq("id", userId);
      await sendPush(profile?.push_token, "Verification Declined", "We couldn't verify your identity automatically. Please contact support for help.", userId);
    } else if (status === "IN_REVIEW") {
      await supabase.from("profiles").update({ didit_status: "in_review" }).eq("id", userId);
      // No push here — an in-review state isn't actionable for the driver yet,
      // and pinging them for a non-decision would just create noise.
    } else {
      await supabase.from("profiles").update({ didit_status: status?.toLowerCase() || "unknown" }).eq("id", userId);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
