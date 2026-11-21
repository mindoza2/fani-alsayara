// Application state and high-level operations shared by all screens.
import { bus, uid, hex3, toast, sleep, withTimeout } from './util.js';
import { Connection } from './elm.js';
import { BleTransport, DemoTransport, bleSupport } from './transport.js';
import { Obd, stdEcuName, decodeReadiness, combineReadiness, readinessStats, chargeRange, PIDS } from './obd.js';
import { ModuleLayer, RANGES, moduleName } from './network.js';
import { describeDtc, addLibraryCodes } from './dtcdb.js';
import { trimAnalysis, addLibraryCircuits } from './diag.js';
import { store, settings } from './store.js';

const KIND = { stored: 'مخزّن', pending: 'معلّق', perm: 'دائم', history: 'سابق' };

export const app = {
  conn: new Connection(), demo: false, obd: null, mods: null,
  vehicle: {}, ecus: new Map(), readiness: new Map(), freeze: new Map(), mode06: null, mode09: null,
  lastScan: null, scanning: false, busy: null, live: new Map(), hist: new Map(), samples: [], lib: { modules: [], routines: [], codes: {}, circuits: {} },
  pidSupport: new Map(), modulesScanned: false,

  allDtcs() {
    const out = [];
    for (const e of this.ecus.values()) {
      for (const k of ['stored', 'pending', 'perm']) (e.dtcs?.[k] || []).forEach(code => out.push({ code, kind: k, kindLabel: KIND[k], module: e.name, key: e.key }));
      (e.dtcs?.mfr || []).forEach(d => out.push({ code: d.code, kind: d.kind, kindLabel: KIND[d.kind] || d.kind, module: e.name, key: e.key, mfr: true }));
    }
    return out;
  },
  // All emission computers as one vehicle status (MIL on if any computer says so; a monitor is
  // complete only when every computer that supports it is complete).
  readinessAll() { return combineReadiness([...this.readiness.entries()]); },
  readinessSummary() {
    const r = this.readinessAll(); if (!r) return null;
    const s = readinessStats(r);
    return `${s.ready}/${s.total} جاهز${s.notReady.length ? ' — غير جاهز: ' + s.notReady.map(m => m.name).join('، ') : ''}${r.mil ? ' — لمبة المكينة مضاءة' : ''}`;
  },
  liveValues() {
    // only fresh readings count (a silent car must not look "running" from stale values)
    const o = {}, fresh = Date.now() - 6000, pe = this.primaryEcu();
    for (const v of this.live.values()) if (v.value != null && v.t > fresh && (o[v.pid] == null || v.ecu === pe)) o[v.pid] = v.value;
    return o;
  },
  liveSnapshot() { return [...this.live.values()].filter(v => v.value != null).slice(0, 40).map(v => ({ name: PIDS[v.pid]?.[0] || v.name || v.pid, text: v.text, unit: v.unit })); },
  primaryEcu() { const k = [...this.pidSupport.keys()].sort(); return k.includes('7E8') ? '7E8' : k[0]; },
  running() { const v = this.liveValues(); return (v[0x0c] || 0) > 400; },
  ctx() { const v = this.liveValues(); return { running: (v[0x0c] || 0) > 400, warm: (v[0x05] ?? 0) > 70 || (v[0x1f] || 0) > 600, charge: chargeRange(this.vehicle) }; },
  trims() { return trimAnalysis(this.samples.slice(-600)); },
};
// Engine size of the car that is connected now (kept per vehicle: two cars must not share it).
export function vehDisplacement() { return app.vehicle.displacement ?? (app.vehicle.vin ? null : settings().displacement) ?? null; }

/* ---------------- reference library ---------------- */
export async function loadLibrary() {
  const items = await store.all('library');
  const lib = { modules: [], routines: [], codes: {}, circuits: {}, sources: [] };
  for (const it of items) {
    const d = it.data || {};
    if (Array.isArray(d.modules)) lib.modules.push(...d.modules.filter(m => m && typeof m === 'object'));
    if (Array.isArray(d.routines)) lib.routines.push(...d.routines.filter(m => m && typeof m === 'object'));
    if (d.codes && typeof d.codes === 'object') Object.assign(lib.codes, d.codes);
    if (d.circuits && typeof d.circuits === 'object') Object.assign(lib.circuits, d.circuits);
    lib.sources.push({ id: it.id, name: it.name, t: it.t });
  }
  addLibraryCodes(lib.codes); addLibraryCircuits(lib.circuits);
  app.lib = lib;
  return lib;
}

/* ---------------- one conversation with the car at a time ---------------- */
// Multi-step operations (full scan, module scan, clearing, services…) change the adapter's header
// and receive filters. Two of them at once — or live polling in the middle of one — would mix their
// requests and answers. Every such operation goes through here: a second one is refused with a
// clear message, live polling pauses until it ends, a lost link aborts it, and a stalled adapter
// can never leave the app stuck in "busy".
let lastElmActivity = Date.now();
bus.on('elmlog', () => { lastElmActivity = Date.now(); });
let liveTick = null; // the live-data poll in flight; an operation waits for it before starting
export async function exclusive(label, fn, { cancelable = false } = {}) {
  if (app.busy) throw new Error(`انتظر حتى ينتهي: ${app.busy.label}`);
  if (!app.conn.ready) throw new Error('غير متصل بالسيارة (أو شغّل الوضع التجريبي)');
  const job = { label, p: 0, t: '', since: Date.now(), lost: false, cancelled: false, cancelable };
  job.cancel = () => { job.cancelled = true; if (app.mods) app.mods.cancel = true; };
  app.busy = job; app.scanning = true; app.conn.pauseVolt = true;
  bus.emit('scan', { running: true, label });
  const release = () => {
    if (app.busy !== job) return;
    app.busy = null; app.scanning = false; app.conn.pauseVolt = liveRunning();
    bus.emit('scan', { running: false }); bus.emit('data');
  };
  const offConn = bus.on('conn', ({ state }) => { if (state !== 'on') { job.lost = true; if (app.mods) app.mods.cancel = true; } });
  lastElmActivity = Date.now();
  const wd = setInterval(() => {
    if (Date.now() - lastElmActivity < 45000 || app.busy !== job) return;
    job.lost = true; if (app.mods) app.mods.cancel = true;
    release();
    toast(`توقفت «${label}» لأن القطعة لم ترد منذ 45 ثانية — يمكنك المحاولة مرة أخرى`, 'warn');
  }, 5000);
  const progress = (p, t) => { job.p = p; if (t) job.t = t; if (app.busy === job) bus.emit('progress', job); };
  const alive = () => {
    if (job.cancelled) throw new Error('أُلغيت العملية — النتائج السابقة كما هي');
    if (job.lost || !app.conn.ready) throw new Error('انقطع الاتصال بالسيارة أثناء العملية — النتائج السابقة كما هي');
  };
  try {
    if (liveTick) await liveTick.catch(() => {});
    if (app.conn.elm?.dirty) await app.conn.elm.restoreState();
    return await fn(progress, alive);
  } finally {
    clearInterval(wd); offConn(); release();
  }
}

/* ---------------- connection ---------------- */
// Before a new connection (or a disconnect): stop polling, end the running operation (closing the
// link makes it fail fast and give back what it held) so nothing of it lands in the next session.
async function quiesce() {
  stopLive();
  if (app.busy) app.busy.cancel();
  if (app.conn.state !== 'off') await app.conn.close();
  for (const t0 = Date.now(); app.busy && Date.now() - t0 < 20000;) await sleep(100);
}
export async function connectBle(progress) {
  const sup = bleSupport(); if (!sup.ok) throw new Error(sup.why);
  const t = new BleTransport(settings().extraUuids || []);
  await t.request(); // the chooser comes first: cancelling it leaves everything as it was
  await quiesce();
  const wasDemo = app.demo;
  app.demo = false; bus.emit('demo', false);
  // a new connection is a new session: nothing read from the previous car (or a previous visit)
  // carries over; the car's saved details come back once its VIN is read
  if (wasDemo) resetVehicleState(); else resetScanState();
  return afterConnect(await app.conn.open(t, progress), progress);
}
export async function connectDemo(progress) {
  await quiesce();
  app.demo = true; bus.emit('demo', true);
  resetVehicleState();
  return afterConnect(await app.conn.open(new DemoTransport(), progress), progress);
}
export async function disconnect() {
  await quiesce();
  if (app.demo) { app.demo = false; resetVehicleState(); bus.emit('demo', false); }
  bus.emit('data');
}
function resetScanState() {
  app.session = (app.session || 0) + 1; // an operation from an older session never writes into this one
  app.ecus = new Map(); app.readiness = new Map(); app.freeze = new Map(); app.mode06 = null; app.mode09 = null; app.readyExtra = null;
  app.lastScan = null; app.live = new Map(); app.hist = new Map(); app.samples = []; app.pidSupport = new Map(); app.modulesScanned = false; app.scanNote = null; app.idents = null;
}
function resetVehicleState() { app.vehicle = {}; resetScanState(); }
async function afterConnect(ok, progress) {
  app.obd = new Obd(app.conn.elm); app.mods = new ModuleLayer(app.conn.elm);
  if (ok) {
    try {
      await exclusive('تهيئة الاتصال', async step => {
        step(0.2, 'اكتشاف الكمبيوترات التي ترد والقيم المدعومة…'); progress?.('اكتشاف الكمبيوترات التي ترد والقيم المدعومة…');
        await discoverStandard();
        step(0.6, 'قراءة رقم الهيكل (AutoVIN)…'); progress?.('قراءة رقم الهيكل (AutoVIN)…');
        await autoVin();
      });
    } catch (e) { progress?.('تنبيه: ' + e.message); }
  }
  bus.emit('data');
  return ok;
}
// Which standard (OBD) computers answer and which values each supports. prevMap: the computers
// known before — a fresh scan passes the old map and keeps only the names computers gave themselves.
export async function discoverStandard(prevMap = app.ecus) {
  const sup = await app.obd.discoverPids();
  if (!sup.size) throw new Error('لم يرد أي كمبيوتر على طلب OBD — تأكد أن السويتش على وضع التشغيل (ON) أو أن المكينة شغالة، ثم أعد المحاولة');
  app.pidSupport = sup;
  const elm = app.conn.elm;
  const fresh = prevMap !== app.ecus;
  for (const [ecu, set] of sup) {
    const n = stdEcuName(ecu, elm.isCan, elm.is29);
    const key = 'std:' + ecu;
    const old = prevMap.get(key) || {};
    const prev = fresh ? (old.nameFromEcu ? { name: old.name, conf: old.conf, nameFromEcu: true, ecuName: old.ecuName } : {}) : old;
    app.ecus.set(key, { ...prev, key, ecu, std: true, name: prev.nameFromEcu ? prev.name : n.name, conf: prev.nameFromEcu ? prev.conf : n.conf, addr: n.addr, req: n.req, res: n.res, pids: set, status: prev.status || 'ok' });
  }
  bus.emit('data');
}
// Stored / pending / permanent codes of every standard computer, from zero. A computer that does
// not answer the stored-codes request is marked as such instead of looking "clean".
async function readStdDtcs(step = () => {}, base = 0) {
  const std = [...app.ecus.values()].filter(e => e.std);
  const answered = new Map(std.map(e => [e.ecu, new Set()]));
  for (const e of std) { e.dtcs = { stored: [], pending: [], perm: [], mfr: e.dtcs?.mfr || [] }; e.readError = null; }
  const modes = [['03', 'stored', 'الأعطال المخزّنة'], ['07', 'pending', 'الأعطال المعلّقة'], ['0A', 'perm', 'الأعطال الدائمة']];
  let i = 0;
  for (const [mode, kind, label] of modes) {
    step(base + 0.08 * i++, `قراءة ${label} (Mode ${mode})…`);
    const r = await app.obd.readDtcs(mode);
    for (const [ecu, codes] of r.map) { const e = app.ecus.get('std:' + ecu); if (e) { e.dtcs[kind] = codes; answered.get(ecu)?.add(mode); } }
  }
  for (const e of std) if (!answered.get(e.ecu)?.has('03')) e.readError = 'لم يرد على طلب قراءة الأعطال المخزّنة (Mode 03) — النتيجة قد تكون ناقصة';
}

/* ---------------- vehicle identity ---------------- */
const WMI = { '1G1': 'Chevrolet', '1GC': 'Chevrolet (شاحنة)', '1GT': 'GMC (شاحنة)', '1GN': 'Chevrolet', '1GK': 'GMC', '1GY': 'Cadillac', '2GC': 'Chevrolet (كندا)', '2GT': 'GMC (كندا)', '3GC': 'Chevrolet (المكسيك)', '3GT': 'GMC (المكسيك)', '3GN': 'Chevrolet (المكسيك)', '1FT': 'Ford (شاحنة)', '1FA': 'Ford', '1FM': 'Ford', '1C4': 'Chrysler/Jeep', '1C6': 'Ram', '1J4': 'Jeep', '2T1': 'Toyota (كندا)', '4T1': 'Toyota (أمريكا)', '5TD': 'Toyota (أمريكا)', '5TF': 'Toyota (أمريكا)', JTD: 'Toyota', JTE: 'Toyota', JTM: 'Toyota', JTN: 'Toyota', JT2: 'Toyota', JN1: 'Nissan', JN8: 'Nissan', JHM: 'Honda', JHL: 'Honda', KMH: 'Hyundai', KNA: 'Kia', KND: 'Kia', WBA: 'BMW', WDD: 'Mercedes-Benz', WDB: 'Mercedes-Benz', WVW: 'Volkswagen', WAU: 'Audi', SAL: 'Land Rover', JM1: 'Mazda', JF1: 'Subaru', '5YJ': 'Tesla', MR0: 'Toyota (تايلند)', MHF: 'Toyota (إندونيسيا)', LVS: 'Ford (الصين)', '5NP': 'Hyundai (أمريكا)', '5XY': 'Kia (أمريكا)', '1N4': 'Nissan (أمريكا)', '1N6': 'Nissan (شاحنة)' };
const MAKE_GROUP = m => /Chevrolet|GMC|Cadillac|Buick/.test(m) ? 'GM' : /Ford/.test(m) ? 'Ford' : /Toyota|Lexus/.test(m) ? 'Toyota' : m.split(' ')[0];
export function decodeVin(vin) {
  vin = String(vin || '').toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
  if (vin.length !== 17) return { valid: false, vin };
  const map = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
  const w = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  let s = 0; for (let i = 0; i < 17; i++) s += (/\d/.test(vin[i]) ? +vin[i] : map[vin[i]]) * w[i];
  const cd = s % 11 === 10 ? 'X' : String(s % 11);
  const yc = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  const yi = yc.indexOf(vin[9]);
  let year = yi >= 0 ? 1980 + yi : null;
  // North-American convention: a letter in position 7 means the 2010–2039 cycle
  if (year && /[A-Z]/.test(vin[6]) && year + 30 <= new Date().getFullYear() + 1) year += 30;
  const make = WMI[vin.slice(0, 3)] || WMI[vin.slice(0, 2)] || null;
  return { valid: true, vin, checkOk: vin[8] === cd, make, group: make ? MAKE_GROUP(make) : null, year, wmi: vin.slice(0, 3), serial: vin.slice(11) };
}
const ACRO = { ECM: 'كمبيوتر المكينة', PCM: 'كمبيوتر المكينة والقير', TCM: 'كمبيوتر القير', HCU: 'كمبيوتر الهجين', HPCM: 'كمبيوتر الهجين', BCM: 'كمبيوتر الهيكل', ABS: 'كمبيوتر الفرامل', FICM: 'كمبيوتر البخاخات', GPCM: 'كمبيوتر شمعات التسخين', DPFC: 'كمبيوتر فلتر الجزيئات', BECM: 'كمبيوتر البطارية', FPCM: 'كمبيوتر طرمبة البنزين', TCCM: 'كمبيوتر علبة التوزيع (الدبل)', SCRC: 'كمبيوتر نظام SCR' };
export async function autoVin() {
  let vin = null;
  try {
    app.mode09 = await app.obd.mode09();
    for (const info of app.mode09.values()) if (info.vin && info.vin.length === 17) { vin = info.vin; break; }
    for (const [ecu, info] of app.mode09) {
      const e = app.ecus.get('std:' + ecu);
      if (!e || !info.ecuName) continue;
      e.ecuName = info.ecuName;
      // J1979 ECU name: "ACRO-Text" — the computer names itself, so this is reliable
      const acro = (info.ecuName.match(/^([A-Z0-9]{2,4})\s*-/) || [])[1];
      if (acro) { e.name = `${ACRO[acro] || 'كمبيوتر'} (${acro})`; e.conf = 'sure'; e.nameFromEcu = true; }
    }
  } catch (e) { console.warn(e); }
  if (vin) await adoptVin(vin);
  return vin;
}
// The VIN identifies the car: a different car starts with its own saved details (model, engine…),
// never with the previous car's.
async function adoptVin(vin) {
  if (app.vehicle.vin === vin) { setVehicle({ vin, source: 'auto' }); return; }
  let saved = null;
  try { saved = await withTimeout(store.get('vehicles', vin), 3000); } catch {}
  if (app.vehicle.vin) app.vehicle = {}; // another car was identified before
  if (saved && typeof saved === 'object') { const { id, t, vinInfo, ...rest } = saved; app.vehicle = { ...rest, ...app.vehicle }; }
  setVehicle({ vin, source: 'auto' });
}
export function setVehicle(v) {
  const d = v.vin ? decodeVin(v.vin) : {};
  app.vehicle = { ...app.vehicle, ...v, make: v.make || d.make || app.vehicle.make, year: v.year || d.year || app.vehicle.year, group: d.group || MAKE_GROUP(v.make || app.vehicle.make || '') || null, vinInfo: d.valid ? d : app.vehicle.vinInfo };
  store.put('vehicles', { id: app.vehicle.vin || 'manual:' + (app.vehicle.make || '') + (app.vehicle.year || ''), t: Date.now(), ...app.vehicle, vinInfo: undefined }).catch(() => {});
  bus.emit('data');
}

/* ---------------- full scan ---------------- */
const job_lost = e => /انقطع الاتصال|أُلغيت العملية/.test(e?.message || '');
// Every full scan starts from zero: nothing from the previous scan leaks into the new result.
// If it cannot finish (no answer, link lost, cancelled) the previous result is put back untouched.
export async function fullScan({ modules = true, fullRange = false } = {}) {
  return exclusive('الفحص الشامل', async (step, alive) => {
    const backup = { ecus: app.ecus, readiness: app.readiness, freeze: app.freeze, mode06: app.mode06, pidSupport: app.pidSupport, scanNote: app.scanNote, modulesScanned: app.modulesScanned };
    const session = app.session;
    try {
      app.ecus = new Map(); app.readiness = new Map(); app.freeze = new Map(); app.mode06 = null; app.scanNote = null; app.modulesScanned = false;
      step(0.03, 'اكتشاف الكمبيوترات القياسية…');
      await discoverStandard(backup.ecus); alive();
      if (!app.vehicle.vin) { step(0.08, 'قراءة رقم الهيكل…'); await autoVin(); alive(); }
      await readStdDtcs(step, 0.12); alive();
      step(0.38, 'قراءة الجاهزية (Readiness)…');
      app.readiness = await app.obd.readiness(); alive();
      step(0.45, 'قراءة لقطة الحظة (Freeze Frame)…');
      app.freeze = await app.obd.freezeFrame(); alive();
      step(0.52, 'قراءة نتائج الاختبارات الذاتية (Mode 6)…');
      try { app.mode06 = await app.obd.mode06(); } catch (e) { app.mode06 = { error: e.message, map: new Map() }; }
      alive();
      if (modules) {
        step(0.6, 'مسح الكمبيوترات الأخرى (طبقة المصنّع — أفضل جهد)…');
        await scanModules({ fullRange, progress: (p, t) => step(0.6 + p * 0.35, t) }); alive();
      }
      finalizeStatuses();
      // extra reads that belong to the scan while a session is recorded (who each computer is)
      if (app.afterScanHook) { try { await app.afterScanHook((p, t) => step(0.95 + p * 0.02, t), alive); } catch (e) { if (job_lost(e)) throw e; console.warn(e); } alive(); }
    } catch (e) {
      if (app.session === session) Object.assign(app, backup);
      try { await app.mods?.done(); } catch {}
      throw e;
    }
    if (app.session !== session) throw new Error('بدأ اتصال جديد أثناء الفحص — أعد الفحص');
    step(0.97, 'حفظ نتيجة الفحص…');
    const rec = snapshotScan();
    app.lastScan = rec;
    try { await withTimeout(store.put('scans', rec), 6000, 'انتهت مهلة التخزين'); } catch (e) { toast('اكتمل الفحص لكن تعذّر حفظه في السجل على هذا الجهاز: ' + e.message, 'warn'); }
    step(1, 'اكتمل الفحص');
    return rec;
  }, { cancelable: true });
}
export async function scanModules({ fullRange = false, progress = () => {} } = {}) {
  const group = app.vehicle.group;
  const ranges = RANGES.filter(r => fullRange || r.quick).filter(r => !r.makes || fullRange || !group || r.makes.includes(group));
  for (const extra of app.lib.modules.filter(m => m.req)) {
    const req = parseInt(extra.req, 16), res = parseInt(extra.res || '0', 16) || req + 8;
    if (!(req >= 0 && req <= 0x7ff) || ranges.some(r => req >= r.from && req <= r.to)) continue;
    ranges.push({ id: 'lib', from: req, to: req, off: res - req, conf: 'best' });
  }
  const r = await app.mods.scan(ranges, (p, t) => progress(p * 0.6, 'فحص العنوان ' + t));
  app.modulesScanned = true;
  app.scanNote = r.note || null;
  const found = r.found || [];
  let k = 0;
  for (const f of found) {
    if (app.mods.cancel) break;
    progress(0.6 + 0.4 * (k++ / Math.max(1, found.length)), `قراءة أعطال الكمبيوتر 0x${hex3(f.req)}…`);
    const std = [...app.ecus.values()].find(e => e.std && e.res === f.res);
    if (std) { std.ident = f.ident; std.mod = f; continue; } // same physical module as a standard responder
    const key = 'mod:' + hex3(f.req);
    const nm = moduleName(f, app.lib, app.vehicle.group);
    const e = { key, std: false, name: nm.name, conf: nm.conf, nameSrc: nm.src, addr: `0x${hex3(f.req)} → 0x${hex3(f.res)}`, req: f.req, res: f.res, mod: f, ident: f.ident, dtcs: { stored: [], pending: [], perm: [], mfr: [] } };
    const d = await app.mods.readDtcs(f);
    e.proto = d.proto; e.readError = d.error || null; e.dtcs.mfr = d.dtcs;
    app.ecus.set(key, e);
  }
  await app.mods.done();
}
// Map page: discover the other computers again from a clean list (the previous manufacturer-layer
// modules are dropped first, and come back if the scan is cancelled or fails).
export async function moduleScan(fullRange = false) {
  return exclusive(fullRange ? 'المسح الموسّع للكمبيوترات' : 'المسح السريع للكمبيوترات', async (step, alive) => {
    const backup = new Map(app.ecus), note = app.scanNote, session = app.session;
    try {
      step(0.02, 'اكتشاف الكمبيوترات القياسية…');
      await discoverStandard(); alive();
      for (const k of [...app.ecus.keys()]) if (k.startsWith('mod:')) app.ecus.delete(k);
      await scanModules({ fullRange, progress: step }); alive();
      finalizeStatuses();
    } catch (e) {
      if (app.session === session) { app.ecus = backup; app.scanNote = note; }
      try { await app.mods?.done(); } catch {}
      throw e;
    }
  }, { cancelable: true });
}
const U_EXPECT = { U0100: 'كمبيوتر المكينة', U0101: 'كمبيوتر القير', U0121: 'كمبيوتر الفرامل ABS', U0140: 'كمبيوتر الهيكل BCM', U0151: 'كمبيوتر الوسائد الهوائية', U0155: 'لوحة العدادات', U0164: 'كمبيوتر المكيف', U0168: 'وحدة منع السرقة' };
export function finalizeStatuses() {
  for (const e of app.ecus.values()) {
    if (e.status === 'noresp' && e.ghost) continue;
    const n = (e.dtcs?.stored?.length || 0) + (e.dtcs?.pending?.length || 0) + (e.dtcs?.perm?.length || 0) + (e.dtcs?.mfr?.length || 0);
    e.status = n ? 'fault' : e.readError ? 'partial' : 'ok';
  }
  // expected but silent modules (from U-codes)
  for (const k of [...app.ecus.keys()]) if (app.ecus.get(k).ghost) app.ecus.delete(k);
  const lost = new Set(app.allDtcs().map(d => d.code).filter(c => U_EXPECT[c]));
  for (const c of lost) app.ecus.set('ghost:' + c, { key: 'ghost:' + c, ghost: true, name: U_EXPECT[c], status: 'noresp', addr: 'متوقّع من الكود ' + c, conf: 'best', note: `كمبيوتر آخر سجّل الكود ${c} (فقد الاتصال) — إن ظهر هذا الكمبيوتر في المسح فالفقد كان متقطعًا.` });
  // unreachable networks
  for (const k of [...app.ecus.keys()]) if (k.startsWith('unreach:')) app.ecus.delete(k);
  if (app.vehicle.group === 'GM') app.ecus.set('unreach:swcan', { key: 'unreach:swcan', status: 'unreach', name: 'شبكة GMLAN منخفضة السرعة (طرف 1)', conf: 'best', note: 'سيارات GM تستخدم شبكة سلك واحد على الطرف 1 لبعض الكمبيوترات. محوّل ELM327 لا يصل لهذا الطرف، فالكمبيوترات عليها خارج الوصول.' });
  if (app.conn.elm && !app.conn.elm.isCan) app.ecus.set('unreach:legacy', { key: 'unreach:legacy', status: 'unreach', name: 'الكمبيوترات غير القياسية', conf: 'best', note: 'على البروتوكولات القديمة (غير CAN) تصل القطعة للكمبيوترات القياسية فقط.' });
  bus.emit('data');
}
export function snapshotScan() {
  const ecus = [...app.ecus.values()].map(e => ({ key: e.key, name: e.name, addr: e.addr, status: e.status, conf: e.conf, dtcs: e.dtcs || null, readError: e.readError || null, note: e.note || null }));
  const rd = [...app.readiness.entries()].map(([ecu, r]) => ({ ecu, ...r }));
  const ff = [...app.freeze.entries()].map(([ecu, f]) => ({ ecu, ...f }));
  const m6 = app.mode06?.map ? [...app.mode06.map.entries()].map(([ecu, rows]) => ({ ecu, rows })) : [];
  return {
    id: uid(), t: Date.now(), demo: app.demo, vehicle: { ...app.vehicle, vinInfo: undefined }, protocol: app.conn.elm?.info.protocolName, voltage: app.conn.voltage,
    ecus, readiness: rd, freeze: ff, mode06: m6, dtcs: app.allDtcs().map(d => ({ code: d.code, kind: d.kind, module: d.module, text: describeDtc(d.code).text })), live: app.liveValues(),
  };
}

/* ---------------- quick reads (each one is a single exclusive operation) ---------------- */
export const readStdCodes = () => exclusive('قراءة الأعطال', async (step, alive) => {
  step(0.05, 'اكتشاف الكمبيوترات القياسية…');
  await discoverStandard(); alive();
  await readStdDtcs(step, 0.2); alive();
  step(0.8, 'قراءة لقطة الحظة…');
  app.freeze = await app.obd.freezeFrame();
  finalizeStatuses();
  if (!app.lastScan) app.lastScan = { t: Date.now(), partial: true };
});
export const readFreeze = () => exclusive('قراءة لقطة الحظة', async () => { app.freeze = await app.obd.freezeFrame(); });
export const readMode06 = () => exclusive('قراءة نتائج Mode 6', async () => { try { app.mode06 = await app.obd.mode06(); } catch (e) { app.mode06 = { error: e.message, map: new Map() }; } });
export const readReadiness = () => exclusive('قراءة الجاهزية', async () => {
  app.readiness = await app.obd.readiness();
  const r = await app.obd.readPids([0x30, 0x31, 0x4e, 0x21]);
  app.readyExtra = [...r.values()];
});
export const readVinNow = () => exclusive('قراءة رقم الهيكل', () => autoVin());

/* ---------------- clearing ---------------- */
export async function clearStandard() {
  const r = await app.obd.clearAll();
  const ok = r.msgs.some(m => !m.neg && m.bytes[0] === (app.obd.uds ? 0x54 : 0x44));
  const neg = r.msgs.find(m => m.neg);
  return { ok, error: ok ? null : neg ? `رفض: NRC 0x${neg.nrc.toString(16)}` : r.error, responders: r.msgs.filter(m => !m.neg).map(m => m.ecu) };
}
export async function clearModule(e) {
  if (e.std) return clearStandard();
  const r = await app.mods.clearDtcs(e.mod, e.proto);
  await app.mods.done();
  return r;
}
export async function rereadModule(e) {
  if (e.std) await readStdDtcs();
  else { const d = await app.mods.readDtcs(e.mod); await app.mods.done(); e.dtcs.mfr = d.dtcs; e.readError = d.error || null; }
  finalizeStatuses();
}
// Clear, then read again to prove what really happened. Standard computers are cleared together by
// one Mode 04; after it, freeze frames and readiness are read again (the car resets them).
export async function clearVerified(list) {
  return exclusive('مسح الأعطال', async step => {
    const res = [];
    const hasStd = list.some(e => e.std), mods = list.filter(e => !e.std && e.mod);
    if (hasStd) { step(0.1, 'مسح الأعطال القياسية (Mode 04)…'); const s = await clearStandard(); res.push({ name: 'الكمبيوترات القياسية (Mode 04)', ok: s.ok, error: s.error }); }
    let k = 0;
    for (const e of mods) { step(0.2 + 0.4 * (k++ / mods.length), `مسح أعطال ${e.name}…`); const r = await clearModule(e); res.push({ name: e.name, ok: r.ok, error: r.error }); }
    step(0.7, 'إعادة القراءة للتأكد…');
    if (hasStd) {
      await readStdDtcs();
      if (res[0].ok) {
        app.mode06 = null;
        try { app.freeze = await app.obd.freezeFrame(); } catch { app.freeze = new Map(); }
        try { app.readiness = await app.obd.readiness(); } catch {}
      }
    }
    for (const e of mods) { const d = await app.mods.readDtcs(e.mod); e.dtcs.mfr = d.dtcs; e.readError = d.error || null; }
    if (mods.length) await app.mods.done();
    finalizeStatuses();
    return res;
  });
}
export const rereadVerified = e => exclusive('إعادة القراءة', () => rereadModule(e));

/* ---------------- live data polling ---------------- */
// One polling loop at a time. It pauses by itself while another operation owns the adapter or the
// link is being re-established, and resumes afterwards — so values never freeze after a reconnect.
let liveRun = null;
export function liveRunning() { return !!liveRun; }
export function liveToken() { return liveRun; }
export function startLive({ fast = [], slow = [], onTick = () => {}, rateMs = 0 } = {}) {
  stopLive();
  const token = { stop: false };
  liveRun = token;
  // while a session is being recorded, every poll also reads the car's other values now and then
  const all = [...new Set([...fast, ...slow, ...(app.liveExtra?.() || [])])];
  (async () => {
    let n = 0;
    while (!token.stop) {
      const st = app.conn.state;
      if (st === 'off' || st === 'err') break;
      if (!app.conn.ready || app.busy) { await sleep(400); continue; }
      const t0 = Date.now();
      const pids = n % 5 === 0 ? all : fast;
      const tick = (async () => {
        if (app.conn.elm?.dirty) await app.conn.elm.restoreState();
        const r = await app.obd.readPids(pids);
        if (token.stop) return;
        const now = Date.now();
        for (const v of r.values()) {
          app.live.set(`${v.ecu}:${v.pid}`, { ...v, t: now });
          if (v.value != null) {
            const k = `${v.ecu}:${v.pid}`; const h = app.hist.get(k) || []; h.push([now, v.value]); if (h.length > 600) h.splice(0, h.length - 600); app.hist.set(k, h);
          }
        }
        // manufacturer readings (e.g. GM Mode $22) while a session is recorded — a few per tick
        if (app.liveExtraRead && n % 3 === 1) {
          const ex = await app.liveExtraRead();
          if (token.stop) return;
          for (const e of ex) {
            app.live.set(e.key, { ...e, t: now });
            const h = app.hist.get(e.key) || []; h.push([now, e.value]); if (h.length > 600) h.splice(0, h.length - 600); app.hist.set(e.key, h);
          }
        }
        if (n % 3 === 0 && app.conn.elm?.info.caps.voltage) { const vv = await app.conn.elm.voltage(); if (vv != null) { app.conn.voltage = vv; bus.emit('volt', vv); } }
        const lv = app.liveValues();
        if (lv[0x0c] != null) app.samples.push({ t: now, rpm: lv[0x0c], stft1: lv[0x06], ltft1: lv[0x07], stft2: lv[0x08], ltft2: lv[0x09], maf: lv[0x10], load: lv[0x04], ect: lv[0x05], volt: app.conn.voltage, speed: lv[0x0d] });
        if (app.samples.length > 3000) app.samples.splice(0, 1000);
        onTick(r); bus.emit('live');
      })();
      liveTick = tick;
      try { await tick; } catch (e) { console.warn(e); await sleep(500); } finally { if (liveTick === tick) liveTick = null; }
      n++;
      // never spin: with nothing to read, poll (the voltage) once a second at most
      const gap = Math.max(rateMs, pids.length ? 0 : 1000), dt = Date.now() - t0;
      if (gap > dt) await sleep(gap - dt);
    }
    if (liveRun === token) liveRun = null;
  })();
  app.conn.pauseVolt = true;
  return token;
}
// token: stop only that loop (a timer from a page you already left must not stop the new page's loop)
export function stopLive(token) {
  if (token && token !== liveRun) { token.stop = true; return; }
  if (liveRun) liveRun.stop = true;
  liveRun = null; app.conn.pauseVolt = !!app.busy;
}

export function requireConn() {
  if (!app.conn.ready) { toast('اتصل بالسيارة أولًا (أو شغّل الوضع التجريبي)', 'warn'); return false; }
  return true;
}
export { decodeReadiness };
