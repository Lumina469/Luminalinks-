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
    const { refundRequestId } = await req.json();
    if (!refundRequestId) {
      return new Response(JSON.stringify({ error: "Missing refundRequestId" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: refundRequest } = await supabase
      .from("refund_requests")
      .select("*")
      .eq("id", refundRequestId)
      .maybeSingle();

    if (!refundRequest) {
      return new Response(JSON.stringify({ error: "Refund request not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (!refundRequest.payment_reference) {
      return new Response(JSON.stringify({ error: "No payment reference on this request — cannot process a real refund (was this a cash payment?)" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Call Paystack's real refund API — this is an actual reversal of the original charge
    const refundRes = await fetch("https://api.paystack.co/refund", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transaction: refundRequest.payment_reference,
        amount: Math.round(refundRequest.amount * 100), // Paystack expects pesewas
      }),
    });

    const refundData = await refundRes.json();

    if (!refundData.status) {
      // Paystack rejected the refund (e.g. already refunded, transaction too old, etc.)
      return new Response(JSON.stringify({ success: false, message: refundData.message || "Paystack could not process this refund" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Mark the refund request as approved
    await supabase.from("refund_requests").update({
      status: "approved",
      resolved_at: new Date().toISOString(),
    }).eq("id", refundRequestId);

    // Mark the original booking/order's payment as refunded
    if (refundRequest.booking_id) {
      await supabase.from("bookings").update({ payment_status: "refunded" }).eq("id", refundRequest.booking_id);
    }
    if (refundRequest.food_order_id) {
      await supabase.from("food_orders").update({ payment_status: "refunded" }).eq("id", refundRequest.food_order_id);
    }

    return new Response(JSON.stringify({ success: true, amount: refundRequest.amount }), {
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
