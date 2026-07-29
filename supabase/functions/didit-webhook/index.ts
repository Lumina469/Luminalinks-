import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DIDIT_WEBHOOK_SECRET = Deno.env.get("DIDIT_WEBHOOK_SECRET")!;

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, "0")).join("");
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
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-signature-v2, x-signature, x-signature-simple, x-timestamp",
      },
    });
  }

  const rawBody = await req.text();
  const sigV2 = req.headers.get("x-signature-v2");
  const sigSimple = req.headers.get("x-signature-simple");
  const timestamp = req.headers.get("x-timestamp");

  // Testing several candidate constructions against BOTH signature headers
  // Didit sends, based on real evidence from an actual delivery: "Simple" is
  // very likely HMAC(secret, body) alone; "V2" is very likely HMAC(secret,
  // something involving the timestamp) — a standard anti-replay pattern.
  const candidates: Record<string, string> = {
    "hmac(body)": await hmacHex(DIDIT_WEBHOOK_SECRET, rawBody),
    "hmac(timestamp.body)": timestamp ? await hmacHex(DIDIT_WEBHOOK_SECRET, `${timestamp}.${rawBody}`) : "no-timestamp",
    "hmac(timestamp+body)": timestamp ? await hmacHex(DIDIT_WEBHOOK_SECRET, `${timestamp}${rawBody}`) : "no-timestamp",
    "hmac(body.timestamp)": timestamp ? await hmacHex(DIDIT_WEBHOOK_SECRET, `${rawBody}.${timestamp}`) : "no-timestamp",
  };

  console.log("Received X-Signature-Simple:", sigSimple);
  console.log("Received X-Signature-V2:", sigV2);
  console.log("Received X-Timestamp:", timestamp);
  for (const [name, value] of Object.entries(candidates)) {
    console.log(`Candidate [${name}]:`, value, "→ matches Simple:", value === sigSimple, "| matches V2:", value === sigV2);
  }

  // Still non-blocking for now — accept if ANY candidate matches either
  // header, until the logs above give us a confirmed match to lock in.
  const anyMatch = Object.values(candidates).some(v => v === sigSimple || v === sigV2);
  if (!anyMatch) {
    console.log("⚠️ No candidate matched either signature — processing anyway (temporary)");
  }

  try {
    const payload = JSON.parse(rawBody);
    const status = payload.status;
    const userId = payload.vendor_data;

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
    } else {
      await supabase.from("profiles").update({ didit_status: status?.toLowerCase() || "unknown" }).eq("id", userId);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.log("Webhook processing error:", String(err));
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
