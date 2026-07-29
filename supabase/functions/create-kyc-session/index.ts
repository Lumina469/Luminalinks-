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

    // Create the verification session with Didit. vendor_data lets us map
    // Didit's result back to the correct driver profile when the webhook
    // fires later — this is the ONLY link between the two systems.
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
    if (!diditRes.ok) {
      return new Response(JSON.stringify({ error: diditData?.message || "Didit session creation failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Record that a session was started, so the driver profile shows
    // "verification in progress" even before Didit's webhook comes back —
    // otherwise there'd be a confusing gap between tapping "Verify" and
    // actually getting a result.
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from("profiles").update({
      kyc_submitted: true,
      didit_session_id: diditData.session_id || null,
    }).eq("id", userId);

    return new Response(JSON.stringify({
      sessionUrl: diditData.session_url || diditData.verification_url,
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
