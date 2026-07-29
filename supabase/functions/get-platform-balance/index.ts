import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    // Real Paystack account balance (this is EVERYONE's money mixed together —
    // driver earnings still owed, plus the platform's own commission)
    const balanceRes = await fetch("https://api.paystack.co/balance", {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
    const balanceData = await balanceRes.json();
    const ghsBalance = balanceData.data?.find((b: any) => b.currency === "GHS");
    const paystackBalanceGHS = ghsBalance ? ghsBalance.balance / 100 : 0;

    // Total still owed to drivers — this money is NOT the platform's to withdraw,
    // even though it's sitting in the same Paystack balance right now.
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: wallets } = await supabase.from("wallets").select("balance");
    const totalDriverWallets = (wallets || []).reduce((sum: number, w: any) => sum + (w.balance || 0), 0);

    const availableToFounder = Math.max(0, parseFloat((paystackBalanceGHS - totalDriverWallets).toFixed(2)));

    return new Response(
      JSON.stringify({
        paystackBalance: paystackBalanceGHS,
        totalDriverWallets: parseFloat(totalDriverWallets.toFixed(2)),
        availableToFounder,
      }),
      { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
