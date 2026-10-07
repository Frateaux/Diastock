// Diastock – interfaccia principale
import { db, uuid, enqueue, deviceId, pendingCount } from "./db.js";
import * as cloud from "./cloud.js";
import { startScanner, stopScanner, toggleTorch, isTorchOn } from "./scanner.js";
import * as pdf from "./pdf.js";

// ------------------------------------------------------------------
// Utilità UI
// ------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDT = (s) => s ? new Date(s).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "";
const nowISO = () => new Date().toISOString();
const view = $("#view");
const dlg = $("#dialog");

let ME = null;               // profilo operatore corrente
let scanPaused = false;      // ignora letture mentre è aperta una finestra

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
}

function openDialog(html) {
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  return dlg;
}
function closeDialog() { if (dlg.open) dlg.close(); dlg.innerHTML = ""; }

function confirmDialog(text, okLabel = "Conferma", danger = false) {
  return new Promise((resolve) => {
    openDialog(`<form method="dialog" class="dlg">
      <p>${text}</p>
      <div class="row end"><button value="no" class="btn ghost">Annulla</button>
      <button value="ok" class="btn ${danger ? "danger" : "primary"}">${esc(okLabel)}</button></div></form>`);
    dlg.onclose = () => { dlg.onclose = null; resolve(dlg.returnValue === "ok"); };
  });
}

// fields: [{name,label,type,value,required,min,step,placeholder,options,help}]
function formDialog({ title, fields, submit = "Salva", intro = "" }) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) => {
      const id = `f_${f.name}`;
      if (f.type === "select") {
        return `<label for="${id}">${esc(f.label)}</label><select id="${id}" name="${f.name}">
          ${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value == f.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
      }
      if (f.type === "checkbox") {
        return `<label class="check"><input type="checkbox" id="${id}" name="${f.name}" ${f.value ? "checked" : ""}> ${esc(f.label)}</label>`;
      }
      return `<label for="${id}">${esc(f.label)}</label>
        <input id="${id}" name="${f.name}" type="${f.type || "text"}" value="${esc(f.value ?? "")}"
          ${f.required ? "required" : ""} ${f.min != null ? `min="${f.min}"` : ""} ${f.step ? `step="${f.step}"` : ""}
          ${f.type === "number" ? 'inputmode="numeric"' : ""} placeholder="${esc(f.placeholder || "")}" ${f.readonly ? "readonly" : ""} autocomplete="off">
        ${f.help ? `<small class="muted">${esc(f.help)}</small>` : ""}`;
    }).join("");
    openDialog(`<form class="dlg" id="fd">
      <h2>${esc(title)}</h2>${intro}${inputs}
      <div class="row end"><button type="button" class="btn ghost" id="fdCancel">Annulla</button>
      <button class="btn primary">${esc(submit)}</button></div></form>`);
    const form = $("#fd");
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.onclose = null; closeDialog(); resolve(v); };
    $("#fdCancel").onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      fields.forEach((f) => {
        const el = form.elements[f.name];
        out[f.name] = f.type === "checkbox" ? el.checked : f.type === "number" ? Number(el.value) : el.value.trim();
      });
      finish(out);
    };
    setTimeout(() => form.querySelector("input:not([readonly]),select")?.focus(), 50);
  });
}

// Scansione singola in finestra (per cercare o censire un materiale)
function scanOnce() {
  return new Promise((resolve) => {
    openDialog(`<div class="dlg"><h2>Inquadra il barcode</h2>
      <div class="reader-wrap" id="readerOnceWrap">
        <div id="readerOnce" class="reader"></div>
        <div class="scan-laser"></div>
      </div>
      <div class="row end"><button class="btn ghost" id="soClose">Chiudi</button></div></div>`);
    let done = false;
    const finish = async (v) => { if (done) return; done = true; dlg.onclose = null; await stopScanner(); closeDialog(); resolve(v); };
    $("#soClose").onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    startScanner("readerOnce", (code) => finish(code)).catch((e) => { toast("Fotocamera non disponibile: " + e); finish(null); });
  });
}

// ------------------------------------------------------------------
// Dati locali
// ------------------------------------------------------------------
async function materiali({ soloAttivi = true } = {}) {
  const all = await db.all("materiali");
  return all.filter((m) => !soloAttivi || m.attivo !== false).sort((a, b) => a.nome.localeCompare(b.nome));
}
async function materialeByBarcode(code) {
  const list = await db.byIndex("materiali", "barcode", code);
  return list[0] || null;
}
async function inventarioInCorso() {
  return (await db.all("inventari")).find((i) => i.stato === "in_corso" && i.operatore_id === ME.id) || null;
}
async function inventariChiusi() {
  return (await db.all("inventari")).filter((i) => i.stato === "chiuso")
    .sort((a, b) => (b.chiuso_at || "").localeCompare(a.chiuso_at || ""));
}

// Giacenza attuale = ultima rilevazione valida (non "non necessario") di ogni materiale
async function calcolaGiacenze() {
  const [mats, invs, righe] = await Promise.all([materiali(), inventariChiusi(), db.all("righe")]);
  const invMap = new Map(invs.map((i) => [i.id, i]));
  const ultima = new Map();
  for (const r of righe) {
    const inv = invMap.get(r.inventario_id);
    if (!inv || r.esito === "non_necessario") continue;
    const prev = ultima.get(r.materiale_id);
    if (!prev || inv.chiuso_at > prev.inv.chiuso_at) ultima.set(r.materiale_id, { r, inv });
  }
  return mats.map((m) => {
    const u = ultima.get(m.id);
    const scatole = u ? u.r.scatole : null;
    return {
      ...m, scatole, totale: u ? u.r.scatole * u.r.pezzi_per_scatola : null,
      rilevato_il: u?.inv.chiuso_at, inventario_numero: u?.inv.numero,
      sotto: m.scorta_minima > 0 && (scatole ?? 0) < m.scorta_minima,
    };
  });
}

async function salvaMateriale(m, azione) {
  m.updated_at = nowISO();
  m.updated_by = ME.id;
  await db.put("materiali", m);
  await enqueue("materiale", m.id);
  await cloud.audit(azione, "materiale", m.id, { barcode: m.barcode, nome: m.nome, pezzi_per_scatola: m.pezzi_per_scatola, scorta_minima: m.scorta_minima });
}

async function nuovoMaterialeDialog(barcode = "") {
  const fields = [
    { name: "barcode", label: "Codice a barre", value: barcode, required: true, readonly: !!barcode },
    { name: "nome", label: "Nome materiale", required: true, placeholder: "es. Filtro dializzatore FX80" },
    { name: "categoria", label: "Categoria", placeholder: "es. Filtri, Linee, Aghi, Concentrati…" },
    { name: "pezzi_per_scatola", label: "Pezzi contenuti in ogni scatola", type: "number", min: 1, value: 1, required: true },
  ];
  if (ME.ruolo === "master") fields.push({ name: "scorta_minima", label: "Scorta minima (scatole)", type: "number", min: 0, value: 0 });
  const v = await formDialog({
    title: "Nuovo materiale", fields, submit: "Salva in archivio",
    intro: barcode ? `<p class="muted">Barcode non presente in archivio: inserisci i dati la prima volta.</p>` : "",
  });
  if (!v) return null;
  if (await materialeByBarcode(v.barcode)) { toast("Barcode già presente in archivio"); return materialeByBarcode(v.barcode); }
  const m = {
    id: uuid(), barcode: v.barcode, nome: v.nome, categoria: v.categoria || "",
    pezzi_per_scatola: Math.max(1, v.pezzi_per_scatola | 0), scorta_minima: Math.max(0, (v.scorta_minima || 0) | 0),
    attivo: true, created_by: ME.id, created_at: nowISO(),
  };
  await salvaMateriale(m, "materiale_creato");
  toast("Materiale salvato in archivio");
  return m;
}

// ------------------------------------------------------------------
// Barra di stato
// ------------------------------------------------------------------
async function updateStatus() {
  const pend = await pendingCount();
  const s = $("#status");
  const online = navigator.onLine;
  let txt, cls;
  if (cloud.state.syncing) { txt = "⟳ sincronizzo…"; cls = "sync"; }
  else if (ME?.locale) { txt = "modalità locale"; cls = "local"; }
  else if (!online) { txt = `offline${pend ? ` · ${pend} in coda` : ""}`; cls = "off"; }
  else if (pend) { txt = `${pend} in coda`; cls = "sync"; }
  else { txt = "online"; cls = "on"; }
  s.textContent = txt; s.className = `badge ${cls}`;
  const lette = new Set(await db.getMeta("notif_lette", []));
  const unread = (await db.all("notifiche")).filter((n) => !lette.has(n.id)).length;
  const b = $("#notifBadge"); b.textContent = unread; b.classList.toggle("hidden", !unread);
}

// ------------------------------------------------------------------
// Router
// ------------------------------------------------------------------
const routes = {};
let currentRoute = "";

async function render() {
  await stopScanner();
  scanPaused = false;
  closeDialog();
  document.querySelector("main")?.classList.remove("with-thumb");
  const [name, arg] = (location.hash.slice(1) || "home").split("/");
  currentRoute = name;
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === (TAB_OF[name] || name)));
  const r = routes[name] || routes.home;
  $("#btnBack").classList.toggle("hidden", !BACK_OF[name]);
  try { await r(arg); } catch (e) { console.error(e); view.innerHTML = `<div class="card error">Errore: ${esc(e.message)}</div>`; }
  updateStatus();
}
const TAB_OF = { inventario: "home", storico: "menu", inv: "menu", audit: "menu", operatori: "menu", impostazioni: "menu", materiale: "materiali" };
const BACK_OF = { storico: "menu", inv: "storico", audit: "menu", operatori: "menu", impostazioni: "menu", materiale: "materiali" };
const go = (h) => { if (location.hash === `#${h}`) render(); else location.hash = h; };
const setTitle = (t) => { $("#title").textContent = t; };

// ------------------------------------------------------------------
// HOME
// ------------------------------------------------------------------
routes.home = async () => {
  setTitle("Diastock");
  const [inCorso, chiusi, giac, pend, last] = await Promise.all([
    inventarioInCorso(), inventariChiusi(), calcolaGiacenze(), pendingCount(), db.getMeta("last_sync"),
  ]);
  const sotto = giac.filter((g) => g.sotto);
  const ultimo = chiusi[0];
  view.innerHTML = `
    <div class="card hello">
      <div class="row between">
        <div>
          <b>${esc(ME.nome)}</b> <span class="pill ${ME.ruolo}">${ME.ruolo === "master" ? "Master" : "Operatore"}</span>
        </div>
        <button class="btn small ghost" id="switchUser">🔄 Cambia operatore</button>
      </div>
      <small class="muted">${ME.locale ? "Modalità locale (nessuna sincronizzazione)" :
        `Ultima sincronizzazione: ${last ? fmtDT(last) : "mai"}${pend ? ` · ${pend} operazioni in attesa` : ""}`}</small>
    </div>
    ${inCorso ? `
      <button class="bigbtn warn" id="goInv">▶ Riprendi inventario<br><small>iniziato ${fmtDT(inCorso.iniziato_at)}</small></button>`
    : `<button class="bigbtn" id="newInv">📦 Nuovo inventario</button>`}
    <div class="grid2">
      <a class="tile" href="#giacenze"><b>${giac.length}</b><span>materiali in archivio</span></a>
      <a class="tile ${sotto.length ? "alert" : ""}" href="#giacenze/sotto"><b>${sotto.length}</b><span>sotto scorta</span></a>
    </div>
    ${ultimo ? `<a class="card link" href="#inv/${ultimo.id}">
        <small class="muted">Ultimo inventario</small>
        <div><b>${ultimo.numero ? `n. ${ultimo.numero}` : "in attesa di numero"}</b> · ${fmtDT(ultimo.chiuso_at)}</div>
        <small>${esc(ultimo.operatore_nome)}${ultimo.synced ? "" : " · ⏳ da sincronizzare"}</small></a>` : ""}
    ${ME.ruolo === "master" && sotto.length ? `<div class="card"><h3>⚠ Sotto scorta</h3>
        ${sotto.slice(0, 8).map((g) => `<div class="li"><span>${esc(g.nome)}</span><b class="red">${g.scatole ?? 0}/${g.scorta_minima}</b></div>`).join("")}</div>` : ""}
    ${!ME.locale ? `<button class="btn block ghost" id="syncNow">⟳ Sincronizza ora</button>` : ""}`;
  $("#switchUser") && ($("#switchUser").onclick = async () => {
    await cloud.signOut();
    location.hash = "";
    boot();
  });
  $("#goInv") && ($("#goInv").onclick = () => go("inventario"));
  $("#newInv") && ($("#newInv").onclick = nuovoInventario);
  $("#syncNow") && ($("#syncNow").onclick = () => { if (!navigator.onLine) toast("Nessuna connessione: i dati restano salvati sul telefono"); cloud.sync(); });
};

async function nuovoInventario() {
  const inv = {
    id: uuid(), numero: null, stato: "in_corso", synced: false,
    operatore_id: ME.id, operatore_nome: ME.nome, device_id: await deviceId(),
    iniziato_at: nowISO(), chiuso_at: null, note: "",
  };
  await db.put("inventari", inv);
  await cloud.audit("inventario_iniziato", "inventario", inv.id);
  go("inventario");
}

// ------------------------------------------------------------------
// INVENTARIO IN CORSO
// ------------------------------------------------------------------
let invState = { verifying: false, cameraOn: false };

routes.inventario = async () => {
  setTitle("Inventario");
  const inv = await inventarioInCorso();
  if (!inv) { go("home"); return; }
  invState.cameraOn = false;
  invState.verifying = false;
  await renderInventario(inv);
};

async function righeInv(inv) { return db.byIndex("righe", "inventario_id", inv.id); }

let lastScannedItem = null;

async function renderInventario(inv) {
  const [righe, mats] = await Promise.all([righeInv(inv), materiali()]);
  const matMap = new Map((await db.all("materiali")).map((m) => [m.id, m]));
  const presenti = new Set(righe.map((r) => r.materiale_id));
  const mancanti = mats.filter((m) => !presenti.has(m.id));
  const rilevate = righe.filter((r) => r.esito !== "non_necessario");
  const nn = righe.filter((r) => r.esito === "non_necessario");
  const totScatole = rilevate.reduce((acc, r) => acc + (r.scatole || 0), 0);
  const totPezzi = rilevate.reduce((acc, r) => acc + ((r.scatole || 0) * (r.pezzi_per_scatola || 1)), 0);
  const scanMode = await db.getMeta("scan_mode", "piu1");

  const rigaHtml = (r) => {
    const m = matMap.get(r.materiale_id) || { nome: "?", barcode: "" };
    const pzTot = (r.scatole || 0) * (r.pezzi_per_scatola || 1);
    return `<div class="line" data-id="${r.id}">
      <div class="info">
        <b>${esc(m.nome)}</b>
        <small>${esc(m.barcode)} · ${r.pezzi_per_scatola} pz/sc · <b style="color:var(--primary-hover);">${pzTot} pz</b></small>
        <small class="muted">${r.esito === "manuale" ? "✍ manuale" : "📷 scansionato"}</small>
      </div>
      <div class="row">
        <div class="qty"><button class="q" data-act="minus">−</button><span data-act="edit">${r.scatole}</span><button class="q" data-act="plus">+</button></div>
        <button class="btn small danger ghost" data-act="del" title="Elimina scansione">🗑</button>
      </div>
    </div>`;
  };

  if (invState.verifying) {
    // -------------------------------------------------------------
    // MODALITÀ VERIFICA E REVISIONE MANUALE (PRIMA DI CHIUDERE)
    // -------------------------------------------------------------
    document.querySelector("main")?.classList.remove("with-thumb");

    view.innerHTML = `
      <div class="card hello">
        <div class="row between">
          <div>
            <h2 style="margin:0;font-size:1.25rem;">📋 Verifica e Revisione Inventario</h2>
            <small class="muted">Iniziato ${fmtDT(inv.iniziato_at)} · ${esc(inv.operatore_nome)}</small>
          </div>
          <span class="pill master">Revisione obbligatoria</span>
        </div>
        <p style="margin:6px 0 0 0;font-size:0.9rem;">
          Controlla tutte le quantità rilevate prima della chiusura definitiva. Se hai dubbi su qualsiasi prodotto, puoi modificare le scatole con i tasti <b>+</b> / <b>−</b> o toccare il numero per digitare il valore esatto.
        </p>
      </div>

      <div class="verify-stats">
        <div class="stat-box"><b>${rilevate.length}</b><span>Materiali rilevati</span></div>
        <div class="stat-box"><b>${totScatole}</b><span>Scatole totali</span></div>
        <div class="stat-box"><b>${totPezzi}</b><span>Pezzi totali</span></div>
      </div>

      ${mancanti.length ? `
        <div class="card alert">
          <div class="row between">
            <b>⚠ ${mancanti.length} materiali in archivio non rilevati</b>
            <button class="btn small ghost" id="allNN">Segna tutti "non necessario"</button>
          </div>
          <p class="muted" style="margin:2px 0 6px 0;font-size:0.85rem;">
            Questi materiali risultano in catalogo ma non sono stati contati. Puoi rilevarli ora oppure segnarli come non necessari.
          </p>
          ${mancanti.map((m) => `<div class="miss" data-mid="${m.id}">
              <div><b>${esc(m.nome)}</b><small class="muted"> ${esc(m.categoria || "")} · ${esc(m.barcode)}</small></div>
              <div class="row wrap">
                <button class="btn small" data-act="scan">📷 Scansiona</button>
                <button class="btn small" data-act="man">✍ A mano</button>
                <button class="btn small ghost" data-act="nn">Non necessario</button>
              </div></div>`).join("")}
        </div>` : ""}

      <h3 class="sec" style="margin-top:4px;">Elenco completo rilevazioni (${rilevate.length})</h3>
      <div class="card list">
        ${rilevate.length ? rilevate.sort((a, b) => (matMap.get(a.materiale_id)?.nome || "").localeCompare(matMap.get(b.materiale_id)?.nome || "")).map(rigaHtml).join("") : `<p class="muted" style="padding:12px;">Nessun materiale rilevato finora.</p>`}
      </div>

      ${nn.length ? `
        <h3 class="sec">Segnati come non necessari (${nn.length})</h3>
        <div class="card list">
          ${nn.map((r) => `<div class="line" data-id="${r.id}"><div class="info"><b>${esc(matMap.get(r.materiale_id)?.nome)}</b>
            <small>${esc(r.motivo || "Non necessario")}</small></div><button class="btn small ghost" data-act="undo">Ripristina</button></div>`).join("")}
        </div>` : ""}

      <div class="card">
        <label for="revNotes">Note inventario (facoltative):</label>
        <textarea id="revNotes" rows="2" placeholder="Annotazioni dell'operatore, differenze riscontrate, note di reparto...">${esc(inv.note || "")}</textarea>
      </div>

      <div class="sticky">
        <button class="bigbtn" style="background:#059669;box-shadow:0 4px 12px rgba(5,150,105,0.35);" id="confermaChiusura">
          ✔ Conferma verifica e Chiudi definitivamente
        </button>
        <button class="btn ghost block" id="tornaScansione">
          ↩ Torna alla scansione (continua inventario)
        </button>
      </div>
    `;
  } else {
    // -------------------------------------------------------------
    // MODALITÀ CONTEGGIO / SCANSIONE ATTIVA
    // -------------------------------------------------------------
    document.querySelector("main")?.classList.add("with-thumb");

    view.innerHTML = `
      <div class="card">
        <div class="row between"><small class="muted">Iniziato ${fmtDT(inv.iniziato_at)} · ${esc(inv.operatore_nome)}</small>
          <button class="btn small ghost" id="annulla">Annulla inventario</button></div>
        
        <div class="reader-wrap ${invState.cameraOn ? "" : "hidden"}" id="readerWrap">
          <div id="reader" class="reader"></div>
          <div class="scan-laser"></div>
        </div>

        <div class="row">
          <button class="btn primary grow" id="cam">${invState.cameraOn ? "■ Ferma fotocamera" : "📷 Scansiona scatola"}</button>
          <button class="btn ${invState.cameraOn ? "" : "hidden"} ${isTorchOn() ? "torch-active" : ""}" id="torch">${isTorchOn() ? "🔦 Torcia: ON" : "🔦 Torcia"}</button>
          <button class="btn" id="manual">⌨ Codice</button>
        </div>
        ${invState.cameraOn ? `<small class="muted center" style="display:block;margin-top:2px;">Allinea la riga rossa sul codice a barre. Si ferma da sola appena letto.</small>` : ""}
        <label class="check small"><input type="checkbox" id="askQty" ${scanMode === "chiedi" ? "checked" : ""}> Chiedi il numero di scatole a ogni scansione (altrimenti +1 per scansione)</label>
      </div>

      ${lastScannedItem ? `
        <div class="card ok scan-prompt-card">
          <div class="row between">
            <div>
              <small class="muted">Ultima scatola rilevata:</small>
              <div><b>${esc(lastScannedItem.nome)}</b> · <span class="pill">${lastScannedItem.scatole} scatole</span></div>
              <small class="muted">${esc(lastScannedItem.barcode)}</small>
            </div>
            <button class="btn small primary" id="nextScan">📷 Prossima scatola</button>
          </div>
        </div>` : ""}

      <div class="row between" style="margin-top:6px;">
        <h3 class="sec" style="margin:0;">Rilevati finora (${rilevate.length})</h3>
        <button class="btn small ghost" id="topVerify">📋 Verifica (${rilevate.length})</button>
      </div>
      <div class="card list">
        ${rilevate.length ? rilevate.sort((a, b) => b.rilevato_at.localeCompare(a.rilevato_at)).map(rigaHtml).join("") : `<p class="muted" style="padding:12px;">Nessun materiale rilevato. Usa il pulsante in basso con il pollice per scansionare la prima scatola.</p>`}
      </div>

      ${nn.length ? `
        <h3 class="sec">Non necessari in questo inventario (${nn.length})</h3>
        <div class="card list">
          ${nn.map((r) => `<div class="line" data-id="${r.id}"><div class="info"><b>${esc(matMap.get(r.materiale_id)?.nome)}</b>
            <small>${esc(r.motivo || "")}</small></div><button class="btn small ghost" data-act="undo">Ripristina</button></div>`).join("")}
        </div>` : ""}

      <div style="margin-top:12px;">
        <button class="bigbtn" id="startVerify" style="background:var(--primary);box-shadow:0 4px 12px rgba(8,145,178,0.3);">
          📋 Verifica manuale prima di chiudere (${rilevate.length})
        </button>
      </div>

      <!-- BARRA POLLICE ERGONOMICA (fissata in basso a portata di pollice su smartphone) -->
      <div class="thumb-bar" id="thumbBar">
        ${lastScannedItem ? `<div class="thumb-last-pill">✔ Rilevato: <b>${esc(lastScannedItem.nome)}</b> (${lastScannedItem.scatole} sc)</div>` : ""}
        <div class="thumb-row">
          ${invState.cameraOn ? `
            <button class="btn thumb-scan-btn danger grow" id="thumbCamStop">■ Ferma fotocamera</button>
            <button class="btn thumb-btn ${isTorchOn() ? "torch-active" : ""}" id="thumbTorch" title="Torcia">🔦</button>
          ` : `
            <button class="btn primary thumb-scan-btn grow" id="thumbCam">
              ${lastScannedItem ? "📷 Prossima scatola" : "📷 Scansiona scatola"}
            </button>
            <button class="btn thumb-btn" id="thumbManual" title="Inserisci codice a mano">⌨</button>
            <button class="btn thumb-btn ghost" id="thumbVerify" title="Verifica e chiudi inventario">📋</button>
          `}
        </div>
      </div>
    `;
  }

  // --- eventi ---
  const refresh = async () => {
    const fresh = await db.get("inventari", inv.id);
    await renderInventario(fresh);
  };

  $("#askQty") && ($("#askQty").onchange = async (e) => { await db.setMeta("scan_mode", e.target.checked ? "chiedi" : "piu1"); });
  $("#nextScan") && ($("#nextScan").onclick = () => $("#cam").click());
  $("#topVerify") && ($("#topVerify").onclick = () => { invState.verifying = true; refresh(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("#startVerify") && ($("#startVerify").onclick = () => { invState.verifying = true; refresh(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("#thumbVerify") && ($("#thumbVerify").onclick = () => { invState.verifying = true; refresh(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("#tornaScansione") && ($("#tornaScansione").onclick = () => { invState.verifying = false; refresh(); });

  $("#thumbCam") && ($("#thumbCam").onclick = () => $("#cam").click());
  $("#thumbCamStop") && ($("#thumbCamStop").onclick = () => $("#cam").click());
  $("#thumbTorch") && ($("#thumbTorch").onclick = () => $("#torch").click());
  $("#thumbManual") && ($("#thumbManual").onclick = () => $("#manual").click());

  $("#torch") && ($("#torch").onclick = async () => {
    const on = await toggleTorch();
    $("#torch").textContent = on ? "🔦 Torcia: ON" : "🔦 Torcia";
    $("#torch").classList.toggle("torch-active", on);
    $("#thumbTorch") && $("#thumbTorch").classList.toggle("torch-active", on);
  });

  $("#cam") && ($("#cam").onclick = async () => {
    if (invState.cameraOn) {
      await stopScanner();
      invState.cameraOn = false;
      $("#readerWrap")?.classList.add("hidden");
      $("#torch")?.classList.add("hidden");
      $("#cam").textContent = "📷 Scansiona scatola";
      const thumbBtn = $("#thumbCamStop");
      if (thumbBtn) {
        thumbBtn.textContent = lastScannedItem ? "📷 Prossima scatola" : "📷 Scansiona scatola";
        thumbBtn.className = "btn primary thumb-scan-btn grow";
        thumbBtn.id = "thumbCam";
      }
      return;
    }
    invState.cameraOn = true;
    $("#readerWrap")?.classList.remove("hidden");
    $("#torch")?.classList.remove("hidden");
    $("#cam").textContent = "■ Ferma fotocamera";
    try {
      await startScanner("reader", (code) => onScan(inv, code));
    } catch (e) {
      invState.cameraOn = false;
      $("#readerWrap")?.classList.add("hidden");
      $("#torch")?.classList.add("hidden");
      $("#cam").textContent = "📷 Scansiona scatola";
      toast("Fotocamera non disponibile: " + (e.message || e));
    }
  });

  $("#manual") && ($("#manual").onclick = async () => {
    scanPaused = true;
    const v = await formDialog({ title: "Inserisci codice", fields: [{ name: "code", label: "Codice a barre (o lettore esterno)", required: true }], submit: "Avanti" });
    scanPaused = false;
    if (v?.code) await onScan(inv, v.code, true);
  });

  $("#annulla") && ($("#annulla").onclick = async () => {
    if (!(await confirmDialog("Annullare l'inventario in corso? Tutti i conteggi appena inseriti verranno eliminati.", "Annulla inventario", true))) return;
    for (const r of await righeInv(inv)) await db.del("righe", r.id);
    await db.del("inventari", inv.id);
    await cloud.audit("inventario_annullato", "inventario", inv.id);
    invState.verifying = false;
    lastScannedItem = null;
    document.querySelector("main")?.classList.remove("with-thumb");
    go("home");
  });

  $$(".line [data-act]", view).forEach((el) => el.onclick = async () => {
    const id = el.closest(".line").dataset.id;
    const r = await db.get("righe", id);
    const act = el.dataset.act;
    if (act === "plus") r.scatole++;
    else if (act === "minus") r.scatole = Math.max(0, r.scatole - 1);
    else if (act === "edit") {
      const m = matMap.get(r.materiale_id);
      const v = await qtyDialog(m, r.scatole);
      if (v == null) return;
      r.scatole = v;
    } else if (act === "undo") {
      await db.del("righe", r.id);
      await cloud.audit("riga_ripristinata", "inventario", inv.id, { materiale_id: r.materiale_id });
      return refresh();
    } else if (act === "del") {
      const m = matMap.get(r.materiale_id);
      if (!(await confirmDialog(`Rimuovere la rilevazione di "${m?.nome || "materiale"}"?`, "Rimuovi", true))) return;
      await db.del("righe", r.id);
      await cloud.audit("scansione_eliminata", "inventario", inv.id, {
        materiale_id: r.materiale_id,
        materiale_nome: m?.nome,
        barcode: m?.barcode,
        scatole: r.scatole,
        esito: r.esito
      });
      toast("Rilevazione rimossa");
      return refresh();
    }
    r.rilevato_at = nowISO(); r.operatore_id = ME.id;
    await db.put("righe", r);
    await cloud.audit("quantita_modificata", "inventario", inv.id, { materiale_id: r.materiale_id, scatole: r.scatole });
    refresh();
  });

  $$(".miss [data-act]", view).forEach((el) => el.onclick = async () => {
    const mid = el.closest(".miss").dataset.mid;
    const m = matMap.get(mid);
    const act = el.dataset.act;
    if (act === "scan") {
      invState.verifying = false;
      await renderInventario(inv);
      if (!invState.cameraOn) $("#cam").click();
      window.scrollTo({ top: 0, behavior: "smooth" });
      toast(`Inquadra la scatola di: ${m.nome}`);
    } else if (act === "man") {
      const v = await qtyDialog(m, 0);
      if (v == null) return;
      await setRiga(inv, m, v, "manuale");
      refresh();
    } else if (act === "nn") {
      const v = await formDialog({ title: "Non necessario", intro: `<p><b>${esc(m.nome)}</b> non verrà rilevato in questo inventario.</p>`,
        fields: [{ name: "motivo", label: "Motivo (facoltativo)" }], submit: "Conferma" });
      if (!v) return;
      await setRiga(inv, m, 0, "non_necessario", v.motivo);
      refresh();
    }
  });

  $("#allNN") && ($("#allNN").onclick = async () => {
    if (!(await confirmDialog(`Segnare tutti i ${mancanti.length} materiali rimanenti come "non necessario"?`))) return;
    for (const m of mancanti) await setRiga(inv, m, 0, "non_necessario", "non rilevato");
    refresh();
  });

  $("#confermaChiusura") && ($("#confermaChiusura").onclick = async () => {
    const note = $("#revNotes") ? $("#revNotes").value.trim() : "";
    for (const m of mancanti) {
      await setRiga(inv, m, 0, "non_necessario", "non rilevato in inventario");
    }
    await finalizzaChiusura(inv, note);
  });
}

function qtyDialog(m, current) {
  return formDialog({
    title: m?.nome || "Quantità",
    intro: `<p class="muted">${m?.pezzi_per_scatola || 1} pezzi per scatola · Barcode: ${esc(m?.barcode || "")}</p>`,
    fields: [{ name: "scatole", label: "Numero di scatole intere", type: "number", min: 0, value: current, required: true }],
    submit: "Conferma quantità",
  }).then((v) => (v ? Math.max(0, v.scatole | 0) : null));
}

async function setRiga(inv, m, scatole, esito, motivo = "") {
  const righe = await righeInv(inv);
  let r = righe.find((x) => x.materiale_id === m.id);
  if (!r) r = { id: uuid(), inventario_id: inv.id, materiale_id: m.id };
  Object.assign(r, { scatole, pezzi_per_scatola: m.pezzi_per_scatola, esito, motivo, operatore_id: ME.id, rilevato_at: nowISO() });
  await db.put("righe", r);
  await cloud.audit(esito === "non_necessario" ? "segnato_non_necessario" : "giacenza_rilevata", "inventario", inv.id,
    { materiale_id: m.id, barcode: m.barcode, scatole, esito, motivo });
  return r;
}

async function onScan(inv, code, manual = false) {
  if (scanPaused || currentRoute !== "inventario") return;
  scanPaused = true;
  await stopScanner();
  invState.cameraOn = false;

  try {
    let m = await materialeByBarcode(code);
    if (!m) {
      m = await nuovoMaterialeDialog(code);
      if (!m) return;
    } else if (m.attivo === false) {
      toast(`${m.nome} è disattivato in archivio`);
    }
    const righe = await righeInv(inv);
    const r = righe.find((x) => x.materiale_id === m.id);
    const ask = (await db.getMeta("scan_mode", "piu1")) === "chiedi";
    const esito = manual ? "manuale" : "scansionato";
    let qty;
    if (ask) {
      qty = await qtyDialog(m, r && r.esito !== "non_necessario" ? r.scatole : 1);
      if (qty == null) return;
    } else {
      qty = r && r.esito !== "non_necessario" ? r.scatole + 1 : 1;
    }
    await setRiga(inv, m, qty, r && r.esito !== "non_necessario" ? r.esito : esito);
    lastScannedItem = { nome: m.nome, barcode: m.barcode, scatole: qty };
    toast(`✔ ${m.nome}: ${qty} scatole rilevate`);
  } finally {
    scanPaused = false;
    invState.cameraOn = false; // La fotocamera resta ferma finché l'operatore non la richiede espressamente
    const fresh = await db.get("inventari", inv.id);
    await renderInventario(fresh);
  }
}

async function chiudiInventario(inv) {
  invState.verifying = true;
  const fresh = await db.get("inventari", inv.id);
  await renderInventario(fresh);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function finalizzaChiusura(inv, note = "") {
  await stopScanner();
  invState.cameraOn = false;
  invState.verifying = false;
  lastScannedItem = null;
  document.querySelector("main")?.classList.remove("with-thumb");

  inv.note = note;
  inv.stato = "chiuso";
  inv.chiuso_at = nowISO();
  inv.synced = false;
  await db.put("inventari", inv);
  await enqueue("inventario", inv.id);
  const righeFinali = await righeInv(inv);
  await cloud.audit("inventario_chiuso", "inventario", inv.id, {
    righe: righeFinali.length,
    rilevati: righeFinali.filter(r => r.esito !== "non_necessario").length,
    note
  });
  if (ME.locale) await notificheLocali(inv, righeFinali);
  toast(navigator.onLine ? "Inventario verificato e chiuso con successo!" : "Inventario salvato offline!", 4000);
  cloud.sync();
  go(`inv/${inv.id}`);
}

// In modalità locale (senza Supabase) le notifiche vengono generate sul dispositivo
async function notificheLocali(inv, righe) {
  const n = (await db.getMeta("local_inv_counter", 0)) + 1;
  await db.setMeta("local_inv_counter", n);
  inv.numero = n; inv.synced = true;
  await db.put("inventari", inv);
  await db.clear("outbox");
  await db.put("notifiche", { id: uuid(), tipo: "inventario", destinatari: "tutti", titolo: `Inventario n. ${n}`,
    testo: `Compilato da ${inv.operatore_nome} il ${fmtDT(inv.chiuso_at)}`, inventario_id: inv.id, created_at: nowISO() });
  const mats = new Map((await db.all("materiali")).map((m) => [m.id, m]));
  for (const r of righe) {
    const m = mats.get(r.materiale_id);
    if (m && r.esito !== "non_necessario" && m.scorta_minima > 0 && r.scatole < m.scorta_minima) {
      await db.put("notifiche", { id: uuid(), tipo: "scorta", destinatari: "master", titolo: `Sotto scorta: ${m.nome}`,
        testo: `Giacenza ${r.scatole} scatole – minimo ${m.scorta_minima} (inventario n. ${n})`, inventario_id: inv.id, materiale_id: m.id, created_at: nowISO() });
    }
  }
}

// ------------------------------------------------------------------
// MATERIALI (archivio)
// ------------------------------------------------------------------
routes.materiali = async () => {
  setTitle("Archivio materiali");
  const mats = await materiali({ soloAttivi: false });
  const attivi = mats.filter((m) => m.attivo !== false);
  const dismessi = mats.filter((m) => m.attivo === false);
  let filtro = "attivi"; // Di default i materiali eliminati/dismessi sono nascosti!

  view.innerHTML = `
    <div class="row chips">
      <button class="chip active" data-f="attivi">In uso (${attivi.length})</button>
      ${dismessi.length ? `<button class="chip" data-f="dismessi">🗑 Eliminati / dismessi (${dismessi.length})</button>` : ""}
      <button class="chip" data-f="tutti">Tutti (${mats.length})</button>
    </div>
    <div class="row"><input type="search" id="q" placeholder="Cerca nome, categoria o barcode" class="grow">
      <button class="btn" id="scanSearch" title="Cerca con scanner">📷</button></div>
    <button class="btn primary block" id="addMat">＋ Nuovo materiale</button>
    <div id="dismessiBar"></div>
    <div class="card list" id="matList"></div>`;

  const draw = () => {
    const ql = ($("#q")?.value || "").toLowerCase();
    const baseList = filtro === "attivi" ? attivi : filtro === "dismessi" ? dismessi : mats;
    const list = baseList.filter((m) => !ql || `${m.nome} ${m.categoria} ${m.barcode}`.toLowerCase().includes(ql));

    const bar = $("#dismessiBar");
    if (bar) {
      if (filtro === "dismessi" && ME.ruolo === "master" && dismessi.length > 0) {
        bar.innerHTML = `<div class="row between" style="margin: 6px 0;">
          <small class="muted">Materiali archiviati o inseriti per prova</small>
          <button class="btn small danger ghost" id="cleanAllDismessi">🧹 Svuota tutti (${dismessi.length})</button>
        </div>`;
        $("#cleanAllDismessi").onclick = async () => {
          if (!(await confirmDialog(`Eliminare definitivamente tutti i ${dismessi.length} materiali dismessi dal database?`, "Elimina tutti", true))) return;
          for (const dm of dismessi) {
            await cloud.deleteMaterialeCompleto(dm.id);
          }
          await cloud.audit("materiali_test_svuotati", "materiali", null, { quantita: dismessi.length });
          toast("Tutti i materiali di prova sono stati eliminati definitivamente");
          render();
        };
      } else {
        bar.innerHTML = "";
      }
    }

    $("#matList").innerHTML = list.length ? list.map((m) => `<div class="line ${m.attivo === false ? "dim" : ""}">
      <a class="info link" href="#materiale/${m.id}">
        <div><b>${esc(m.nome)}</b> ${m.attivo === false ? '<span class="pill red">Eliminato/dismesso</span>' : ""}</div>
        <small>${esc(m.categoria || "—")} · ${esc(m.barcode)}</small>
      </a>
      <div class="row">
        <div class="right"><small>${m.pezzi_per_scatola} pz/sc</small>${m.scorta_minima ? `<small>min ${m.scorta_minima} sc</small>` : ""}</div>
        ${ME.ruolo === "master" && m.attivo === false ? `<button class="btn small danger ghost" data-del-id="${m.id}" title="Elimina per sempre dal database">🗑</button>` : ""}
      </div></div>`).join("")
      : `<p class="muted">${filtro === "dismessi" ? "Nessun materiale eliminato o dismesso." : "Nessun materiale trovato."}</p>`;

    $$("[data-del-id]", view).forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.dataset.delId;
        const mat = mats.find((x) => x.id === id);
        if (!(await confirmDialog(`Eliminare DEFINITIVAMENTE "${mat?.nome || "questo materiale"}" dal database? Non potrà più essere recuperato.`, "Elimina definitivamente", true))) return;
        await cloud.deleteMaterialeCompleto(id);
        await cloud.audit("materiale_eliminato_definitivamente", "materiale", id, { nome: mat?.nome, barcode: mat?.barcode });
        toast("Materiale eliminato definitivamente");
        render();
      };
    });
  };

  draw();
  $("#q").oninput = draw;
  $$(".chip", view).forEach((c) => c.onclick = () => {
    $$(".chip", view).forEach((x) => x.classList.remove("active"));
    c.classList.add("active");
    filtro = c.dataset.f;
    draw();
  });
  $("#addMat").onclick = async () => { const m = await nuovoMaterialeDialog(""); if (m) render(); };
  $("#scanSearch").onclick = async () => {
    const code = await scanOnce();
    if (!code) return;
    const m = await materialeByBarcode(code);
    if (m) go(`materiale/${m.id}`);
    else { const n = await nuovoMaterialeDialog(code); if (n) go(`materiale/${n.id}`); }
  };
};

routes.materiale = async (id) => {
  const m = await db.get("materiali", id);
  if (!m) { go("materiali"); return; }
  setTitle("Materiale");
  const giac = (await calcolaGiacenze()).find((g) => g.id === id);
  const isMaster = ME.ruolo === "master";
  view.innerHTML = `
    ${m.attivo === false ? `
      <div class="card error">
        <b>🗑 Materiale eliminato / dismesso</b>
        <p class="muted">Questo materiale è attualmente escluso dagli elenchi in uso e non compare negli inventari.${isMaster ? "<br>Puoi riattivarlo spuntando la casella 'Attivo' sotto e salvando." : ""}</p>
      </div>` : ""}
    <form class="card form" id="mf">
      <label>Codice a barre</label><input value="${esc(m.barcode)}" readonly>
      <label>Nome</label><input name="nome" value="${esc(m.nome)}" required>
      <label>Categoria</label><input name="categoria" value="${esc(m.categoria || "")}">
      <label>Pezzi per scatola</label><input name="ppb" type="number" inputmode="numeric" min="1" value="${m.pezzi_per_scatola}" required>
      <label>Scorta minima (scatole) ${isMaster ? "" : "– impostata dal master"}</label>
      <input name="min" type="number" inputmode="numeric" min="0" value="${m.scorta_minima || 0}" ${isMaster ? "" : "readonly"}>
      ${isMaster ? `<label class="check"><input type="checkbox" name="attivo" ${m.attivo !== false ? "checked" : ""}> Attivo (incluso negli inventari e visibile nell'elenco in uso)</label>` : ""}
      <button class="btn primary block">Salva modifiche</button>
      ${isMaster ? `
        <div class="row" style="margin-top: 8px">
          ${m.attivo !== false ? `<button type="button" class="btn ghost grow" id="dismettiMat">📦 Dismetti (archivia)</button>` : ""}
          <button type="button" class="btn danger grow" id="hardDelMat">🗑 Elimina per sempre (test)</button>
        </div>
      ` : ""}
    </form>
    <div class="card">
      <small class="muted">Giacenza attuale</small>
      <div><b>${giac?.scatole ?? "–"}</b> scatole${giac?.totale != null ? ` (${giac.totale} pezzi)` : ""}</div>
      <small class="muted">${giac?.rilevato_il ? `rilevata il ${fmtDT(giac.rilevato_il)}` : "mai rilevata"}</small>
    </div>`;

  if (isMaster) {
    if ($("#dismettiMat")) {
      $("#dismettiMat").onclick = async () => {
        const v = await formDialog({
          title: "Dismetti materiale",
          intro: `<p><b>${esc(m.nome)}</b> non comparirà più negli inventari né nell'elenco attivo, ma conserverà lo storico delle rilevazioni passate.</p>`,
          fields: [{ name: "motivo", label: "Motivo della dismissione", required: true, placeholder: "es. Fuori produzione, sostituito..." }],
          submit: "Dismetti"
        });
        if (!v) return;
        m.attivo = false;
        await salvaMateriale(m, "materiale_dismesso");
        await cloud.audit("materiale_dismesso", "materiale", m.id, { nome: m.nome, barcode: m.barcode, motivo: v.motivo });
        toast("Materiale dismesso");
        go("materiali");
      };
    }
    if ($("#hardDelMat")) {
      $("#hardDelMat").onclick = async () => {
        if (!(await confirmDialog(
          `Eliminare DEFINITIVAMENTE "${m.nome}"? Verrà cancellato per sempre dal database e da tutti i dispositivi (ideale per eliminare materiali inseriti per prova).`,
          "Elimina per sempre",
          true
        ))) return;
        await cloud.deleteMaterialeCompleto(m.id);
        await cloud.audit("materiale_eliminato_definitivamente", "materiale", m.id, { nome: m.nome, barcode: m.barcode });
        toast("Materiale eliminato definitivamente");
        go("materiali");
      };
    }
  }

  $("#mf").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    m.nome = f.nome.value.trim();
    m.categoria = f.categoria.value.trim();
    m.pezzi_per_scatola = Math.max(1, Number(f.ppb.value) | 0);
    if (isMaster) { m.scorta_minima = Math.max(0, Number(f.min.value) | 0); m.attivo = f.attivo.checked; }
    await salvaMateriale(m, "materiale_modificato");
    toast("Modifiche salvate");
    cloud.sync();
    go("materiali");
  };
};


// ------------------------------------------------------------------
// GIACENZE
// ------------------------------------------------------------------
routes.giacenze = async (filtroIniziale) => {
  setTitle("Giacenze");
  const giac = await calcolaGiacenze();
  const sottoList = giac.filter((g) => g.sotto);
  let filtro = filtroIniziale === "sotto" ? "sotto" : "tutti";

  view.innerHTML = `
    <div class="row chips">
      <button class="chip ${filtro === "tutti" ? "active" : ""}" data-f="tutti">Tutti i materiali (${giac.length})</button>
      <button class="chip ${filtro === "sotto" ? "active" : ""}" data-f="sotto">⚠ Sotto scorta (${sottoList.length})</button>
    </div>
    <input type="search" id="q" placeholder="Cerca materiale, categoria o barcode">
    <div class="card list" id="gList"></div>
    <div class="row pdfbar">
      <button class="btn" id="pOpen">📄 Apri PDF</button>
      <button class="btn" id="pPrint">🖨 Stampa</button>
      <button class="btn" id="pShare">↗ Condividi</button>
    </div>`;

  const draw = () => {
    const q = $("#q").value.toLowerCase();
    const list = giac.filter((g) => (filtro === "tutti" || g.sotto) && (!q || `${g.nome} ${g.categoria} ${g.barcode}`.toLowerCase().includes(q)));
    $("#gList").innerHTML = list.length ? list.map((g) => `<a class="line link ${g.sotto ? "low" : ""}" href="#materiale/${g.id}">
      <div class="info">
        <b>${esc(g.nome)}</b>
        <small>${esc(g.categoria || "—")} · ${g.rilevato_il ? fmtDT(g.rilevato_il) : "mai rilevato"}</small>
      </div>
      <div class="right">
        <b class="${g.sotto ? "red" : ""}">${g.scatole ?? "–"}</b>
        <small>${g.scorta_minima > 0 ? `min: ${g.scorta_minima} sc` : "scatole"}</small>
      </div></a>`).join("")
      : `<p class="muted">${filtro === "sotto" ? "Ottimo! Nessun materiale attualmente sotto scorta." : "Nessun materiale trovato."}</p>`;
  };

  draw();
  $("#q").oninput = draw;
  $$(".chip").forEach((c) => c.onclick = () => {
    $$(".chip").forEach((x) => x.classList.remove("active"));
    c.classList.add("active");
    filtro = c.dataset.f;
    location.hash = filtro === "sotto" ? "giacenze/sotto" : "giacenze";
    draw();
  });

  const make = () => {
    const datiExport = filtro === "sotto" ? sottoList : giac;
    return pdf.giacenzePdf({ giacenze: datiExport, operatoreStampa: ME.nome });
  };
  $("#pOpen").onclick = () => { pdf.openPdf(make()); cloud.audit("pdf_giacenze", "report", null); };
  $("#pPrint").onclick = () => { pdf.printPdf(make()); cloud.audit("pdf_giacenze_stampa", "report", null); };
  $("#pShare").onclick = () => { pdf.sharePdf(make()); cloud.audit("pdf_giacenze_condiviso", "report", null); };
};

// ------------------------------------------------------------------
// STORICO e DETTAGLIO INVENTARIO
// ------------------------------------------------------------------
routes.storico = async () => {
  setTitle("Storico inventari");
  const list = await inventariChiusi();
  view.innerHTML = `
    <div class="row between">
      <small class="muted">Conservati gli ultimi 50 inventari per consultazione e ristampa PDF</small>
      <small class="muted">${list.length}/50</small>
    </div>
    <div class="card list">${list.length ? list.map((i) => `
      <div class="line">
        <a class="info link" href="#inv/${i.id}">
          <b>${i.numero ? `Inventario n. ${i.numero}` : "Inventario (numero in attesa)"}</b>
          <small>${fmtDT(i.chiuso_at)} · ${esc(i.operatore_nome)}</small>
        </a>
        <div class="row">
          <span>${i.synced ? "✔" : "⏳"}</span>
          ${ME.ruolo === "master" ? `<button class="btn small danger ghost" data-del-inv="${i.id}" title="Elimina inventario di prova">🗑</button>` : ""}
        </div>
      </div>`).join("") : `<p class="muted">Nessun inventario registrato.</p>`}</div>`;

  $$("[data-del-inv]", view).forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delInv;
      const target = list.find((x) => x.id === id);
      if (!(await confirmDialog(`Eliminare DEFINITIVAMENTE l'inventario ${target?.numero ? `n. ${target.numero}` : ""} dal database e dal dispositivo? (Ideale per pulire inventari di test)`, "Elimina inventario", true))) return;
      await cloud.deleteInventario(id);
      await cloud.audit("inventario_eliminato", "inventario", id);
      toast("Inventario eliminato definitivamente");
      render();
    };
  });
};

async function righeInventarioConFetch(inv) {
  let righe = await db.byIndex("righe", "inventario_id", inv.id);
  if (!righe.length && cloud.configured && navigator.onLine && !ME.locale) {
    const { data } = await cloud.sb.from("righe_inventario").select("*").eq("inventario_id", inv.id);
    if (data?.length) { await db.bulkPut("righe", data); righe = data; }
  }
  return righe;
}

async function inventarioDettaglio(id, banner = "") {
  let inv = await db.get("inventari", id);
  if (!inv && cloud.configured && navigator.onLine && !ME.locale) {
    const { data } = await cloud.sb.from("inventari").select("*").eq("id", id).maybeSingle();
    if (data) { inv = { ...data, stato: "chiuso", synced: true }; await db.put("inventari", inv); }
  }
  if (!inv) { view.innerHTML = `${banner}<div class="card">Inventario non disponibile offline. Riprova quando sei connesso.</div>`; return; }
  const righe = await righeInventarioConFetch(inv);
  const mats = await db.all("materiali");
  const mat = new Map(mats.map((m) => [m.id, m]));
  const sorted = righe.map((r) => ({ r, m: mat.get(r.materiale_id) || { nome: "?", scorta_minima: 0 } }))
    .sort((a, b) => a.m.nome.localeCompare(b.m.nome));
  const sotto = sorted.filter(({ r, m }) => r.esito !== "non_necessario" && m.scorta_minima > 0 && r.scatole < m.scorta_minima).length;
  setTitle(inv.numero ? `Inventario n. ${inv.numero}` : "Inventario");
  view.innerHTML = `${banner}
    <div class="card">
      <div><b>${inv.numero ? `Inventario n. ${inv.numero}` : "Numero in attesa di sincronizzazione"}</b></div>
      <small class="muted">Operatore: ${esc(inv.operatore_nome)}<br>Chiuso il ${fmtDT(inv.chiuso_at)}${inv.note ? `<br>Note: ${esc(inv.note)}` : ""}</small>
      <div class="row wrap"><span class="pill">${righe.filter((r) => r.esito !== "non_necessario").length} rilevati</span>
        <span class="pill">${righe.filter((r) => r.esito === "non_necessario").length} non necessari</span>
        ${sotto ? `<span class="pill red">${sotto} sotto scorta</span>` : ""}
        <span class="pill">${inv.synced ? "✔ sincronizzato" : "⏳ in attesa di invio"}</span></div>
    </div>
    <div class="row pdfbar"><button class="btn primary" id="pOpen">📄 Apri PDF</button><button class="btn" id="pPrint">🖨 Stampa</button><button class="btn" id="pShare">↗ Condividi</button></div>
    ${ME.ruolo === "master" ? `
      <div style="margin: 10px 0;">
        <button class="btn danger ghost block" id="delThisInv">🗑 Elimina definitivamente questo inventario (test)</button>
      </div>
    ` : ""}
    <div class="card list">${sorted.map(({ r, m }) => {
      const low = r.esito !== "non_necessario" && m.scorta_minima > 0 && r.scatole < m.scorta_minima;
      return `<div class="line ${low ? "low" : ""} ${r.esito === "non_necessario" ? "dim" : ""}">
        <div class="info"><b>${esc(m.nome)}</b><small>${r.esito === "non_necessario" ? `non necessario${r.motivo ? ` – ${esc(r.motivo)}` : ""}` : `${r.scatole * r.pezzi_per_scatola} pezzi · ${r.esito}`}</small></div>
        <div class="right"><b>${r.esito === "non_necessario" ? "–" : r.scatole}</b><small>${m.scorta_minima ? `min ${m.scorta_minima}` : "sc"}</small></div></div>`;
    }).join("")}</div>`;
  const make = () => pdf.inventarioPdf({ inv, righe, materiali: mats, operatoreStampa: ME.nome });
  $("#pOpen").onclick = () => { pdf.openPdf(make()); cloud.audit("pdf_inventario", "inventario", inv.id); };
  $("#pPrint").onclick = () => { pdf.printPdf(make()); cloud.audit("pdf_inventario_stampa", "inventario", inv.id); };
  $("#pShare").onclick = () => { pdf.sharePdf(make()); cloud.audit("pdf_inventario_condiviso", "inventario", inv.id); };
  
  if (ME.ruolo === "master" && $("#delThisInv")) {
    $("#delThisInv").onclick = async () => {
      if (!(await confirmDialog(`Eliminare DEFINITIVAMENTE l'Inventario ${inv.numero ? `n. ${inv.numero}` : ""} e tutte le sue registrazioni dal database?`, "Elimina inventario", true))) return;
      await cloud.deleteInventario(inv.id);
      await cloud.audit("inventario_eliminato", "inventario", inv.id);
      toast("Inventario eliminato definitivamente");
      go("storico");
    };
  }
}
routes.inv = (id) => inventarioDettaglio(id);

// ------------------------------------------------------------------
// NOTIFICHE
// ------------------------------------------------------------------
routes.notifiche = async (id) => {
  const lette = new Set(await db.getMeta("notif_lette", []));
  if (id) {
    lette.add(id); await db.setMeta("notif_lette", [...lette]);
    const n = await db.get("notifiche", id);
    if (!n) { go("notifiche"); return; }
    const banner = `<div class="card notif ${n.tipo}"><b>${esc(n.titolo)}</b><small>${esc(n.testo)}</small></div>`;
    if (n.inventario_id) { $("#btnBack").classList.remove("hidden"); return inventarioDettaglio(n.inventario_id, banner); }
    setTitle("Notifica"); view.innerHTML = banner; return;
  }
  setTitle("Notifiche");
  const list = (await db.all("notifiche"))
    .filter((n) => n.destinatari !== "master" || ME.ruolo === "master")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  view.innerHTML = `
    ${"Notification" in window && Notification.permission !== "granted" ? `<button class="btn block" id="enN">🔔 Attiva notifiche sul telefono</button>` : ""}
    ${list.length ? `<button class="btn small ghost" id="allRead">Segna tutte come lette</button>` : ""}
    <div class="card list">${list.length ? list.map((n) => `<a class="line link notif ${n.tipo} ${lette.has(n.id) ? "" : "unread"}" href="#notifiche/${n.id}">
      <div class="info"><b>${n.tipo === "scorta" ? "⚠ " : "📦 "}${esc(n.titolo)}</b><small>${esc(n.testo)}</small></div>
      <div class="right"><small>${fmtDT(n.created_at)}</small></div></a>`).join("")
      : `<p class="muted">Nessuna notifica. ${ME.locale ? "" : "Le notifiche arrivano dopo la sincronizzazione."}</p>`}</div>`;
  $("#enN") && ($("#enN").onclick = attivaNotifiche);
  $("#allRead") && ($("#allRead").onclick = async () => { await db.setMeta("notif_lette", list.map((n) => n.id)); render(); });
};

async function attivaNotifiche() {
  try {
    const tipo = await cloud.enableNotifications();
    toast(tipo === "push" ? "Notifiche push attivate" : "Notifiche attivate");
    render();
  } catch (e) { toast(e.message || String(e), 4000); }
}

// ------------------------------------------------------------------
// MENU, IMPOSTAZIONI, OPERATORI
// ------------------------------------------------------------------
routes.menu = async () => {
  setTitle("Menu");
  view.innerHTML = `<div class="card list">
    <a class="line link" href="#storico"><div class="info"><b>🗂 Storico inventari</b></div></a>
    ${ME.ruolo === "master" ? `<a class="line link" href="#audit"><div class="info"><b>📋 Registro attività (Audit log)</b><small>chi ha fatto cosa, modifiche ed eliminazioni</small></div></a>` : ""}
    ${ME.ruolo === "master" && !ME.locale ? `<a class="line link" href="#operatori"><div class="info"><b>👥 Operatori</b><small>approvazione e ruoli</small></div></a>` : ""}
    <a class="line link" href="#impostazioni"><div class="info"><b>⚙ Impostazioni e backup</b></div></a>
  </div>
  <p class="muted center">Diastock v1.0 · ${esc(ME.nome)}</p>`;
};

routes.audit = async () => {
  setTitle("Registro attività");
  if (ME.ruolo !== "master") { go("menu"); return; }

  const invs = await inventariChiusi();
  const cutoffInv = invs.length >= 20 ? invs[19] : null;
  const cutoffDate = cutoffInv?.chiuso_at || cutoffInv?.iniziato_at;

  let logs = [];
  if (cloud.configured && navigator.onLine) {
    let q = cloud.sb
      .from("audit_log")
      .select("*, operatori:operatore_id(nome)")
      .order("eseguito_at", { ascending: false });

    if (cutoffDate) {
      q = q.gte("eseguito_at", cutoffDate);
    } else {
      q = q.limit(80);
    }
    const { data } = await q;
    if (data) logs = data;
  }

  view.innerHTML = `
    <div class="row between">
      <small class="muted">${cutoffDate ? `Attività degli ultimi 20 inventari (dal ${fmtDT(cutoffDate)})` : "Ultime azioni registrate sul sistema"}</small>
      <div class="row">
        ${cutoffDate ? `<button class="btn small danger ghost" id="purgeAudit" title="Elimina dal database le annotazioni precedenti agli ultimi 20 inventari">🧹 Pulisci vecchie</button>` : ""}
        <button class="btn small ghost" id="refAudit">⟳ Aggiorna</button>
      </div>
    </div>
    <div class="card list">
      ${logs.length ? logs.map(l => {
        const opNome = l.operatori?.nome || "Operatore";
        const dett = l.dettagli ? Object.entries(l.dettagli).map(([k, v]) => `${k}: ${v}`).join(" · ") : "";
        const isDel = /elimina|dismess/i.test(l.azione);
        return `<div class="line ${isDel ? "low" : ""}">
          <div class="info">
            <b>${isDel ? "🗑 " : "🔹 "}${esc(l.azione.replace(/_/g, " "))}</b>
            <small>${esc(opNome)} · ${fmtDT(l.eseguito_at)}</small>
            ${dett ? `<small class="muted">${esc(dett)}</small>` : ""}
          </div>
        </div>`;
      }).join("") : `<p class="muted">Nessuna attività registrata negli ultimi 20 inventari.</p>`}
    </div>
  `;

  $("#refAudit") && ($("#refAudit").onclick = () => render());
  $("#purgeAudit") && ($("#purgeAudit").onclick = async () => {
    if (!(await confirmDialog("Eliminare definitivamente dal database tutte le annotazioni più vecchie del 20° inventario?", "Pulisci registro", true))) return;
    try {
      await cloud.cleanOldAuditLogs();
      toast("Annotazioni più vecchie rimosse con successo");
      render();
    } catch (e) {
      toast("Errore durante la pulizia: " + (e.message || e), 4000);
    }
  });
};

routes.impostazioni = async () => {
  setTitle("Impostazioni");
  const [pend, last, dev] = await Promise.all([pendingCount(), db.getMeta("last_sync"), deviceId()]);
  view.innerHTML = `
    <div class="card">
      <small class="muted">Operatore</small>
      <div><b>${esc(ME.nome)}</b> · ${ME.ruolo}${ME.email ? ` · ${esc(ME.email)}` : ""}</div>
      <button class="btn small" id="rename">Modifica nome</button>
    </div>
    <div class="card">
      <h3>Sincronizzazione e backup</h3>
      <small class="muted">${ME.locale ? "Modalità locale: configura Supabase in config.js per sincronizzare." :
        `Ultima sincronizzazione: ${last ? fmtDT(last) : "mai"}<br>Operazioni in coda: ${pend}${cloud.state.lastError ? `<br>Ultimo errore: ${esc(cloud.state.lastError)}` : ""}`}</small>
      ${!ME.locale ? `<button class="btn block" id="sync">⟳ Sincronizza ora</button>` : ""}
      <button class="btn block ghost" id="export">⬇ Esporta backup locale (JSON)</button>
    </div>
    <div class="card">
      <h3>Notifiche</h3>
      <small class="muted">Stato: ${"Notification" in window ? Notification.permission : "non supportate (su iPhone installa l'app nella schermata Home)"}</small>
      <button class="btn block" id="notif">🔔 Attiva notifiche</button>
    </div>
    <div class="card"><small class="muted">ID dispositivo: ${dev}</small></div>
    <button class="btn danger block" id="logout">Esci</button>`;
  $("#rename").onclick = async () => {
    const v = await formDialog({ title: "Nome operatore", fields: [{ name: "nome", label: "Nome e cognome", value: ME.nome, required: true }] });
    if (!v) return;
    if (!ME.locale) {
      if (!navigator.onLine) { toast("Serve la connessione per modificare il nome"); return; }
      const { error } = await cloud.sb.from("profiles").update({ nome: v.nome }).eq("id", ME.id);
      if (error) { toast(error.message); return; }
    }
    ME.nome = v.nome; await db.setMeta("profile", ME);
    await cloud.audit("nome_modificato", "profilo", ME.id, { nome: v.nome });
    render();
  };
  $("#sync") && ($("#sync").onclick = () => cloud.sync());
  $("#notif").onclick = attivaNotifiche;
  $("#export").onclick = async () => {
    const dump = { app: "Diastock", esportato_il: nowISO(), operatore: ME.nome };
    for (const s of ["materiali", "inventari", "righe", "notifiche", "outbox"]) dump[s] = await db.all(s);
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `diastock_backup_${nowISO().slice(0, 10)}.json`; a.click();
    cloud.audit("backup_esportato", "sistema", null);
  };
  $("#logout").onclick = async () => {
    const p = await pendingCount();
    const msg = p ? `Ci sono ${p} operazioni non ancora inviate. Uscendo resteranno sul telefono e verranno inviate al prossimo accesso con lo stesso account. Uscire?` : "Vuoi uscire?";
    if (!(await confirmDialog(msg, "Esci", true))) return;
    await cloud.signOut();
    location.hash = "";
    boot();
  };
};

routes.operatori = async () => {
  setTitle("Operatori");
  if (ME.ruolo !== "master") { go("menu"); return; }
  const list = await cloud.getOperatoriList();
  view.innerHTML = `
    <div class="row between">
      <small class="muted">Gestione operatori e PIN</small>
      <button class="btn small primary" id="addOp">＋ Nuovo operatore</button>
    </div>
    <div class="card list">${list.map((p) => `<div class="line" data-id="${p.id}">
      <div class="info"><b>${esc(p.nome)}</b><small>Ruolo: ${p.ruolo}</small></div>
      <div class="col">
        <select data-k="ruolo" ${p.id === ME.id ? "disabled" : ""}>
          <option value="operatore" ${p.ruolo === "operatore" ? "selected" : ""}>Operatore</option>
          <option value="master" ${p.ruolo === "master" ? "selected" : ""}>Master</option>
        </select>
        <label class="check small"><input type="checkbox" data-k="attivo" ${p.attivo ? "checked" : ""} ${p.id === ME.id ? "disabled" : ""}> abilitato</label>
      </div></div>`).join("") || `<p class="muted">Nessun operatore configurato.</p>`}</div>`;

  $("#addOp").onclick = async () => {
    const v = await formDialog({
      title: "Nuovo operatore",
      fields: [
        { name: "nome", label: "Nome e cognome", required: true, placeholder: "es. Mario Rossi" },
        { name: "pin", label: "PIN a 4 cifre", type: "number", required: true, placeholder: "1234" },
        { name: "ruolo", label: "Ruolo", type: "select", value: "operatore", options: [{ value: "operatore", label: "Operatore" }, { value: "master", label: "Master" }] }
      ],
      submit: "Crea operatore"
    });
    if (!v) return;
    try {
      await cloud.signUpPin(v.nome, String(v.pin), v.ruolo);
      toast("Operatore aggiunto con successo");
      render();
    } catch (e) {
      toast(e.message || String(e), 4000);
    }
  };

  $$("[data-k]", view).forEach((el) => el.onchange = async () => {
    if (!navigator.onLine) { toast("Serve la connessione per modificare gli operatori"); render(); return; }
    const id = el.closest(".line").dataset.id;
    const patch = { [el.dataset.k]: el.type === "checkbox" ? el.checked : el.value };
    const { error } = await cloud.sb.from("operatori").update(patch).eq("id", id);
    if (error) { toast(error.message); return; }
    const p = await db.get("profili", id); if (p) { Object.assign(p, patch); await db.put("profili", p); }
    await cloud.audit("operatore_modificato", "operatore", id, patch);
    toast("Salvato");
  });
};

// ------------------------------------------------------------------
// ACCESSO CON PIN A 4 CIFRE
// ------------------------------------------------------------------
async function renderLogin(msg = "") {
  document.body.classList.add("auth");
  setTitle("Diastock – Accesso");
  const ops = await cloud.getOperatoriList();

  view.innerHTML = `<div class="card">
    <h2>Accesso operatore</h2>
    ${msg ? `<p class="error">${esc(msg)}</p>` : ""}
    <form id="lf" class="form">
      ${ops.length ? `
        <label>Seleziona operatore</label>
        <select name="nome" id="selOp">
          ${ops.map(o => `<option value="${esc(o.nome)}">${esc(o.nome)} (${o.ruolo})</option>`).join("")}
        </select>
      ` : `
        <label>Nome operatore</label>
        <input name="nome" required placeholder="es. Coordinatore Master" value="Coordinatore Master">
      `}
      <label>PIN (4 cifre)</label>
      <input name="pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required placeholder="••••" autocomplete="current-password" autofocus>
      <button class="btn primary block">Accedi</button>
    </form>
    <button class="btn ghost block" id="reg">＋ Registra nuovo operatore</button>
  </div>`;

  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    const nome = e.target.nome.value.trim();
    const pin = e.target.pin.value.trim();
    try {
      await cloud.signInPin(nome, pin);
      boot();
    } catch (err) {
      renderLogin(err.message || "Nome o PIN non corretti");
    }
  };

  $("#reg").onclick = renderRegister;
}

function renderRegister() {
  view.innerHTML = `<div class="card">
    <h2>Nuovo operatore</h2>
    <form id="rf" class="form">
      <label>Nome e cognome</label>
      <input name="nome" required placeholder="es. Mario Rossi">
      <label>PIN a 4 cifre (es. 1234)</label>
      <input name="pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required placeholder="••••" autocomplete="new-password">
      <button class="btn primary block">Salva e accedi</button>
    </form>
    <button class="btn ghost block" id="back">Torna all'accesso</button>
  </div>`;

  $("#back").onclick = () => renderLogin();
  $("#rf").onsubmit = async (e) => {
    e.preventDefault();
    const nome = e.target.nome.value.trim();
    const pin = e.target.pin.value.trim();
    try {
      await cloud.signUpPin(nome, pin, "operatore");
      toast("Operatore registrato!");
      boot();
    } catch (err) {
      toast(err.message, 4000);
    }
  };
}

function renderWaiting() {
  document.body.classList.add("auth");
  view.innerHTML = `<div class="card"><h2>In attesa di abilitazione</h2>
    <p>Ciao <b>${esc(ME.nome)}</b>, il tuo profilo deve essere abilitato dal Coordinatore Master prima di poter usare l'app.</p>
    <button class="btn primary block" id="retry">Verifica di nuovo</button>
    <button class="btn ghost block" id="out">Esci</button></div>`;
  $("#retry").onclick = boot;
  $("#out").onclick = async () => { await cloud.signOut(); boot(); };
}

// ------------------------------------------------------------------
// AVVIO
// ------------------------------------------------------------------
let booted = false;
async function boot() {
  ME = await cloud.currentProfile();
  if (ME && !ME.locale && cloud.configured && navigator.onLine) {
    ME = await cloud.refreshProfile();
  }
  if (!ME) { renderLogin(); return; }
  if (!ME.attivo) { renderWaiting(); return; }
  document.body.classList.remove("auth");
  if (!booted) {
    booted = true;
    window.addEventListener("hashchange", render);
    window.addEventListener("online", updateStatus);
    window.addEventListener("offline", updateStatus);
    $("#btnBack").onclick = () => { const [n] = location.hash.slice(1).split("/"); go(BACK_OF[n] || "home"); };
    cloud.onChange(async (ev) => {
      updateStatus();
      if (ev.type === "sync-done") {
        ME = (await cloud.currentProfile()) || ME;
        if (ev.nuove?.length) toast(`${ev.nuove.length} nuove notifiche`);
        if (!["inventario", "materiale"].includes(currentRoute) && !dlg.open) render();
      }
      if (ev.type === "sync-error" && !ev.silent) toast(ev.error, 4000);
    });
    if (!ME.locale) cloud.startAutoSync();
  }
  render();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.url) location.hash = e.data.url.split("#")[1] || ""; });
}
boot();
