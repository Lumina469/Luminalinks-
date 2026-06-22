import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  // Allow the app to call this function
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const { reference, bookingId } = await req.json();

    if (!reference) {
      return new Response(JSON.stringify({ error: "Missing payment reference" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Verify the payment directly with Paystack using the SECRET key (server-side only)
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const verifyData = await verifyRes.json();

    if (!verifyData.status || verifyData.data.status !== "success") {
      return new Response(
        JSON.stringify({ verified: false, message: "Payment not successful" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const amountPaidGHS = verifyData.data.amount / 100; // Paystack returns amount in pesewas

    // Update the booking in Supabase to mark it as paid
    if (bookingId) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await supabase
        .from("bookings")
        .update({
          payment_status: "paid",
          payment_reference: reference,
          amount_paid: amountPaidGHS,
        })
        .eq("id", bookingId);
    }

    return new Response(
      JSON.stringify({
        verified: true,
        amount: amountPaidGHS,
        channel: verifyData.data.channel, // e.g. "mobile_money", "card"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
