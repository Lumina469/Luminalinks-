import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function verifyPaystackSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PAYSTACK_SECRET_KEY),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computedHex = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computedHex === signature;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-paystack-signature",
      },
    });
  }

  // Must read the RAW body text for signature verification — parsing to
  // JSON and re-serializing can change the exact bytes and silently break
  // the signature check, wrongly rejecting genuine webhooks.
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature");

  const isValid = await verifyPaystackSignature(rawBody, signature);
  if (!isValid) {
    // Deliberately vague response — never confirm/deny *why* a request was
    // rejected to something that isn't proven to be Paystack itself.
    console.log("Webhook rejected: invalid signature");
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  const event = JSON.parse(rawBody);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (event.event === "transfer.success") {
      const reference = event.data?.reference;
      const { data: withdrawal } = await supabase.from("withdrawals").select("*").eq("paystack_reference", reference).maybeSingle();

      // Idempotency check — Paystack can send the same webhook more than
      // once. Without this, a duplicate delivery would deduct the driver's
      // wallet twice for one real withdrawal.
      if (!withdrawal || withdrawal.status === "success") {
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }

      const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", withdrawal.user_id).maybeSingle();
      if (wallet) {
        await supabase.from("wallets").update({
          balance: parseFloat((wallet.balance - withdrawal.amount).toFixed(2)),
          total_withdrawn: parseFloat((wallet.total_withdrawn + withdrawal.amount).toFixed(2)),
          last_updated: new Date().toISOString(),
        }).eq("user_id", withdrawal.user_id);
      }

      await supabase.from("withdrawals").update({
        status: "success",
        paystack_transfer_code: event.data?.transfer_code || withdrawal.paystack_transfer_code,
        completed_at: new Date().toISOString(),
      }).eq("id", withdrawal.id);

      console.log(`Withdrawal ${withdrawal.id} confirmed successful, wallet deducted.`);
    }

    else if (event.event === "transfer.failed" || event.event === "transfer.reversed") {
      const reference = event.data?.reference;
      const { data: withdrawal } = await supabase.from("withdrawals").select("*").eq("paystack_reference", reference).maybeSingle();

      if (!withdrawal || withdrawal.status === "failed" || withdrawal.status === "reversed") {
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }

      // If this withdrawal was already marked "success" (money was
      // deducted) and it's now being reversed, the deduction must be
      // refunded — otherwise the driver permanently loses real earnings for
      // a transfer that never actually reached them.
      if (withdrawal.status === "success") {
        const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", withdrawal.user_id).maybeSingle();
        if (wallet) {
          await supabase.from("wallets").update({
            balance: parseFloat((wallet.balance + withdrawal.amount).toFixed(2)),
            total_withdrawn: parseFloat((wallet.total_withdrawn - withdrawal.amount).toFixed(2)),
            last_updated: new Date().toISOString(),
          }).eq("user_id", withdrawal.user_id);
        }
        console.log(`Withdrawal ${withdrawal.id} reversed after prior success — wallet refunded.`);
      }

      await supabase.from("withdrawals").update({
        status: event.event === "transfer.reversed" ? "reversed" : "failed",
        failure_reason: event.data?.failure_reason || event.data?.reason || "Transfer did not complete",
      }).eq("id", withdrawal.id);
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (err) {
    console.log("Webhook processing error:", String(err));
    // Still return 200 — Paystack will retry on non-2xx responses, and a
    // processing bug on our side shouldn't trigger endless retries of a
    // webhook that was itself genuinely valid.
    return new Response(JSON.stringify({ received: true, error: String(err) }), { status: 200 });
  }
});
