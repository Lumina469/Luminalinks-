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
    const { amount, momoProvider, momoNumber } = await req.json();
    if (!amount || !momoProvider || !momoNumber) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Re-check the real available amount server-side — never trust a client-provided
    // amount for something this sensitive. Same calculation as get-platform-balance.
    const balanceRes = await fetch("https://api.paystack.co/balance", {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
    const balanceData = await balanceRes.json();
    const ghsBalance = balanceData.data?.find((b: any) => b.currency === "GHS");
    const paystackBalanceGHS = ghsBalance ? ghsBalance.balance / 100 : 0;

    const { data: wallets } = await supabase.from("wallets").select("balance");
    const totalDriverWallets = (wallets || []).reduce((sum: number, w: any) => sum + (w.balance || 0), 0);
    const availableToFounder = Math.max(0, paystackBalanceGHS - totalDriverWallets);

    if (amount > availableToFounder) {
      return new Response(JSON.stringify({ success: false, message: `Only GHS ${availableToFounder.toFixed(2)} is actually available — the rest is still owed to drivers.` }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const bankCode = MOMO_BANK_CODES[momoProvider];
    if (!bankCode) {
      return new Response(JSON.stringify({ success: false, message: "Unknown Mobile Money provider" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const { data: withdrawalRow } = await supabase.from("founder_withdrawals").insert({
      amount,
      momo_provider: momoProvider,
      momo_number: momoNumber,
      status: "pending",
    }).select().single();

    // Reuse an existing recipient if we already created one
    const { data: settings } = await supabase.from("founder_payout_settings").select("*").eq("id", 1).maybeSingle();
    let recipientCode = settings?.paystack_recipient_code;

    if (!recipientCode) {
      const recipientRes = await fetch("https://api.paystack.co/transferrecipient", {
        method: "POST",
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "mobile_money",
          name: "LuminaLinks Founder",
          account_number: momoNumber,
          bank_code: bankCode,
          currency: "GHS",
        }),
      });
      const recipientData = await recipientRes.json();
      if (!recipientData.status) {
        await supabase.from("founder_withdrawals").update({ status: "failed", failure_reason: recipientData.message }).eq("id", withdrawalRow.id);
        return new Response(JSON.stringify({ success: false, message: recipientData.message || "Could not register Mobile Money details" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      recipientCode = recipientData.data.recipient_code;
      await supabase.from("founder_payout_settings").upsert({ id: 1, paystack_recipient_code: recipientCode, momo_provider: momoProvider, momo_number: momoNumber });
    }

    const transferRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "balance",
        amount: Math.round(amount * 100),
        recipient: recipientCode,
        reason: "LuminaLinks platform revenue withdrawal",
      }),
    });
    const transferData = await transferRes.json();

    if (!transferData.status) {
      await supabase.from("founder_withdrawals").update({ status: "failed", failure_reason: transferData.message }).eq("id", withdrawalRow.id);
      return new Response(JSON.stringify({ success: false, message: transferData.message || "Transfer could not be initiated" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    await supabase.from("founder_withdrawals").update({
      status: "success",
      paystack_transfer_code: transferData.data.transfer_code,
    }).eq("id", withdrawalRow.id);

    return new Response(JSON.stringify({ success: true, amount }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
