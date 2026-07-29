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
    const { reference, bookingId, paymentType } = await req.json();

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

    // FOOD ORDERS — separate table, separate flow. Payment happens at order time
    // (not at completion like rides), so this just marks the order paid; the rider
    // gets credited later at actual delivery time (handled elsewhere in the app).
    if (paymentType === "food_order" && bookingId) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await supabase.from("food_orders").update({
        payment_status: "paid",
        payment_reference: reference,
        amount_paid: amountPaidGHS,
      }).eq("id", bookingId);

      return new Response(
        JSON.stringify({ verified: true, amount: amountPaidGHS, channel: verifyData.data.channel, type: "food_order" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // DELIVERY FEE — paid separately from the food bill, once the rider actually
    // delivers. This is the moment the rider finally gets credited for this order.
    if (paymentType === "delivery_fee" && bookingId) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const PLATFORM_COMMISSION = 0.15;

      const { data: order } = await supabase.from("food_orders").select("rider_id").eq("id", bookingId).maybeSingle();

      await supabase.from("food_orders").update({
        delivery_fee_status: "paid",
      }).eq("id", bookingId);

      if (order?.rider_id) {
        const riderEarnings = parseFloat((amountPaidGHS * (1 - PLATFORM_COMMISSION)).toFixed(2));
        const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", order.rider_id).maybeSingle();
        if (wallet) {
          await supabase.from("wallets").update({
            balance: parseFloat((wallet.balance + riderEarnings).toFixed(2)),
            total_earned: parseFloat((wallet.total_earned + riderEarnings).toFixed(2)),
            last_updated: new Date().toISOString(),
          }).eq("user_id", order.rider_id);
        } else {
          await supabase.from("wallets").insert({
            user_id: order.rider_id,
            balance: riderEarnings,
            total_earned: riderEarnings,
            total_withdrawn: 0,
            currency: "GHS",
            last_updated: new Date().toISOString(),
          });
        }
      }

      return new Response(
        JSON.stringify({ verified: true, amount: amountPaidGHS, channel: verifyData.data.channel, type: "delivery_fee" }),
        { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    // TIPS are a completely separate flow from the ride fare — a tip is extra money
    // on top of an already-paid (or cash) ride, so this must NEVER touch the booking's
    // own payment_status/amount_paid/payment_reference fields, only credit the driver.
    if (paymentType === "tip" && bookingId) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: booking } = await supabase.from("bookings").select("driver_id, tip_amount").eq("id", bookingId).maybeSingle();
      const driverId = booking?.driver_id;

      await supabase.from("bookings").update({
        tip_amount: parseFloat(((booking?.tip_amount || 0) + amountPaidGHS).toFixed(2)),
      }).eq("id", bookingId);

      if (driverId) {
        const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", driverId).maybeSingle();
        if (wallet) {
          await supabase.from("wallets").update({
            balance: parseFloat((wallet.balance + amountPaidGHS).toFixed(2)),
            total_earned: parseFloat((wallet.total_earned + amountPaidGHS).toFixed(2)),
            last_updated: new Date().toISOString(),
          }).eq("user_id", driverId);
        } else {
          await supabase.from("wallets").insert({
            user_id: driverId,
            balance: amountPaidGHS,
            total_earned: amountPaidGHS,
            total_withdrawn: 0,
            currency: "GHS",
            last_updated: new Date().toISOString(),
          });
        }
      }

      return new Response(
        JSON.stringify({ verified: true, amount: amountPaidGHS, channel: verifyData.data.channel, type: "tip" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    let payoutType: "fare" | "cancellation_fee" | null = null;

    // Update the booking in Supabase to mark it as paid
    if (bookingId) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: booking } = await supabase
        .from("bookings")
        .select("status, cancellation_charge, driver_id, payment_status")
        .eq("id", bookingId)
        .maybeSingle();

      await supabase
        .from("bookings")
        .update({
          payment_status: "paid",
          payment_reference: reference,
          amount_paid: amountPaidGHS,
        })
        .eq("id", bookingId);

      // If this booking was cancelled with a fee owed, this payment IS that fee —
      // credit the driver's wallet now, only because Paystack just confirmed the
      // charge really succeeded. Never credit optimistically before this point.
      if (booking && booking.status === "cancelled" && (booking.cancellation_charge || 0) > 0 && booking.payment_status !== "paid") {
        payoutType = "cancellation_fee";
        const driverId = booking.driver_id;
        if (driverId) {
          const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", driverId).maybeSingle();
          if (wallet) {
            await supabase.from("wallets").update({
              balance: parseFloat((wallet.balance + amountPaidGHS).toFixed(2)),
              total_earned: parseFloat((wallet.total_earned + amountPaidGHS).toFixed(2)),
              last_updated: new Date().toISOString(),
            }).eq("user_id", driverId);
          } else {
            await supabase.from("wallets").insert({
              user_id: driverId,
              balance: amountPaidGHS,
              total_earned: amountPaidGHS,
              total_withdrawn: 0,
              currency: "GHS",
              last_updated: new Date().toISOString(),
            });
          }
        }
      } else {
        payoutType = "fare";
      }
    }

    return new Response(
      JSON.stringify({
        verified: true,
        amount: amountPaidGHS,
        channel: verifyData.data.channel, // e.g. "mobile_money", "card"
        type: payoutType,
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
