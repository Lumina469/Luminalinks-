import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const { settings } = await req.json(); // expects: [{ key, value }, ...]

    if (!Array.isArray(settings) || settings.length === 0) {
      return new Response(JSON.stringify({ error: "Missing or empty settings array" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Service role key bypasses RLS — this is the only place that should
    // ever write to system_settings, never the browser directly.
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const results = [];
    for (const item of settings) {
      const key = item?.key;
      const value = item?.value;
      const text_value = item?.text_value;
      if (!key || typeof value !== "number" || Number.isNaN(value)) {
        results.push({ key, ok: false, error: "Invalid key or value" });
        continue;
      }
      const payload: Record<string, unknown> = { key, value };
      if (typeof text_value === "string") payload.text_value = text_value;
      const { error } = await supabase
        .from("system_settings")
        .upsert(payload, { onConflict: "key" });
      results.push({ key, ok: !error, error: error?.message });
    }

    const allOk = results.every((r) => r.ok);
    return new Response(JSON.stringify({ success: allOk, results }), {
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
