import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Paystack's bank codes for Ghana Mobile Money networks
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

    // Confirm the wallet actually has this much available before doing anything
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

    // Create a withdrawal record up front, marked pending
    const { data: withdrawalRow } = await supabase.from("withdrawals").insert({
      user_id: userId,
      amount,
      momo_provider: momoProvider,
      momo_number: momoNumber,
      status: "pending",
    }).select().single();

    // Reuse an existing Paystack transfer recipient if we already created one for
    // this user, otherwise create a fresh one now.
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

    // Initiate the real transfer
    const transferRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "balance",
        amount: Math.round(amount * 100), // pesewas
        recipient: recipientCode,
        reason: "LuminaLinks driver withdrawal",
      }),
    });
    const transferData = await transferRes.json();

    if (!transferData.status) {
      await supabase.from("withdrawals").update({ status: "failed", failure_reason: transferData.message }).eq("id", withdrawalRow.id);
      return new Response(JSON.stringify({ success: false, message: transferData.message || "Transfer could not be initiated" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Success — deduct from wallet and mark the withdrawal complete
    await supabase.from("wallets").update({
      balance: parseFloat((wallet.balance - amount).toFixed(2)),
      total_withdrawn: parseFloat((wallet.total_withdrawn + amount).toFixed(2)),
      last_updated: new Date().toISOString(),
    }).eq("user_id", userId);

    await supabase.from("withdrawals").update({
      status: "success",
      paystack_transfer_code: transferData.data.transfer_code,
    }).eq("id", withdrawalRow.id);

    return new Response(JSON.stringify({ success: true, amount }), {
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
