// Session recorder: starts by itself with the first fault scan of a connection and records
// everything — every live value the car gives, the battery voltage, every code as it appears or
// disappears, every scan, operation, message, guided-test result and the adapter's own log — until
// the adapter is disconnected. Then it builds the full report. It is saved every 20 seconds, so a
// locked phone or a closed page still leaves a report up to the last moment.
import { bus, uid, keepAwake } from './util.js';
import { app, startLive, stopLive, liveRunning, liveToken, snapshotScan, vehDisplacement } from './core.js';
import { PIDS, pidName } from './obd.js';
import { store } from './store.js';
import { describeDtc } from './dtcdb.js';
import { analyze, analysisCtx, AREA } from './analyst.js';
import { readGmBatch, identify, gmPidInfo, resetGm, gmSupported } from './gm-enhanced.js';

let rec = null, tok = null, timers = [], offs = [], wake = null, dirty = false, pauseTimer = null;
const MAXLOG = 3000;
const KEY = [0x0c, 0x0d, 0x04, 0x05, 0x0b, 0x10, 0x11, 0x06, 0x07, 0x08, 0x09, 0x0e, 0x14, 0x15, 0x18, 0x19, 0x0f, 0x42, 0x49, 0x5c];
const SKIP = new Set([0x01, 0x02, 0x12, 0x13, 0x1c, 0x1d, 0x1e, 0x41, 0x4f, 0x50, 0x51]);
const dataPid = p => PIDS[p] && PIDS[p][3] && p % 0x20 !== 0 && !SKIP.has(p);
const r3 = v => Math.round(v * 1000) / 1000;
export const session = {
  get rec() { return rec; },
  active: () => !!rec,
  start: reason => start(reason),
  stop: reason => finalize(reason || 'أُنهي التسجيل يدويًا'),
  ownsPolling: () => !!tok && liveToken() === tok, // the live loop running now is the recorder's own
};

function ev(type, text, extra) { if (!rec) return; rec.events.push({ t: Date.now(), type, text, ...(extra || {}) }); dirty = true; }
// every value any computer announces (engine first), not only the engine computer's
const pidsToRecord = () => {
  const pe = app.primaryEcu?.(), all = new Set(app.pidSupport.get(pe) || []);
  for (const [ecu, set] of app.pidSupport) if (ecu !== pe) for (const p of set) all.add(p);
  return [...all].filter(dataPid);
};
const m09 = () => (app.mode09 ? [...app.mode09.entries()].map(([ecu, info]) => ({ ecu, ...info })) : []);

function start(reason = 'يدويًا') {
  if (rec || !app.conn.ready && app.conn.state !== 'adapter') return;
  rec = {
    id: uid(), t: Date.now(), status: 'open', demo: app.demo, vehicle: { ...app.vehicle, vinInfo: undefined },
    adapter: { name: app.conn.transport?.name || '', version: app.conn.elm?.info?.version || '', protocol: app.conn.elm?.info?.protocolName || '' },
    events: [], series: {}, volt: [], scans: [], codes: {}, verdicts: [], log: [], logCount: 0, logErr: {}, seen: {}, ops: 0,
  };
  ev('start', `بدأ التسجيل تلقائيًا — ${reason}`);
  if (app.conn.voltage) rec.volt.push([Date.now(), r3(app.conn.voltage)]);
  wake = keepAwake();
  // every live poll also reads the rest of the car's values now and then, so nothing is missed,
  // and on GM cars the manufacturer readings (oil pressure, transmission temperature, gear…)
  app.liveExtra = () => pidsToRecord();
  resetGm();
  if (app.vehicle.group === 'GM') app.liveExtraRead = () => readGmBatch(3);
  // each full scan of the session also reads who each computer is (part numbers, software, date)
  app.afterScanHook = async (step, alive) => { step(0, 'قراءة هوية الكمبيوترات…'); await identify(step, alive); };
  timers.push(setInterval(ensurePolling, 1500), setInterval(() => save(), 20000), setInterval(() => bus.emit('session', { state: 'rec' }), 1000));
  ensurePolling(); save();
  bus.emit('session', { state: 'rec' });
}
// With no page reading live data, the recorder reads every value itself.
function ensurePolling() {
  if (!rec || !app.conn.ready || app.busy || liveRunning()) return;
  const all = pidsToRecord(); if (!all.length) return;
  const fast = all.filter(p => KEY.includes(p)), slow = all.filter(p => !KEY.includes(p));
  tok = startLive({ fast: fast.length ? fast : all.slice(0, 8), slow });
}

/* ------------------------------ what it records ------------------------------ */
function onLive() {
  if (!rec) return;
  for (const [k, v] of app.live) {
    if (!v?.t || v.t <= (rec.seen[k] || 0)) continue;
    rec.seen[k] = v.t;
    const s = rec.series[k] ||= { pid: v.pid, ecu: v.ecu, name: v.gm ? v.name : pidName(v.pid), unit: v.unit || PIDS[v.pid]?.[1] || '', pts: [], text: v.value == null, ...(v.gm ? { gm: true, conf: v.conf, mod: v.mod } : {}) };
    const last = s.pts[s.pts.length - 1];
    if (v.value != null) { const x = r3(v.value); if (!last || last[1] !== x || v.t - last[0] >= 5000) s.pts.push([v.t, x]); }
    else if (v.text != null && (!last || last[1] !== v.text)) s.pts.push([v.t, String(v.text)]);
  }
  dirty = true;
}
function onVolt(v) {
  if (!rec || v == null) return;
  const last = rec.volt[rec.volt.length - 1], now = Date.now();
  if (!last || Math.abs(last[1] - v) >= 0.02 || now - last[0] >= 5000) rec.volt.push([now, r3(v)]);
  dirty = true;
}
function onData() {
  if (!rec || app.busy) return; // mid-operation the lists are being rebuilt
  rec.vehicle = { ...rec.vehicle, ...app.vehicle, vinInfo: undefined };
  const now = Date.now(), present = new Set();
  for (const d of app.allDtcs()) {
    present.add(d.code);
    const c = rec.codes[d.code] ||= { code: d.code, text: describeDtc(d.code).text, first: now, last: now, kinds: [], modules: [], present: false, gone: [] };
    if (!c.present) { ev('code', `${c.gone.length ? 'رجع' : 'ظهر'} الكود ${d.code} — ${c.text} (${d.module})`, { code: d.code, kind: 'bad' }); c.present = true; }
    c.last = now;
    if (!c.kinds.includes(d.kindLabel || d.kind)) c.kinds.push(d.kindLabel || d.kind);
    if (d.module && !c.modules.includes(d.module)) c.modules.push(d.module);
  }
  for (const c of Object.values(rec.codes)) if (c.present && !present.has(c.code)) { c.present = false; c.gone.push(now); ev('code', `اختفى الكود ${c.code} من السيارة`, { code: c.code, kind: 'ok' }); }
  dirty = true;
}
let opStart = null;
function onScan({ running, label }) {
  if (running) {
    // the recording starts with the first fault scan of the connection (any later operation is recorded too)
    if (!rec && app.conn.ready && /الفحص الشامل|قراءة الأعطال|للكمبيوترات/.test(label || '')) start(`مع «${label}»`);
    opStart = { label, t: Date.now() };
    ev('op', `بدأ: ${label}`);
    return;
  }
  if (!rec) return;
  const o = opStart; opStart = null;
  rec.ops++;
  ev('op', `انتهى: ${o?.label || 'عملية'}${o ? ` (${Math.round((Date.now() - o.t) / 1000)} ث)` : ''}`);
  if (app.lastScan && !rec.scans.some(s => s.t === app.lastScan.t)) {
    const s = app.lastScan;
    rec.scans.push({ t: s.t, dtcs: s.dtcs, ecus: s.ecus, readiness: s.readiness, freeze: s.freeze, mode06: s.mode06, voltage: s.voltage, protocol: s.protocol, mode09: m09() });
    ev('scan', `فحص شامل: ${s.dtcs.length} عطل · ${s.ecus.filter(e => !['noresp', 'unreach'].includes(e.status)).length} كمبيوتر يرد`);
    if (app.idents?.length && !rec.idents) { rec.idents = app.idents; ev('op', `قُرئت هوية ${app.idents.length} كمبيوتر`); }
  }
  setTimeout(onData, 50);
}
const CONN = { on: 'متصل', adapter: 'القطعة متصلة والسيارة لا ترد', reconnecting: 'انقطع الاتصال — إعادة محاولة', err: 'خطأ اتصال', off: 'فُصلت القطعة', connecting: 'جارٍ الاتصال' };
function onConn({ state, msg }) {
  if (!rec) return;
  ev('conn', `${CONN[state] || state}${msg && msg !== CONN[state] ? ' — ' + msg : ''}`, { kind: state === 'on' ? 'ok' : ['err', 'reconnecting'].includes(state) ? 'warn' : '' });
  if (state === 'reconnecting') { rec.status = 'paused'; save(); }
  if (state === 'on' && rec.status === 'paused') rec.status = 'open';
  if (state === 'off') finalize('فُصلت القطعة');
  if (state === 'err') finalize('انقطع الاتصال ولم يرجع');
}
function onLog() {
  if (!rec) return;
  const l = app.conn.elm?.log; const line = l?.[l.length - 1]; if (!line) return;
  rec.logCount++;
  rec.log.push([Date.now(), line]); if (rec.log.length > MAXLOG) rec.log.splice(0, rec.log.length - MAXLOG);
  const m = String(line).match(/NO DATA|STOPPED|CAN ERROR|BUFFER FULL|BUS INIT|UNABLE TO CONNECT|BUS BUSY|FB ERROR|DATA ERROR|\?$/);
  if (m) rec.logErr[m[0]] = (rec.logErr[m[0]] || 0) + 1;
}
function onToast({ msg, kind }) { if (rec && msg) ev('msg', msg, { kind: kind === 'err' ? 'bad' : kind === 'warn' ? 'warn' : kind === 'ok' ? 'ok' : '' }); }
function onVerdict(d) { if (!rec) return; rec.verdicts.push({ t: Date.now(), ...d }); ev('verdict', `نتيجة فحص «${d.title}»: ${d.verdict} (${AREA[d.area]?.[0] || ''})`, { kind: 'ok' }); }

/* ------------------------------ saving & the end ------------------------------ */
function plain(r) { const { seen, ...o } = r; return o; }
async function save(force = false) {
  if (!rec || (!dirty && !force)) return;
  dirty = false;
  try { await store.put('sessions', plain(rec)); } catch (e) { console.warn('session save', e); }
}
async function finalize(reason) {
  if (!rec) return;
  const r = rec; rec = null;
  timers.forEach(clearInterval); timers = []; clearTimeout(pauseTimer);
  app.liveExtra = null; app.liveExtraRead = null; app.afterScanHook = null;
  if (tok) { stopLive(tok); tok = null; }
  wake?.release(); wake = null;
  r.status = 'done'; r.tEnd = Date.now(); r.endedBy = reason;
  r.events.push({ t: r.tEnd, type: 'end', text: `انتهى التسجيل — ${reason}` });
  // the car's last known state, and the analysis of everything found (the app still holds it here)
  try {
    const snap = snapshotScan();
    r.final = { dtcs: snap.dtcs, ecus: snap.ecus, readiness: snap.readiness, freeze: snap.freeze, mode06: snap.mode06, voltage: snap.voltage, live: snap.live, mode09: m09() };
    if (!r.idents && app.idents) r.idents = app.idents;
    r.gmCount = gmSupported();
    r.trims = app.trims?.() || null;
    const a = analyze(analysisCtx(app, vehDisplacement()));
    r.analysis = { plat: a.plat?.title || null, mods: a.mods, shared: a.shared, items: a.items.map(it => ({ title: it.title, codes: it.codes, safety: !!it.safety, areas: it.areas, causes: it.causes.slice(0, 5).map(c => ({ area: c.area, t: c.t, p: c.p, why: c.why })), evidence: it.evidence, path: it.path, loc: it.loc })) };
  } catch (e) { console.warn('session final', e); }
  r.stats = computeStats(r);
  try { await store.put('sessions', plain(r)); } catch (e) { console.warn(e); }
  bus.emit('session', { state: 'done', id: r.id });
}
// A session that was still open when the page went away (phone locked, page closed) becomes a
// report of everything saved until then.
export async function recoverOpen() {
  let n = 0;
  for (const r of await store.all('sessions').catch(() => [])) {
    if (r.status === 'done') continue;
    r.status = 'done'; r.endedBy = 'انقطع التطبيق قبل الإنهاء (التقرير حتى آخر حفظ تلقائي)';
    const lastT = Math.max(r.t, ...r.events.map(e => e.t), ...Object.values(r.series || {}).map(s => s.pts.at(-1)?.[0] || 0), ...(r.volt || []).map(v => v[0]));
    r.tEnd = lastT; r.partial = true;
    r.events.push({ t: lastT, type: 'end', text: 'انتهى التسجيل — ' + r.endedBy });
    r.stats = computeStats(r);
    await store.put('sessions', r).catch(() => {});
    n++; bus.emit('session', { state: 'done', id: r.id, recovered: true });
  }
  return n;
}
export function initSession() {
  offs.push(bus.on('scan', onScan), bus.on('live', onLive), bus.on('volt', onVolt), bus.on('data', onData), bus.on('conn', onConn), bus.on('elmlog', onLog), bus.on('toast', onToast), bus.on('analyst', onVerdict));
  const flush = () => { if (rec) save(true); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
  recoverOpen();
}

/* ------------------------------ the numbers ------------------------------ */
const byPid = (r, pid) => { const all = Object.values(r.series || {}).filter(s => s.pid === pid && !s.text && s.pts.length); return all.find(s => s.ecu === '7E8') || all.sort((a, b) => b.pts.length - a.pts.length)[0] || null; };
function at(s, t) { // value of a series at time t (last point before t, within 15 s)
  if (!s) return null; let lo = 0, hi = s.pts.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s.pts[m][0] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 0 && t - s.pts[k][0] <= 15000 ? s.pts[k][1] : null;
}
export function computeStats(r) {
  const S = { dur: (r.tEnd || Date.now()) - r.t };
  const spd = byPid(r, 0x0d), rpm = byPid(r, 0x0c), ect = byPid(r, 0x05);
  let dist = 0, moving = 0, idle = 0, run = 0, hardA = 0, hardB = 0, maxSpd = 0, maxRpm = 0;
  if (spd) for (let i = 1; i < spd.pts.length; i++) {
    const [t0, v0] = spd.pts[i - 1], [t1, v1] = spd.pts[i], dt = (t1 - t0) / 1000;
    if (dt <= 0 || dt > 15) continue;
    dist += ((v0 + v1) / 2) * dt / 3600;
    if (v0 > 3) moving += dt;
    if (dt <= 3) { const a = (v1 - v0) / dt; if (a >= 12) hardA++; if (a <= -14) hardB++; }
  }
  if (spd) maxSpd = Math.max(0, ...spd.pts.map(p => p[1]));
  if (rpm) {
    maxRpm = Math.max(0, ...rpm.pts.map(p => p[1]));
    for (let i = 1; i < rpm.pts.length; i++) {
      const [t0, v0] = rpm.pts[i - 1], dt = (rpm.pts[i][0] - t0) / 1000; if (dt <= 0 || dt > 15) continue;
      if (v0 > 400) { run += dt; if ((at(spd, t0) ?? 0) < 3) idle += dt; }
    }
  }
  Object.assign(S, { dist, moving, idle, run, hardA, hardB, maxSpd, maxRpm, avgSpd: moving > 0 ? dist / (moving / 3600) : 0 });
  if (ect) { S.maxEct = Math.max(...ect.pts.map(p => p[1])); S.hotSec = 0; for (let i = 1; i < ect.pts.length; i++) { const dt = (ect.pts[i][0] - ect.pts[i - 1][0]) / 1000; if (dt > 0 && dt <= 15 && ect.pts[i - 1][1] > 108) S.hotSec += dt; } }
  const vRun = [], vOff = [];
  for (const [t, v] of r.volt || []) ((at(rpm, t) ?? 0) > 400 ? vRun : vOff).push(v);
  if (vRun.length) { S.vRunMin = Math.min(...vRun); S.vRunMax = Math.max(...vRun); }
  if (vOff.length) { S.vOffMin = Math.min(...vOff); S.vOffMax = Math.max(...vOff); }
  // every value: min / avg / max / last, and how much of the time it was outside its range
  S.series = Object.entries(r.series || {}).map(([k, s]) => {
    if (s.text) return { k, pid: s.pid, ecu: s.ecu, name: s.name, unit: s.unit, text: true, n: s.pts.length, values: [...new Set(s.pts.map(p => p[1]))].slice(0, 8), last: s.pts.at(-1)?.[1] };
    const v = s.pts.map(p => p[1]); if (!v.length) return null;
    const rg = PIDS[s.pid]?.[7] || (s.gm ? gmPidInfo(s.pid)?.rg : null); let bad = 0, warn = 0, n = 0;
    if (rg) for (const [t, x] of s.pts) {
      if (rg.when === 'running' && !((at(rpm, t) ?? 0) > 400)) continue;
      if (rg.when === 'warm' && !((at(ect, t) ?? 0) > 75)) continue;
      n++;
      if (x < rg.warn[0] || x > rg.warn[1]) bad++; else if (x < rg.ok[0] || x > rg.ok[1]) warn++;
    }
    return { k, pid: s.pid, ecu: s.ecu, name: s.name, unit: s.unit, gm: !!s.gm, conf: s.conf || null, n: v.length, min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, last: v[v.length - 1], judged: n, bad, warn, range: rg || null };
  }).filter(Boolean).sort((a, b) => (a.gm - b.gm) || (typeof a.pid === 'number' && typeof b.pid === 'number' ? a.pid - b.pid : String(a.pid).localeCompare(String(b.pid))));
  S.codes = Object.keys(r.codes || {}).length;
  return S;
}
