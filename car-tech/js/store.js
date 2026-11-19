// Local storage on this device only (phase 1). IndexedDB for records, localStorage for settings.
// If the browser blocks IndexedDB (some private modes), records are kept in memory for this
// session only — and `store.persistent` says so, so the UI can tell the person honestly.
const DB = 'car-tech', VER = 1, STORES = ['scans', 'trips', 'ai', 'photos', 'vehicles', 'library'];
let dbp = null;
const mem = Object.fromEntries(STORES.map(s => [s, new Map()]));
function db() {
  if (dbp) return dbp;
  dbp = new Promise(res => {
    let done = false;
    const fail = () => { if (!done) { done = true; store.persistent = false; res(null); } };
    try {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => { const d = r.result; for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
      r.onsuccess = () => { if (!done) { done = true; res(r.result); } };
      r.onerror = fail; r.onblocked = fail;
      setTimeout(fail, 4000);
    } catch { fail(); }
  });
  return dbp;
}
function tx(name, mode, fn, memFn) {
  return db().then(d => {
    if (!d) return memFn(mem[name]);
    return new Promise((res, rej) => {
      const t = d.transaction(name, mode); const s = t.objectStore(name);
      const out = fn(s);
      t.oncomplete = () => res(out?.result ?? out);
      t.onerror = () => rej(t.error);
    });
  });
}
const clone = o => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
export const store = {
  persistent: true,
  put: (s, obj) => tx(s, 'readwrite', st => st.put(obj), m => m.set(obj.id, clone(obj))).then(() => obj),
  get: (s, id) => tx(s, 'readonly', st => st.get(id), m => m.get(id)),
  del: (s, id) => tx(s, 'readwrite', st => st.delete(id), m => m.delete(id)),
  clear: s => tx(s, 'readwrite', st => st.clear(), m => m.clear()),
  async all(s) { const r = await tx(s, 'readonly', st => st.getAll(), m => [...m.values()]); return (r || []).sort((a, b) => (b.t || 0) - (a.t || 0)); },
};
const SKEY = 'ct.settings';
const DEFAULTS = { apiKey: '', model: 'claude-sonnet-5-5', aiOn: true, speak: true, voiceLang: 'ar-SA', extraUuids: [], units: 'metric', displacement: null, make: '', gauges: [0x0c, 0x0d, 0x05, 0x07, 0x09, 0x10, 0x42, 0x04] };
export function settings() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { return { ...DEFAULTS }; } }
export function saveSettings(patch) { const s = { ...settings(), ...patch }; try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch {} return s; }
