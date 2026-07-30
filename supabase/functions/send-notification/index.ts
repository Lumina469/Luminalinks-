import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Driver-side roles — kept in sync with the app's own driver role checks
const DRIVER_ROLES = ["car_driver", "tuktuk_driver", "motorbike_rider", "restaurant", "driver", "home_service"];

Deno.serve(async (req) => {
  // Allow the admin dashboard (running from any origin) to call this function
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const { title, body, target } = await req.json();

    if (!title || !body) {
      return new Response(JSON.stringify({ error: "Missing title or body" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Service role key bypasses RLS entirely — this function is the only place
    // that should ever see every user's push token, never the browser directly.
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let query = supabase.from("profiles").select("id, push_token, role, notif_push, notif_promos");
    if (target === "clients") {
      query = query.eq("role", "client");
    } else if (target === "drivers") {
      query = query.in("role", DRIVER_ROLES);
    }
    // target === "all" (or anything else) → no role filter, everyone

    const { data, error } = await query;
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Respect preferences: skip anyone who turned off push entirely or opted
    // out of promos/broadcasts — applied once, used for both the in-app
    // record and the push send below, so the two stay consistent.
    const eligible = (data || []).filter((p: any) => p.notif_push !== false && p.notif_promos !== false);

    // Write an in-app notification record for EVERY eligible user — this was
    // the actual gap: previously this function only ever attempted a push
    // send, so if the push failed to deliver (app closed, stale token) or the
    // person just wasn't looking at their phone at that exact moment, the
    // notification vanished completely with no trace in the app itself.
    if (eligible.length > 0) {
      const notificationRows = eligible.map((p: any) => ({ user_id: p.id, title, body }));
      const { error: insertError } = await supabase.from("notifications").insert(notificationRows);
      if (insertError) {
        console.log("Failed to insert notification records:", insertError.message);
        // Don't abort the whole send over this — still attempt the push below,
        // but surface it in the response so it's visible something's off.
      }
    }

    const tokens = eligible
      .map((p: any) => p.push_token)
      .filter((t: string | null) => t && t.startsWith("ExponentPushToken"));

    let sent = 0;
    const chunkSize = 100; // Expo push API limit per request
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);
      const messages = chunk.map((to: string) => ({ to, title, body, sound: "default" }));
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(messages),
      });
      sent += chunk.length;
    }

    return new Response(JSON.stringify({ sent, matched: eligible.length, inAppRecordsCreated: eligible.length }), {
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
