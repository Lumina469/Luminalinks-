import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DIDIT_API_KEY = Deno.env.get("DIDIT_API_KEY")!;
const DIDIT_WORKFLOW_ID = Deno.env.get("DIDIT_WORKFLOW_ID")!;

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
    const { userId } = await req.json();
    if (!userId) {
      return new Response(JSON.stringify({ error: "Missing userId" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const diditRes = await fetch("https://verification.didit.me/v3/session/", {
      method: "POST",
      headers: {
        "x-api-key": DIDIT_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow_id: DIDIT_WORKFLOW_ID,
        vendor_data: userId,
      }),
    });

    const diditData = await diditRes.json();
    // Log the FULL raw response — Didit's own docs disagree on the exact
    // field name across different pages (session_url vs verification_url),
    // so rather than guess again, this makes the real shape visible in the
    // function's logs the next time this runs.
    console.log("Didit raw response:", JSON.stringify(diditData));

    if (!diditRes.ok) {
      return new Response(JSON.stringify({ error: diditData?.message || diditData?.error || "Didit session creation failed", raw: diditData }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Try every field name Didit's docs have used for this — url, session_url,
    // and verification_url — so this works regardless of which one this
    // account/API version actually returns.
    const resolvedUrl = diditData.url || diditData.session_url || diditData.verification_url;

    if (!resolvedUrl) {
      // Genuinely couldn't find a usable URL anywhere in the response —
      // return the raw data so it's visible without needing a log lookup.
      return new Response(JSON.stringify({ error: "Didit didn't return a session URL", raw: diditData }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("profiles").update({
      kyc_submitted: true,
      didit_session_id: diditData.session_id || null,
    }).eq("id", userId);

    return new Response(JSON.stringify({
      sessionUrl: resolvedUrl,
      sessionId: diditData.session_id,
    }), {
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
