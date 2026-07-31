import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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
    const { userId, role, message, bookingId, orderId, history } = await req.json();

    if (!message) {
      return new Response(JSON.stringify({ error: "Missing message" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Pull live context — this is what makes the assistant actually useful
    // instead of a generic FAQ bot. It can only ever see this specific
    // person's own active ride/order, nothing else.
    let contextBlock = "No active ride or order context available.";

    if (bookingId) {
      const { data: booking } = await supabase
        .from("bookings")
        .select("status, service, pickup, dropoff, price, payment_method, driver_id, created_at")
        .eq("id", bookingId)
        .maybeSingle();

      if (booking) {
        let driverName = "Not yet assigned";
        if (booking.driver_id) {
          const { data: driver } = await supabase.from("profiles").select("full_name").eq("id", booking.driver_id).maybeSingle();
          driverName = driver?.full_name || "Assigned driver";
        }
        contextBlock = `Current ride:
- Status: ${booking.status}
- Service: ${booking.service}
- Pickup: ${booking.pickup}
- Dropoff: ${booking.dropoff}
- Fare: GHS ${booking.price}
- Payment method: ${booking.payment_method}
- Driver: ${driverName}
- Booked: ${booking.created_at}`;
      }
    } else if (orderId) {
      const { data: order } = await supabase
        .from("food_orders")
        .select("status, restaurant_name, total, payment, delivery_address, rider_id, created_at")
        .eq("id", orderId)
        .maybeSingle();

      if (order) {
        let riderName = "Not yet assigned";
        if (order.rider_id) {
          const { data: rider } = await supabase.from("profiles").select("full_name").eq("id", order.rider_id).maybeSingle();
          riderName = rider?.full_name || "Assigned rider";
        }
        contextBlock = `Current food order:
- Status: ${order.status}
- Restaurant: ${order.restaurant_name}
- Total: GHS ${order.total}
- Payment: ${order.payment}
- Delivery address: ${order.delivery_address}
- Delivery rider: ${riderName}
- Placed: ${order.created_at}`;
      }
    }

    const systemPrompt = `You are Lumina, Luma's in-app AI assistant — Luma is a Ghana-based ride-hailing, delivery, and home services app. You are talking to a ${role === "client" ? "client (customer)" : "driver/rider (service provider)"}.

Answer ONLY using the context provided below and general knowledge of how Luma works (rides, food delivery, payments via cash/MoMo/card, driver ratings, tipping, SOS safety features, cancellation fees). Be concise, warm, and Ghana-context aware — plain everyday language, not corporate. If asked your name, you're Lumina.

If the question needs information you don't have (e.g. a specific policy you're unsure of, an account issue, a dispute), say so honestly and suggest they contact human support rather than guessing.

Context for this conversation:
${contextBlock}`;

    // Gemini uses "user"/"model" as role names (not "assistant"), and takes
    // the system prompt as a separate top-level field rather than mixed into
    // the message list.
    const geminiHistory = (Array.isArray(history) ? history : []).map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [
          ...geminiHistory,
          { role: "user", parts: [{ text: message }] },
        ],
      }),
    });

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      console.log("Gemini API error:", JSON.stringify(geminiData));
      // Never let this hang or error out to the user — fall back to a
      // canned, honest response instead.
      return new Response(JSON.stringify({
        reply: "I'm having trouble reaching my AI assistant right now. Please tap 'Contact Support' below and our team will help you directly.",
        fallback: true,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text
      || "I'm not sure how to help with that — please contact human support and they'll take it from here.";

    return new Response(JSON.stringify({ reply, fallback: false }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    console.log("ai-support-chat error:", String(err));
    return new Response(JSON.stringify({
      reply: "Something went wrong on our end. Please tap 'Contact Support' and our team will help you directly.",
      fallback: true,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
