import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`;

// Same haversine distance formula used throughout the real app — kept
// identical so a chat-quoted fare and the in-app fare never disagree.
function getDist(lat1: number, lon1: number, lat2: number, lon2: number) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Same base/perKm formula as the app's own calcFare — surge and night
// multipliers are intentionally left out here for simplicity; the fare
// quoted through chat is a same-formula estimate, and the exact final price
// (including any surge/night pricing) is confirmed in the app before payment,
// exactly like every other booking.
function calcFare(km: number, service: string, minFares: { car: number; tuktuk: number; motorbike: number }) {
  let base = 5.0, perKm = 8.0, minFare = minFares.car;
  if (service === "tuktuk") { base = 3.0; perKm = 5.0; minFare = minFares.tuktuk; }
  if (service === "motorbike") { base = 4.0; perKm = 6.0; minFare = minFares.motorbike; }
  return parseFloat(Math.max(minFare, base + km * perKm).toFixed(2));
}

function calcDeliveryFee(km: number) {
  return parseFloat(Math.max(10, 3 + km * 4).toFixed(2));
}

// Free, keyless geocoding via OpenStreetMap's Nominatim — same service the
// app itself relies on for address search. A hard timeout is used here
// specifically because a hanging geocode request was very likely why booking
// (which needs TWO of these) was timing out entirely, even though simple
// Q&A messages (which need none) worked fine.
async function geocodeAddress(address: string): Promise<{ lat: number; lng: number; display_name: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ", Ghana")}&format=json&limit=1`,
      { headers: { "User-Agent": "LumaGhanaApp/1.0 (contact: luminalinks43@gmail.com)" }, signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await res.json();
    if (data && data[0]) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display_name: data[0].display_name };
    }
  } catch (err) {
    console.log("Geocoding failed for address:", address, "-", String(err));
  }
  return null;
}

const TOOLS = [
  {
    function_declarations: [
      {
        name: "get_recent_rides",
        description: "Get the user's most recent ride bookings, including date, route, fare, and status.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "get_wallet_balance",
        description: "Get the driver's current wallet balance. Only relevant for drivers.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "get_favorite_drivers",
        description: "Get the client's list of favorite/saved drivers.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "cancel_current_ride",
        description: "Cancel the user's current active ride, but ONLY if it's still 'pending' (no driver accepted yet).",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "book_ride",
        description: "Book a real car or tuk tuk ride for the user (not motorbike — that's parcel delivery only, use send_parcel instead). Always tell the user the quoted fare and confirm before calling this.",
        parameters: {
          type: "object",
          properties: {
            pickup: { type: "string", description: "Pickup address, as specific as possible" },
            dropoff: { type: "string", description: "Destination address, as specific as possible" },
            service: { type: "string", enum: ["car", "tuktuk"] },
            payment_method: { type: "string", enum: ["cash", "momo", "card"] },
          },
          required: ["pickup", "dropoff", "service", "payment_method"],
        },
      },
      {
        name: "send_parcel",
        description: "Book a motorbike delivery to send a parcel/package from one address to another. This is delivery only, never for carrying a passenger.",
        parameters: {
          type: "object",
          properties: {
            pickup: { type: "string", description: "Where the rider should pick up the parcel" },
            dropoff: { type: "string", description: "Where the parcel should be delivered" },
            recipient_name: { type: "string", description: "Name of the person receiving the parcel" },
            recipient_phone: { type: "string", description: "Phone number of the person receiving the parcel" },
            payment_method: { type: "string", enum: ["cash", "momo", "card"] },
          },
          required: ["pickup", "dropoff", "payment_method"],
        },
      },
      {
        name: "search_restaurants",
        description: "Search for open, approved restaurants by name. Use this first when the user wants to order food, before looking at any menu.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Restaurant name or partial name to search for" } },
          required: ["query"],
        },
      },
      {
        name: "get_restaurant_menu",
        description: "Get the menu items (name, price, availability) for a specific restaurant. Call search_restaurants first to get the restaurant_id.",
        parameters: {
          type: "object",
          properties: { restaurant_id: { type: "string" } },
          required: ["restaurant_id"],
        },
      },
      {
        name: "place_food_order",
        description: "Place a real food order. Always confirm the exact items, quantities, delivery address, and total price with the user before calling this.",
        parameters: {
          type: "object",
          properties: {
            restaurant_id: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  menu_item_id: { type: "string" },
                  name: { type: "string" },
                  price: { type: "number" },
                  quantity: { type: "number" },
                },
              },
            },
            delivery_address: { type: "string" },
            payment_method: { type: "string", enum: ["momo", "card"] },
          },
          required: ["restaurant_id", "items", "delivery_address", "payment_method"],
        },
      },
    ],
  },
];

async function executeTool(name: string, args: any, userId: string, userName: string, bookingId: string | undefined, supabase: any) {
  if (name === "get_recent_rides") {
    const { data } = await supabase.from("bookings").select("pickup, dropoff, price, status, service, created_at").eq("client_id", userId).order("created_at", { ascending: false }).limit(5);
    return { rides: data || [] };
  }

  if (name === "get_wallet_balance") {
    const { data } = await supabase.from("wallets").select("balance").eq("user_id", userId).maybeSingle();
    return { wallet_balance: data?.balance ?? 0 };
  }

  if (name === "get_favorite_drivers") {
    const { data } = await supabase.from("favourite_drivers").select("driver_name").eq("client_id", userId);
    return { favorites: (data || []).map((f: any) => f.driver_name) };
  }

  if (name === "cancel_current_ride") {
    if (!bookingId) return { success: false, reason: "No active ride found to cancel." };
    const { data: booking } = await supabase.from("bookings").select("status").eq("id", bookingId).maybeSingle();
    if (!booking) return { success: false, reason: "Booking not found." };
    if (booking.status !== "pending") {
      return { success: false, reason: `This ride is already ${booking.status} — cancel it directly in the app instead, since a fee may apply.` };
    }
    await supabase.from("bookings").update({ status: "cancelled" }).eq("id", bookingId);
    return { success: true };
  }

  if (name === "book_ride") {
    const { pickup, dropoff, service, payment_method } = args;
    const [pickupGeo, dropoffGeo, settingsRows] = await Promise.all([
      geocodeAddress(pickup),
      geocodeAddress(dropoff),
      supabase.from("system_settings").select("key, value").in("key", ["car_min_fare", "tuktuk_min_fare", "motorbike_min_fare"]).then((r: any) => r.data),
    ]);
    if (!pickupGeo || !dropoffGeo) {
      return { success: false, reason: "Couldn't find one of those addresses. Please ask the user to be more specific, or suggest they use the map picker in the app instead." };
    }
    const settingsMap: any = { car: 20, tuktuk: 10, motorbike: 15 };
    (settingsRows || []).forEach((r: any) => {
      if (r.key === "car_min_fare") settingsMap.car = r.value;
      if (r.key === "tuktuk_min_fare") settingsMap.tuktuk = r.value;
      if (r.key === "motorbike_min_fare") settingsMap.motorbike = r.value;
    });
    const km = getDist(pickupGeo.lat, pickupGeo.lng, dropoffGeo.lat, dropoffGeo.lng);
    const fare = calcFare(km, service, settingsMap);
    const { data: booking, error } = await supabase.from("bookings").insert({
      client_id: userId,
      client_name: userName,
      pickup: pickupGeo.display_name,
      dropoff: dropoffGeo.display_name,
      service,
      price: fare,
      original_price: fare,
      status: "pending",
      payment_method,
      payment_status: payment_method === "cash" ? "n/a" : "awaiting_completion",
      client_lat: pickupGeo.lat,
      client_lng: pickupGeo.lng,
    }).select().single();
    if (error) return { success: false, reason: error.message };
    return { success: true, fare, distance_km: parseFloat(km.toFixed(1)), booking_id: booking.id, pickup: pickupGeo.display_name, dropoff: dropoffGeo.display_name };
  }

  if (name === "send_parcel") {
    const { pickup, dropoff, recipient_name, recipient_phone, payment_method } = args;
    const [pickupGeo, dropoffGeo] = await Promise.all([geocodeAddress(pickup), geocodeAddress(dropoff)]);
    if (!pickupGeo || !dropoffGeo) {
      return { success: false, reason: "Couldn't find one of those addresses. Please ask the user to be more specific." };
    }
    const km = getDist(pickupGeo.lat, pickupGeo.lng, dropoffGeo.lat, dropoffGeo.lng);
    const fare = calcFare(km, "motorbike", { car: 20, tuktuk: 10, motorbike: 15 });
    const { data: booking, error } = await supabase.from("bookings").insert({
      client_id: userId,
      client_name: userName,
      pickup: pickupGeo.display_name,
      dropoff: dropoffGeo.display_name,
      service: "motorbike",
      price: fare,
      original_price: fare,
      status: "pending",
      payment_method,
      payment_status: payment_method === "cash" ? "n/a" : "awaiting_completion",
      client_lat: pickupGeo.lat,
      client_lng: pickupGeo.lng,
      recipient_name: recipient_name || null,
      recipient_phone: recipient_phone || null,
    }).select().single();
    if (error) return { success: false, reason: error.message };
    return { success: true, fare, distance_km: parseFloat(km.toFixed(1)), booking_id: booking.id };
  }

  if (name === "search_restaurants") {
    const { data } = await supabase.from("restaurants").select("id, business_name, is_open").eq("is_approved", true).eq("is_open", true).ilike("business_name", `%${args.query}%`).limit(5);
    return { restaurants: data || [] };
  }

  if (name === "get_restaurant_menu") {
    const { data } = await supabase.from("menu_items").select("id, name, price, is_available").eq("restaurant_id", args.restaurant_id).eq("is_available", true);
    return { menu: data || [] };
  }

  if (name === "place_food_order") {
    const { restaurant_id, items, delivery_address, payment_method } = args;
    const { data: restaurant } = await supabase.from("restaurants").select("business_name, lat, lng").eq("id", restaurant_id).maybeSingle();
    if (!restaurant) return { success: false, reason: "Restaurant not found." };
    const deliveryGeo = await geocodeAddress(delivery_address);
    const km = deliveryGeo && restaurant.lat && restaurant.lng ? getDist(restaurant.lat, restaurant.lng, deliveryGeo.lat, deliveryGeo.lng) : 2;
    const deliveryFee = calcDeliveryFee(km);
    const subtotal = items.reduce((sum: number, it: any) => sum + (it.price * it.quantity), 0);
    const total = parseFloat((subtotal + deliveryFee).toFixed(2));
    const { data: order, error } = await supabase.from("food_orders").insert({
      client_id: userId,
      client_name: userName,
      restaurant_id,
      restaurant_name: restaurant.business_name,
      delivery_address: deliveryGeo?.display_name || delivery_address,
      delivery_lat: deliveryGeo?.lat || null,
      delivery_lng: deliveryGeo?.lng || null,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      payment: payment_method,
      payment_status: "awaiting_completion",
      delivery_fee_status: "pending",
      status: "pending",
    }).select().single();
    if (error) return { success: false, reason: error.message };
    return { success: true, order_id: order.id, subtotal, delivery_fee: deliveryFee, total };
  }

  return { error: "Unknown tool" };
}

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
    const { userId, userName, role, message, bookingId, orderId, history } = await req.json();

    if (!message) {
      return new Response(JSON.stringify({ error: "Missing message" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Kill switch — checked first, before anything else. Defaults to enabled
    // if the setting has never been touched, so a fresh install never
    // silently disables itself.
    const { data: killSwitchRow } = await supabase.from("system_settings").select("value").eq("key", "ai_assistant_enabled").maybeSingle();
    if (killSwitchRow && killSwitchRow.value === 0) {
      return new Response(JSON.stringify({
        reply: "Lumina is temporarily unavailable right now. Please tap 'Contact Support' below and our team will help you directly.",
        fallback: true,
      }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    let contextBlock = "No active ride or order context available.";
    if (bookingId) {
      const { data: booking } = await supabase.from("bookings").select("status, service, pickup, dropoff, price, payment_method, driver_id, created_at").eq("id", bookingId).maybeSingle();
      if (booking) {
        let driverName = "Not yet assigned";
        if (booking.driver_id) {
          const { data: driver } = await supabase.from("profiles").select("full_name").eq("id", booking.driver_id).maybeSingle();
          driverName = driver?.full_name || "Assigned driver";
        }
        contextBlock = `Current ride:\n- Status: ${booking.status}\n- Service: ${booking.service}\n- Pickup: ${booking.pickup}\n- Dropoff: ${booking.dropoff}\n- Fare: GHS ${booking.price}\n- Payment method: ${booking.payment_method}\n- Driver: ${driverName}\n- Booked: ${booking.created_at}`;
      }
    } else if (orderId) {
      const { data: order } = await supabase.from("food_orders").select("status, restaurant_name, total, payment, delivery_address, rider_id, created_at").eq("id", orderId).maybeSingle();
      if (order) {
        let riderName = "Not yet assigned";
        if (order.rider_id) {
          const { data: rider } = await supabase.from("profiles").select("full_name").eq("id", order.rider_id).maybeSingle();
          riderName = rider?.full_name || "Assigned rider";
        }
        contextBlock = `Current food order:\n- Status: ${order.status}\n- Restaurant: ${order.restaurant_name}\n- Total: GHS ${order.total}\n- Payment: ${order.payment}\n- Delivery address: ${order.delivery_address}\n- Delivery rider: ${riderName}\n- Placed: ${order.created_at}`;
      }
    }

    const systemPrompt = `You are Lumina, Luma's in-app AI assistant — Luma is a Ghana-based ride-hailing, delivery, and food services app. You are talking to a ${role === "client" ? "client (customer)" : "driver/rider (service provider)"}.

You have REAL tools that take REAL actions — booking a ride, sending a parcel, and ordering food actually create live bookings/orders, not simulations. Because of this:
- ALWAYS confirm the key details (addresses, fare, items, total) with the user in plain conversation BEFORE calling book_ride, send_parcel, or place_food_order. Never book or order silently on the first mention — ask "should I go ahead and book this?" or similar first, and only call the tool once they say yes.
- For food orders, always search_restaurants first, then get_restaurant_menu, then confirm the exact items/quantities/total with the user before place_food_order.
- Motorbike is delivery-only — never book it as a passenger ride, only via send_parcel.
- If book_ride or send_parcel fails because an address couldn't be found, ask the user for a more specific address rather than guessing.

Be concise, warm, and Ghana-context aware — plain everyday language, not corporate. If asked your name, you're Lumina.

If something is outside what your tools can do (a dispute, a policy question you're unsure of, account issues), say so honestly and suggest contacting human support.

Context for this conversation:
${contextBlock}`;

    const geminiHistory = (Array.isArray(history) ? history : []).map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    let contents = [...geminiHistory, { role: "user", parts: [{ text: message }] }];
    let finalReply: string | null = null;

    // Loop up to 5 tool-calling rounds — ordering food genuinely needs several
    // steps (search restaurant → check menu → place order), so a single
    // request/response round-trip isn't enough for that flow.
    for (let round = 0; round < 5; round++) {
      const geminiRes = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          tools: TOOLS,
          contents,
          generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
        }),
      });
      const geminiData = await geminiRes.json();

      if (!geminiRes.ok) {
        console.log(`Gemini API error (round ${round}):`, JSON.stringify(geminiData));
        return new Response(JSON.stringify({
          reply: "I'm having trouble reaching my AI assistant right now. Please tap 'Contact Support' below and our team will help you directly.",
          fallback: true,
        }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }

      const parts = geminiData?.candidates?.[0]?.content?.parts || [];
      const functionCall = parts.find((p: any) => p.functionCall)?.functionCall;
      const textPart = parts.find((p: any) => p.text)?.text;

      if (functionCall) {
        console.log("Lumina calling tool:", functionCall.name, JSON.stringify(functionCall.args));
        const toolResult = await executeTool(functionCall.name, functionCall.args || {}, userId, userName || "Client", bookingId, supabase);
        contents.push({ role: "model", parts: [{ functionCall }] });
        contents.push({ role: "user", parts: [{ functionResponse: { name: functionCall.name, response: toolResult } }] });
        continue; // loop again so Gemini can react to the tool result
      }

      finalReply = textPart || null;
      break;
    }

    const reply = finalReply || "I'm not sure how to help with that — please contact human support and they'll take it from here.";

    // Log this exchange for the admin console's AI Activity page — best
    // effort only; a logging failure should never block the actual reply
    // from reaching the user.
    const lastToolUsed = contents
      .slice()
      .reverse()
      .find((c: any) => c.parts?.[0]?.functionCall)?.parts?.[0]?.functionCall?.name || null;
    supabase.from("ai_activity_log").insert({
      user_id: userId,
      user_name: userName || "User",
      role: role || "client",
      message: message.slice(0, 500),
      tool_used: lastToolUsed,
    }).then(() => {}, (e: any) => console.log("Activity log insert failed (non-blocking):", String(e)));

    return new Response(JSON.stringify({ reply, fallback: false }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    console.log("ai-support-chat error:", String(err));
    return new Response(JSON.stringify({
      reply: "Something went wrong on our end. Please tap 'Contact Support' and our team will help you directly.",
      fallback: true,
    }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
});
