import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MOMO_BANK_CODES: { [key: string]: string } = {
  mtn: "MTN",
  vodafone: "VOD",
  airteltigo: "ATL",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const { userId, amount, momoProvider, momoNumber } = await req.json();
    if (!userId || !amount || !momoProvider || !momoNumber) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", userId).maybeSingle();
    if (!wallet || wallet.balance < amount) {
      return new Response(JSON.stringify({ success: false, message: "Insufficient wallet balance" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const bankCode = MOMO_BANK_CODES[momoProvider];
    if (!bankCode) {
      return new Response(JSON.stringify({ success: false, message: "Unknown Mobile Money provider" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: withdrawalRow } = await supabase.from("withdrawals").insert({
      user_id: userId,
      amount,
      momo_provider: momoProvider,
      momo_number: momoNumber,
      status: "pending",
    }).select().single();

    const { data: profile } = await supabase.from("profiles").select("paystack_recipient_code, full_name").eq("id", userId).maybeSingle();
    let recipientCode = profile?.paystack_recipient_code;

    if (!recipientCode) {
      const recipientRes = await fetch("https://api.paystack.co/transferrecipient", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "mobile_money",
          name: profile?.full_name || "LuminaLinks Driver",
          account_number: momoNumber,
          bank_code: bankCode,
          currency: "GHS",
        }),
      });
      const recipientData = await recipientRes.json();
      if (!recipientData.status) {
        await supabase.from("withdrawals").update({ status: "failed", failure_reason: recipientData.message }).eq("id", withdrawalRow.id);
        return new Response(JSON.stringify({ success: false, message: recipientData.message || "Could not register Mobile Money details with Paystack" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      recipientCode = recipientData.data.recipient_code;
      await supabase.from("profiles").update({ paystack_recipient_code: recipientCode, momo_provider: momoProvider }).eq("id", userId);
    }

    // Use the withdrawal row's own id as the transfer reference — lets the
    // webhook look this exact row up later without any ambiguity, even
    // before we have a transfer_code back from Paystack.
    const transferReference = `withdrawal-${withdrawalRow.id}`;

    const transferRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "balance",
        amount: Math.round(amount * 100),
        recipient: recipientCode,
        reason: "LuminaLinks driver withdrawal",
        reference: transferReference,
      }),
    });
    const transferData = await transferRes.json();

    // transferData.status here is ONLY whether Paystack accepted the API
    // call — NOT whether the transfer itself succeeded. Per Paystack's own
    // docs, the real outcome (data.status: pending / otp / success) arrives
    // later via webhook. This function must never treat API acceptance as
    // confirmation that money actually moved.
    if (!transferData.status) {
      await supabase.from("withdrawals").update({ status: "failed", failure_reason: transferData.message }).eq("id", withdrawalRow.id);
      return new Response(JSON.stringify({ success: false, message: transferData.message || "Transfer could not be initiated" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const requiresOtp = transferData.data?.status === "otp";

    // Record the transfer_code so the webhook can match this row later, but
    // deliberately do NOT touch the wallet or mark this "success" yet — that
    // only happens once Paystack's webhook confirms the transfer actually
    // completed.
    await supabase.from("withdrawals").update({
      status: requiresOtp ? "otp_required" : "processing",
      paystack_transfer_code: transferData.data?.transfer_code || null,
      paystack_reference: transferReference,
    }).eq("id", withdrawalRow.id);

    return new Response(JSON.stringify({
      success: true,
      pending: true,
      amount,
      message: requiresOtp
        ? "Your withdrawal needs manual approval in the Paystack dashboard before it can complete — this shouldn't normally happen once OTP is disabled for transfers."
        : "Your withdrawal has been submitted and is processing. You'll be notified once it's complete.",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
