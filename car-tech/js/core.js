// Application state and high-level operations shared by all screens.
import { bus, uid, hex3, toast } from './util.js';
import { Connection } from './elm.js';
import { BleTransport, DemoTransport, bleSupport } from './transport.js';
import { Obd, stdEcuName, decodeReadiness, PIDS } from './obd.js';
import { ModuleLayer, RANGES, moduleName } from './network.js';
import { describeDtc, addLibraryCodes } from './dtcdb.js';
import { trimAnalysis, addLibraryCircuits } from './diag.js';
import { store, settings } from './store.js';

const KIND = { stored: 'مخزّن', pending: 'معلّق', perm: 'دائم', history: 'سابق' };

export const app = {
  conn: new Connection(), demo: false, obd: null, mods: null,
  vehicle: {}, ecus: new Map(), readiness: new Map(), freeze: new Map(), mode06: null, mode09: null,
  lastScan: null, scanning: false, live: new Map(), hist: new Map(), samples: [], lib: { modules: [], routines: [], codes: {}, circuits: {} },
  pidSupport: new Map(), modulesScanned: false,

  allDtcs() {
    const out = [];
    for (const e of this.ecus.values()) {
      for (const k of ['stored', 'pending', 'perm']) (e.dtcs?.[k] || []).forEach(code => out.push({ code, kind: k, kindLabel: KIND[k], module: e.name, key: e.key }));
      (e.dtcs?.mfr || []).forEach(d => out.push({ code: d.code, kind: d.kind, kindLabel: KIND[d.kind] || d.kind, module: e.name, key: e.key, mfr: true }));
    }
    return out;
  },
  readinessSummary() {
    if (!this.readiness.size) return null;
    const r = [...this.readiness.values()][0];
    const sup = r.mons.filter(m => m.sup), notReady = sup.filter(m => !m.ready);
    return `${sup.length - notReady.length}/${sup.length} جاهز${notReady.length ? ' — غير جاهز: ' + notReady.map(m => m.name).join('، ') : ''}${r.mil ? ' — لمبة المكينة مضاءة' : ''}`;
  },
  liveValues() {
    // only fresh readings count (a silent car must not look "running" from stale values)
    const o = {}, fresh = Date.now() - 6000, pe = this.primaryEcu();
    for (const v of this.live.values()) if (v.value != null && v.t > fresh && (o[v.pid] == null || v.ecu === pe)) o[v.pid] = v.value;
    return o;
  },
  liveSnapshot() { return [...this.live.values()].filter(v => v.value != null).slice(0, 30).map(v => ({ name: PIDS[v.pid]?.[0] || v.pid, text: v.text, unit: v.unit })); },
  primaryEcu() { const k = [...this.pidSupport.keys()].sort(); return k.includes('7E8') ? '7E8' : k[0]; },
  running() { const v = this.liveValues(); return (v[0x0c] || 0) > 400; },
  ctx() { const v = this.liveValues(); return { running: (v[0x0c] || 0) > 400, warm: (v[0x05] ?? 0) > 70 || (v[0x1f] || 0) > 600 }; },
  trims() { return trimAnalysis(this.samples.slice(-600)); },
};

/* ---------------- reference library ---------------- */
export async function loadLibrary() {
  const items = await store.all('library');
  const lib = { modules: [], routines: [], codes: {}, circuits: {}, sources: [] };
  for (const it of items) {
    const d = it.data || {};
    lib.modules.push(...(d.modules || [])); lib.routines.push(...(d.routines || []));
    Object.assign(lib.codes, d.codes || {}); Object.assign(lib.circuits, d.circuits || {});
    lib.sources.push({ id: it.id, name: it.name, t: it.t });
  }
  addLibraryCodes(lib.codes); addLibraryCircuits(lib.circuits);
  app.lib = lib;
  return lib;
}

/* ---------------- connection ---------------- */
export async function connectBle(progress) {
  const sup = bleSupport(); if (!sup.ok) throw new Error(sup.why);
  app.demo = false; bus.emit('demo', false);
  const t = new BleTransport(settings().extraUuids || []);
  await t.request();
  return afterConnect(await app.conn.open(t, progress), progress);
}
export async function connectDemo(progress) {
  if (app.conn.state !== 'off') await app.conn.close();
  app.demo = true; bus.emit('demo', true);
  resetVehicleState();
  return afterConnect(await app.conn.open(new DemoTransport(), progress), progress);
}
export async function disconnect() {
  stopLive();
  await app.conn.close();
  if (app.demo) { app.demo = false; resetVehicleState(); bus.emit('demo', false); }
  bus.emit('data');
}
function resetVehicleState() {
  app.vehicle = {}; app.ecus = new Map(); app.readiness = new Map(); app.freeze = new Map(); app.mode06 = null; app.mode09 = null;
  app.lastScan = null; app.live = new Map(); app.hist = new Map(); app.samples = []; app.pidSupport = new Map(); app.modulesScanned = false;
}
async function afterConnect(ok, progress) {
  app.obd = new Obd(app.conn.elm); app.mods = new ModuleLayer(app.conn.elm);
  if (ok) {
    progress?.('اكتشاف الكمبيوترات التي ترد والقيم المدعومة…');
    await discoverStandard();
    progress?.('قراءة رقم الهيكل (AutoVIN)…');
    await autoVin();
  }
  bus.emit('data');
  return ok;
}
export async function discoverStandard() {
  const sup = await app.obd.discoverPids();
  app.pidSupport = sup;
  const elm = app.conn.elm;
  for (const [ecu, set] of sup) {
    const n = stdEcuName(ecu, elm.isCan, elm.is29);
    const key = 'std:' + ecu;
    const prev = app.ecus.get(key) || {};
    app.ecus.set(key, { ...prev, key, ecu, std: true, name: prev.nameFromEcu ? prev.name : n.name, conf: prev.nameFromEcu ? prev.conf : n.conf, addr: n.addr, req: n.req, res: n.res, pids: set, status: prev.status || 'ok' });
  }
  bus.emit('data');
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
      const AR = { ECM: 'كمبيوتر المكينة', PCM: 'كمبيوتر المكينة والقير', TCM: 'كمبيوتر القير', HCU: 'كمبيوتر الهجين', BCM: 'كمبيوتر الهيكل', ABS: 'كمبيوتر الفرامل', FICM: 'كمبيوتر البخاخات', GPCM: 'كمبيوتر شمعات التسخين', DPFC: 'كمبيوتر فلتر الجزيئات', BECM: 'كمبيوتر البطارية' };
      if (acro) { e.name = `${AR[acro] || 'كمبيوتر'} (${acro})`; e.conf = 'sure'; e.nameFromEcu = true; }
    }
  } catch (e) { console.warn(e); }
  if (vin) setVehicle({ vin, source: 'auto' });
  return vin;
}
export function setVehicle(v) {
  const d = v.vin ? decodeVin(v.vin) : {};
  app.vehicle = { ...app.vehicle, ...v, make: v.make || d.make || app.vehicle.make, year: v.year || d.year || app.vehicle.year, group: d.group || MAKE_GROUP(v.make || app.vehicle.make || '') || null, vinInfo: d.valid ? d : app.vehicle.vinInfo };
  store.put('vehicles', { id: app.vehicle.vin || 'manual:' + (app.vehicle.make || '') + (app.vehicle.year || ''), t: Date.now(), ...app.vehicle });
  bus.emit('data');
}

/* ---------------- full scan ---------------- */
export async function fullScan({ modules = true, fullRange = false, progress = () => {} } = {}) {
  if (!app.conn.ready) throw new Error('غير متصل بالسيارة');
  if (app.scanning) throw new Error('يوجد فحص قيد التنفيذ');
  app.scanning = true; bus.emit('scan', { running: true });
  const steps = []; const step = (p, t) => { progress(p, t); };
  try {
    app.conn.pauseVolt = true;
    step(0.03, 'اكتشاف الكمبيوترات القياسية…');
    await discoverStandard();
    if (!app.vehicle.vin) { step(0.08, 'قراءة رقم الهيكل…'); await autoVin(); }
    const modes = [['03', 'stored', 'الأعطال المخزّنة'], ['07', 'pending', 'الأعطال المعلّقة'], ['0A', 'perm', 'الأعطال الدائمة']];
    for (const e of app.ecus.values()) if (e.std) e.dtcs = { stored: [], pending: [], perm: [], mfr: e.dtcs?.mfr || [] };
    let i = 0;
    for (const [mode, kind, label] of modes) {
      step(0.12 + 0.08 * i++, `قراءة ${label} (Mode ${mode})…`);
      const r = await app.obd.readDtcs(mode);
      for (const [ecu, codes] of r.map) {
        const e = app.ecus.get('std:' + ecu);
        if (e) e.dtcs[kind] = codes; else steps.push(`رد من ${ecu} غير معروف`);
      }
    }
    step(0.38, 'قراءة الجاهزية (Readiness)…');
    app.readiness = await app.obd.readiness();
    step(0.45, 'قراءة لقطة الحظة (Freeze Frame)…');
    app.freeze = await app.obd.freezeFrame();
    step(0.52, 'قراءة نتائج الاختبارات الذاتية (Mode 6)…');
    try { app.mode06 = await app.obd.mode06(); } catch (e) { app.mode06 = { error: e.message, map: new Map() }; }
    if (modules) {
      step(0.6, 'مسح الكمبيوترات الأخرى (طبقة المصنّع — أفضل جهد)…');
      await scanModules({ fullRange, progress: (p, t) => step(0.6 + p * 0.35, t) });
    }
    finalizeStatuses();
    step(0.97, 'حفظ نتيجة الفحص…');
    const rec = snapshotScan();
    await store.put('scans', rec);
    app.lastScan = rec;
    step(1, 'اكتمل الفحص');
    return rec;
  } finally {
    app.scanning = false; app.conn.pauseVolt = false; bus.emit('scan', { running: false }); bus.emit('data');
  }
}
export async function scanModules({ fullRange = false, progress = () => {} } = {}) {
  const group = app.vehicle.group;
  const ranges = RANGES.filter(r => fullRange || r.quick).filter(r => !r.makes || fullRange || !group || r.makes.includes(group));
  for (const extra of app.lib.modules.filter(m => m.req)) {
    const req = parseInt(extra.req, 16), res = parseInt(extra.res || '0', 16) || req + 8;
    if (!ranges.some(r => req >= r.from && req <= r.to)) ranges.push({ id: 'lib', from: req, to: req, off: res - req, conf: 'best' });
  }
  const r = await app.mods.scan(ranges, (p, t) => progress(p * 0.6, 'فحص العنوان ' + t));
  app.modulesScanned = true;
  app.scanNote = r.note || null;
  const found = r.found || [];
  let k = 0;
  for (const f of found) {
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

/* ---------------- clearing ---------------- */
export async function clearStandard() {
  const r = await app.obd.clearAll();
  const ok = r.msgs.some(m => !m.neg && m.bytes[0] === (app.obd.uds ? 0x54 : 0x44));
  const neg = r.msgs.find(m => m.neg);
  return { ok, error: ok ? null : neg ? `رفض: NRC 0x${neg.nrc.toString(16)}` : r.error, responders: r.msgs.filter(m => !m.neg).map(m => m.ecu) };
}
export async function clearModule(e) {
  if (e.std) {
    const r = await clearStandard();
    return r;
  }
  const r = await app.mods.clearDtcs(e.mod, e.proto);
  await app.mods.done();
  return r;
}
export async function rereadModule(e) {
  if (e.std) {
    for (const [mode, kind] of [['03', 'stored'], ['07', 'pending'], ['0A', 'perm']]) { const r = await app.obd.readDtcs(mode); e.dtcs[kind] = r.map.get(e.ecu) || []; }
  } else { const d = await app.mods.readDtcs(e.mod); await app.mods.done(); e.dtcs.mfr = d.dtcs; e.readError = d.error || null; }
  finalizeStatuses();
}

/* ---------------- live data polling ---------------- */
let liveRun = null;
export function liveRunning() { return !!liveRun; }
export function startLive({ fast = [], slow = [], onTick = () => {}, rateMs = 0 } = {}) {
  stopLive();
  const token = { stop: false };
  liveRun = token;
  (async () => {
    let n = 0;
    while (!token.stop && app.conn.ready) {
      const t0 = Date.now();
      const pids = n % 5 === 0 ? [...new Set([...fast, ...slow])] : fast;
      try {
        const r = await app.obd.readPids(pids);
        const now = Date.now();
        for (const v of r.values()) {
          app.live.set(`${v.ecu}:${v.pid}`, { ...v, t: now });
          if (v.value != null) {
            const k = `${v.ecu}:${v.pid}`; const h = app.hist.get(k) || []; h.push([now, v.value]); if (h.length > 600) h.splice(0, h.length - 600); app.hist.set(k, h);
          }
        }
        if (n % 3 === 0 && app.conn.elm.info.caps.voltage) { const vv = await app.conn.elm.voltage(); if (vv != null) { app.conn.voltage = vv; bus.emit('volt', vv); } }
        const lv = app.liveValues();
        if (lv[0x0c] != null) app.samples.push({ t: now, rpm: lv[0x0c], stft1: lv[0x06], ltft1: lv[0x07], stft2: lv[0x08], ltft2: lv[0x09], maf: lv[0x10], load: lv[0x04], ect: lv[0x05], volt: app.conn.voltage, speed: lv[0x0d] });
        if (app.samples.length > 3000) app.samples.splice(0, 1000);
        onTick(r); bus.emit('live');
      } catch (e) { console.warn(e); await new Promise(r => setTimeout(r, 500)); }
      n++;
      const dt = Date.now() - t0; if (rateMs > dt) await new Promise(r => setTimeout(r, rateMs - dt));
    }
    if (liveRun === token) liveRun = null;
  })();
  app.conn.pauseVolt = true;
  return token;
}
export function stopLive() { if (liveRun) liveRun.stop = true; liveRun = null; app.conn.pauseVolt = false; }

export function requireConn() {
  if (!app.conn.ready) { toast('اتصل بالسيارة أولًا (أو شغّل الوضع التجريبي)', 'warn'); return false; }
  return true;
}
export { decodeReadiness };
