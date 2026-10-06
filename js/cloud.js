// Collegamento a Supabase: gestione operatori con PIN a 4 cifre, sincronizzazione, push.
import { db, enqueue, deviceId, uuid, pendingCount } from "./db.js";

const CFG = window.DIASTOCK_CONFIG || {};
export const configured = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
export const sb = configured
  ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
  : null;

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev) { listeners.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } }); }

export const state = { syncing: false, lastError: null };

// ------------------------------------------------------------------
// Profilo / sessione Operatore
// ------------------------------------------------------------------
export async function currentProfile() { return db.getMeta("profile"); }

export async function signInPin(nome, pin) {
  if (!configured) {
    return createLocalProfile(nome, pin);
  }
  const cleanName = String(nome).trim();
  const cleanPin = String(pin).trim();

  const { data, error } = await sb
    .from("operatori")
    .select("*")
    .ilike("nome", cleanName)
    .eq("pin", cleanPin)
    .eq("attivo", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Nome o PIN errati, oppure operatore non abilitato");

  await db.setMeta("profile", data);
  return data;
}

export async function signUpPin(nome, pin, ruolo = "operatore") {
  if (!configured) {
    return createLocalProfile(nome, pin);
  }
  const cleanPin = String(pin).trim();
  if (!/^[0-9]{4}$/.test(cleanPin)) {
    throw new Error("Il PIN deve essere esattamente di 4 cifre numeriche (es. 1234)");
  }

  const { data, error } = await sb.from("operatori").insert({
    nome: nome.trim(),
    pin: cleanPin,
    ruolo: ruolo,
    attivo: true
  }).select("*").single();

  if (error) {
    if (error.code === "23505") throw new Error("Esiste già un operatore con questo nome");
    throw error;
  }

  await db.setMeta("profile", data);
  return data;
}

export async function getOperatoriList() {
  if (configured && navigator.onLine) {
    const { data } = await sb.from("operatori").select("id, nome, ruolo, attivo").order("nome");
    if (data && data.length) {
      await db.bulkPut("profili", data);
      return data;
    }
  }
  const cached = await db.all("profili");
  return cached.sort((a, b) => a.nome.localeCompare(b.nome));
}

export async function refreshProfile() {
  const prof = await currentProfile();
  if (!configured || !prof || prof.locale || !navigator.onLine) return prof;
  try {
    const { data } = await sb.from("operatori").select("*").eq("id", prof.id).maybeSingle();
    if (data) {
      await db.setMeta("profile", data);
      return data;
    }
    return prof;
  } catch {
    return prof;
  }
}

export async function createLocalProfile(nome, pin = "1234") {
  const prof = { id: uuid(), nome, pin, ruolo: "master", attivo: true, locale: true };
  await db.setMeta("profile", prof);
  return prof;
}

export async function signOut() {
  await db.setMeta("profile", null);
}

// ------------------------------------------------------------------
// Registro attività: ogni operazione è abbinata all'operatore
// ------------------------------------------------------------------
export async function audit(azione, entita, entita_id, dettagli = {}) {
  const prof = await currentProfile();
  if (!prof) return;
  await enqueue("audit", null, {
    id: uuid(), operatore_id: prof.id, device_id: await deviceId(),
    azione, entita, entita_id: entita_id ? String(entita_id) : null, dettagli,
    eseguito_at: new Date().toISOString(),
  });
  emit({ type: "queue" });
}

// ------------------------------------------------------------------
// Sincronizzazione
// ------------------------------------------------------------------
function isNetworkError(e) {
  const m = String(e?.message || e || "");
  return !navigator.onLine || /fetch|network|Failed to fetch|Load failed|timeout/i.test(m);
}

async function pushOutbox() {
  const items = (await db.all("outbox")).sort((a, b) => a.seq - b.seq);
  for (const it of items) {
    if (it.tipo === "materiale") {
      const m = await db.get("materiali", it.ref);
      if (m) {
        const { error } = await sb.from("materiali").upsert({
          id: m.id,
          barcode: m.barcode,
          nome: m.nome,
          categoria: m.categoria || "",
          pezzi_per_scatola: Math.max(1, m.pezzi_per_scatola || 1),
          scorta_minima: Math.max(0, m.scorta_minima || 0),
          attivo: m.attivo !== false,
          created_by: m.created_by,
          updated_by: m.updated_by,
          updated_at: m.updated_at || new Date().toISOString()
        }, { onConflict: "id" });
        if (error) throw error;
      }
    } else if (it.tipo === "inventario") {
      const inv = await db.get("inventari", it.ref);
      if (inv && inv.stato === "chiuso" && !inv.synced) {
        const righe = await db.byIndex("righe", "inventario_id", inv.id);

        // Se non ha ancora il numero progressivo definitivo, lo leggiamo dal conteggio attuale
        let num = inv.numero;
        if (!num) {
          const { count } = await sb.from("inventari").select("*", { count: "exact", head: true });
          num = (count || 0) + 1;
        }

        const { error: errInv } = await sb.from("inventari").upsert({
          id: inv.id,
          numero: num,
          operatore_id: inv.operatore_id,
          operatore_nome: inv.operatore_nome || "",
          device_id: inv.device_id,
          note: inv.note || "",
          iniziato_at: inv.iniziato_at,
          chiuso_at: inv.chiuso_at,
          synced_at: new Date().toISOString()
        }, { onConflict: "id" });
        if (errInv) throw errInv;

        if (righe.length) {
          const righePayload = righe.map(r => ({
            id: r.id,
            inventario_id: inv.id,
            materiale_id: r.materiale_id,
            scatole: Math.max(0, r.scatole || 0),
            pezzi_per_scatola: Math.max(1, r.pezzi_per_scatola || 1),
            esito: r.esito,
            motivo: r.motivo || "",
            operatore_id: inv.operatore_id,
            rilevato_at: r.rilevato_at || new Date().toISOString()
          }));
          const { error: errRighe } = await sb.from("righe_inventario").upsert(righePayload, { onConflict: "id" });
          if (errRighe) throw errRighe;
        }

        // Notifica inventario
        await sb.from("notifiche").insert({
          tipo: "inventario",
          destinatari: "tutti",
          titolo: `Inventario n. ${num}`,
          testo: `Compilato da ${inv.operatore_nome || "Operatore"} il ${new Date(inv.chiuso_at).toLocaleString("it-IT")}`,
          inventario_id: inv.id,
          operatore_id: inv.operatore_id
        });

        inv.numero = num;
        inv.synced = true;
        await db.put("inventari", inv);
      }
    } else if (it.tipo === "audit") {
      const { error } = await sb.from("audit_log").upsert(it.payload, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
    }
    await db.del("outbox", it.seq);
  }
}

async function remapMateriale(oldId, newId) {
  const righe = await db.byIndex("righe", "materiale_id", oldId);
  for (const r of righe) { r.materiale_id = newId; await db.put("righe", r); }
  const m = await db.get("materiali", oldId);
  await db.del("materiali", oldId);
  if (m) await db.put("materiali", { ...m, id: newId });
}

async function fetchAll(query) {
  const out = []; const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await query().range(from, from + step - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < step) break;
  }
  return out;
}

async function pull(prof) {
  // materiali
  const mats = await fetchAll(() => sb.from("materiali").select("*").order("nome"));
  if ((await pendingCount()) === 0) await db.clear("materiali");
  await db.bulkPut("materiali", mats);

  // ultimi inventari con righe: conserviamo fino a un massimo di 50 inventari per PDF/storico
  const { data: invs, error: e1 } = await sb.from("inventari").select("*")
    .order("chiuso_at", { ascending: false }).limit(50);
  if (e1) throw e1;
  const ids = invs.map((i) => i.id);
  if (ids.length) {
    const righe = await fetchAll(() => sb.from("righe_inventario").select("*").in("inventario_id", ids).order("id"));
    await db.clear("righe");
    await db.bulkPut("righe", righe);
  }
  await db.clear("inventari");
  await db.bulkPut("inventari", invs.map((i) => ({ ...i, stato: "chiuso", synced: true })));

  // pulizia audit log: limitiamo agli ultimi 20 inventari (elimina annotazioni più vecchie)
  if (prof.ruolo === "master" && invs.length >= 20) {
    const cutoffInv = invs[19];
    const cutoffDate = cutoffInv?.chiuso_at || cutoffInv?.iniziato_at;
    if (cutoffDate) {
      try {
        await sb.from("audit_log").delete().lt("eseguito_at", cutoffDate);
      } catch (err) {
        console.warn("Pulizia automatica audit log:", err);
      }
    }
  }

  // notifiche
  const before = new Set((await db.all("notifiche")).map((n) => n.id));
  const { data: notif, error: e2 } = await sb.from("notifiche").select("*")
    .order("created_at", { ascending: false }).limit(150);
  if (e2) throw e2;
  await db.clear("notifiche");
  await db.bulkPut("notifiche", notif);
  const nuove = before.size ? notif.filter((n) => !before.has(n.id)) : [];

  // operatori per elenco rapido
  const { data: ops } = await sb.from("operatori").select("id, nome, ruolo, attivo").order("nome");
  if (ops) { await db.clear("profili"); await db.bulkPut("profili", ops); }

  return nuove;
}

export async function deleteMaterialeCompleto(materialeId) {
  // 1. Elimina prima da Supabase (righe_inventario, notifiche e materiali)
  if (configured && navigator.onLine) {
    try {
      await sb.from("righe_inventario").delete().eq("materiale_id", materialeId);
      await sb.from("notifiche").delete().eq("materiale_id", materialeId);
      const { error } = await sb.from("materiali").delete().eq("id", materialeId);
      if (error) console.error("Errore eliminazione Supabase:", error);
    } catch (e) {
      console.warn("Errore eliminazione cloud:", e);
    }
  }
  // 2. Elimina da IndexedDB locale
  const righe = await db.byIndex("righe", "materiale_id", materialeId);
  for (const r of righe) await db.del("righe", r.id);
  await db.del("materiali", materialeId);

  // 3. Rimuovi dall'outbox locale eventuali modifiche in sospeso per questo materiale
  const outbox = await db.all("outbox");
  for (const item of outbox) {
    if (item.ref === materialeId) await db.del("outbox", item.seq);
  }
}

export async function cleanOldAuditLogs() {
  if (!configured || !navigator.onLine) return false;
  const { data: invs } = await sb.from("inventari").select("chiuso_at, iniziato_at")
    .order("chiuso_at", { ascending: false }).limit(20);
  if (!invs || invs.length < 20) return false;
  const cutoff = invs[19].chiuso_at || invs[19].iniziato_at;
  const { error } = await sb.from("audit_log").delete().lt("eseguito_at", cutoff);
  if (error) throw error;
  return true;
}

export async function sync({ silent = false } = {}) {
  const prof = await currentProfile();
  if (!configured || !prof || prof.locale || state.syncing || !navigator.onLine) return;
  state.syncing = true; emit({ type: "sync-start" });
  try {
    const fresh = await refreshProfile();
    if (!fresh?.attivo) throw new Error("Operatore non abilitato dal master");
    await pushOutbox();
    const nuove = await pull(fresh);
    await db.setMeta("last_sync", new Date().toISOString());
    state.lastError = null;
    if (nuove.length) await showLocalNotifications(nuove);
    emit({ type: "sync-done", nuove, silent });
  } catch (e) {
    state.lastError = isNetworkError(e) ? "Connessione assente" : (e.message || String(e));
    console.warn("sync", e);
    emit({ type: "sync-error", error: state.lastError, silent });
  } finally {
    state.syncing = false; emit({ type: "sync-end" });
  }
}

let timer;
export function startAutoSync() {
  window.addEventListener("online", () => sync({ silent: true }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync({ silent: true }); });
  clearInterval(timer);
  timer = setInterval(() => sync({ silent: true }), 60_000);
  sync({ silent: true });
}

// ------------------------------------------------------------------
// Notifiche locali e push
// ------------------------------------------------------------------
async function showLocalNotifications(list) {
  if (await db.getMeta("push_enabled")) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker?.getRegistration();
  for (const n of list.slice(0, 5)) {
    const opts = { body: n.testo, tag: n.id, icon: "icons/icon-192.png", data: { url: `./#notifiche/${n.id}` } };
    if (reg) reg.showNotification(n.titolo, opts); else new Notification(n.titolo, opts);
  }
}

function b64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export const pushAvailable = () =>
  "serviceWorker" in navigator && "PushManager" in window && !!CFG.VAPID_PUBLIC_KEY && configured;

export async function enableNotifications() {
  if (!("Notification" in window)) throw new Error("Notifiche non supportate. Su iPhone installa prima l'app nella schermata Home.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Permesso notifiche negato");
  if (!pushAvailable()) return "locali";
  const prof = await currentProfile();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(CFG.VAPID_PUBLIC_KEY) });
  const json = sub.toJSON();
  const { error } = await sb.from("push_subscriptions").upsert({ endpoint: json.endpoint, user_id: prof.id, subscription: json });
  if (error) throw error;
  await db.setMeta("push_enabled", true);
  return "push";
}
