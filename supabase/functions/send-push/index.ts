// Supabase Edge Function: send-push
// Invia una notifica push a tutti i dispositivi interessati quando viene
// inserita una riga nella tabella "notifiche" (Database Webhook).
//
// Segreti richiesti (Supabase > Edge Functions > Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (es. mailto:coordinatore@esempio.it)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già disponibili automaticamente.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const n = body.record;
    if (!n) return new Response("no record", { status: 400 });

    let q = sb.from("profiles").select("id").eq("attivo", true);
    if (n.destinatari === "master") q = q.eq("ruolo", "master");
    const { data: users } = await q;
    const ids = (users ?? []).map((u) => u.id);
    if (!ids.length) return new Response("nessun destinatario");

    const { data: subs } = await sb.from("push_subscriptions").select("*").in("user_id", ids);

    const payload = JSON.stringify({
      title: n.titolo,
      body: n.testo,
      tag: n.id,
      url: n.inventario_id ? `./#notifiche/${n.id}` : "./#notifiche",
    });

    let sent = 0;
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(s.subscription, payload);
        sent++;
      } catch (e) {
        // sottoscrizione scaduta: la rimuoviamo
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        }
      }
    }
    return new Response(JSON.stringify({ sent }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
});
