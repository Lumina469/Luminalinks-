import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: drivers, error } = await supabase
      .from("profiles")
      .select("id, full_name, road_worthy_expiry, registration_expiry, suspended, last_expiry_warning_sent, push_token")
      .eq("role", "driver")
      .eq("is_verified", true);

    if (error) throw error;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let suspendedCount = 0;
    let warnedCount = 0;

    for (const driver of drivers || []) {
      const dates = [driver.road_worthy_expiry, driver.registration_expiry].filter(Boolean);
      if (dates.length === 0) continue;

      // Find the soonest-expiring document
      const soonestExpiry = dates
        .map((d: string) => new Date(d))
        .sort((a, b) => a.getTime() - b.getTime())[0];

      const daysUntilExpiry = Math.floor(
        (soonestExpiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
      );

      // Day of expiry or already expired — auto-suspend (Blueprint: "Account automatically suspended until renewed")
      if (daysUntilExpiry <= 0 && !driver.suspended) {
        await supabase
          .from("profiles")
          .update({
            suspended: true,
            suspension_reason: "Road Worthy or Registration document expired",
            is_verified: false,
          })
          .eq("id", driver.id);

        if (driver.push_token) {
          await sendPush(driver.push_token, "Account Suspended", "Your Road Worthy or Registration has expired. Renew to continue driving.");
        }
        suspendedCount++;
        continue;
      }

      // 7 days before — urgent warning
      if (daysUntilExpiry === 7 && driver.last_expiry_warning_sent !== today.toISOString().split("T")[0]) {
        await supabase
          .from("profiles")
          .update({ last_expiry_warning_sent: today.toISOString().split("T")[0] })
          .eq("id", driver.id);

        if (driver.push_token) {
          await sendPush(driver.push_token, "Urgent: Document Expiring", "Your Road Worthy or Registration expires in 7 days. Renew immediately.");
        }
        warnedCount++;
      }

      // 30 days before — standard warning
      if (daysUntilExpiry === 30 && driver.last_expiry_warning_sent !== today.toISOString().split("T")[0]) {
        await supabase
          .from("profiles")
          .update({ last_expiry_warning_sent: today.toISOString().split("T")[0] })
          .eq("id", driver.id);

        if (driver.push_token) {
          await sendPush(driver.push_token, "Document Expiring Soon", "Your Road Worthy or Registration expires in 30 days. Please renew soon.");
        }
        warnedCount++;
      }
    }

    return new Response(
      JSON.stringify({ checked: drivers?.length || 0, suspended: suspendedCount, warned: warnedCount }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

async function sendPush(pushToken: string, title: string, body: string) {
  if (!pushToken) return;
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: pushToken, title, body, sound: "default" }),
    });
  } catch (e) { /* ignore push failures */ }
}
