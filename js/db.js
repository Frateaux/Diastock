// Database locale (IndexedDB) – tutto il lavoro offline passa da qui.
const DB_NAME = "diastock";
const DB_VERSION = 1;
let _db;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("meta");
      const m = db.createObjectStore("materiali", { keyPath: "id" });
      m.createIndex("barcode", "barcode", { unique: false });
      db.createObjectStore("inventari", { keyPath: "id" });
      const r = db.createObjectStore("righe", { keyPath: "id" });
      r.createIndex("inventario_id", "inventario_id");
      r.createIndex("materiale_id", "materiale_id");
      db.createObjectStore("notifiche", { keyPath: "id" });
      db.createObjectStore("profili", { keyPath: "id" });
      db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function p(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

async function store(name, mode = "readonly") {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async get(s, key) { return p((await store(s)).get(key)); },
  async all(s) { return p((await store(s)).getAll()); },
  async put(s, val, key) { return p((await store(s, "readwrite")).put(val, key)); },
  async del(s, key) { return p((await store(s, "readwrite")).delete(key)); },
  async clear(s) { return p((await store(s, "readwrite")).clear()); },
  async byIndex(s, index, value) { return p((await store(s)).index(index).getAll(value)); },
  async bulkPut(s, vals) {
    const db_ = await openDB();
    return new Promise((res, rej) => {
      const tx = db_.transaction(s, "readwrite");
      const os = tx.objectStore(s);
      vals.forEach((v) => os.put(v));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  // meta key/value
  async getMeta(key, def = null) { const v = await this.get("meta", key); return v === undefined ? def : v; },
  async setMeta(key, val) { return this.put("meta", val, key); },
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}

export async function deviceId() {
  let id = await db.getMeta("device_id");
  if (!id) { id = uuid(); await db.setMeta("device_id", id); }
  return id;
}

// ---- coda di sincronizzazione ----
export async function enqueue(tipo, ref, payload = null) {
  return db.put("outbox", { tipo, ref, payload, created_at: new Date().toISOString() });
}

export async function pendingCount() {
  return (await db.all("outbox")).length;
}
