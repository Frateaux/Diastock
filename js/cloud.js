// Collegamento a Supabase: autenticazione, sincronizzazione, push.
import { db, enqueue, deviceId, uuid, pendingCount } from "./db.js";

const CFG = window.DIASTOCK_CONFIG || {};
export const configured = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
export const sb = configured
  ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "diastock-auth" },
    })
  : null;

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev) { listeners.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } }); }

export const state = { syncing: false, lastError: null };

// ------------------------------------------------------------------
// Profilo / sessione
// ------------------------------------------------------------------
export async function currentProfile() { return db.getMeta("profile"); }

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return loadProfile(data.user.id);
}

export async function signUp(email, password, nome) {
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { nome } } });
  if (error) throw error;
  if (!data.session) return null; // conferma email richiesta
  return loadProfile(data.user.id);
}

async function loadProfile(uid) {
  const { data, error } = await sb.from("profiles").select("*").eq("id", uid).single();
  if (error) throw error;
  await db.setMeta("profile", data);
  return data;
}

export async function refreshProfile() {
  const prof = await currentProfile();
  if (!configured || !prof || prof.locale || !navigator.onLine) return prof;
  try { return await loadProfile(prof.id); } catch { return prof; }
}

export async function createLocalProfile(nome) {
  const prof = { id: uuid(), email: "", nome, ruolo: "master", attivo: true, locale: true };
  await db.setMeta("profile", prof);
  return prof;
}

export async function signOut() {
  if (sb) { try { await sb.auth.signOut(); } catch { /* offline */ } }
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
        const { data: newId, error } = await sb.rpc("sync_materiale", { p: m });
        if (error) throw error;
        if (newId && newId !== m.id) await remapMateriale(m.id, newId);
      }
    } else if (it.tipo === "inventario") {
      const inv = await db.get("inventari", it.ref);
      if (inv && inv.stato === "chiuso" && !inv.synced) {
        const righe = await db.byIndex("righe", "inventario_id", inv.id);
        const payload = { ...inv, device_id: inv.device_id, righe };
        const { data: numero, error } = await sb.rpc("sync_inventario", { p: payload });
        if (error) throw error;
        inv.numero = numero; inv.synced = true;
        await db.put("inventari", inv);
      }
    } else if (it.tipo === "audit") {
      const { error } = await sb.from("audit_log").upsert(it.payload, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
    }
    await db.del("outbox", it.seq);
  }
}

// Due operatori hanno censito offline lo stesso barcode: si usa l'id del server.
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

  // ultimi inventari con righe
  const { data: invs, error: e1 } = await sb.from("inventari").select("*")
    .order("chiuso_at", { ascending: false }).limit(30);
  if (e1) throw e1;
  const ids = invs.map((i) => i.id);
  if (ids.length) {
    const righe = await fetchAll(() => sb.from("righe_inventario").select("*").in("inventario_id", ids).order("id"));
    await db.bulkPut("righe", righe);
  }
  await db.bulkPut("inventari", invs.map((i) => ({ ...i, stato: "chiuso", synced: true })));

  // notifiche
  const before = new Set((await db.all("notifiche")).map((n) => n.id));
  const { data: notif, error: e2 } = await sb.from("notifiche").select("*")
    .order("created_at", { ascending: false }).limit(150);
  if (e2) throw e2;
  await db.clear("notifiche");
  await db.bulkPut("notifiche", notif);
  const nuove = before.size ? notif.filter((n) => !before.has(n.id)) : [];

  // operatori (tutti li vedono per i nomi; il master li gestisce)
  const { data: profs } = await sb.from("profiles").select("*").order("nome");
  if (profs) { await db.clear("profili"); await db.bulkPut("profili", profs); }

  return nuove;
}

export async function sync({ silent = false } = {}) {
  const prof = await currentProfile();
  if (!configured || !prof || prof.locale || state.syncing || !navigator.onLine) return;
  state.syncing = true; emit({ type: "sync-start" });
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("Sessione scaduta: effettua di nuovo l'accesso");
    const fresh = await refreshProfile();
    if (!fresh?.attivo) throw new Error("Utente non ancora abilitato dal master");
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
  // Se le push sono attive, sarà il server a notificare.
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
