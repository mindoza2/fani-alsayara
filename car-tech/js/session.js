// Session recorder: starts by itself with the first fault scan of a connection and records
// everything — every live value the car gives, the battery voltage, every code as it appears or
// disappears, every scan, operation, message, guided-test result and the adapter's own log — until
// the adapter is disconnected. Then it builds the full report. It is saved every 20 seconds, so a
// locked phone or a closed page still leaves a report up to the last moment.
import { bus, uid, keepAwake, toast, linreg } from './util.js';
import { app, startLive, stopLive, liveRunning, liveToken, snapshotScan, vehDisplacement, vehCylinders } from './core.js';
import { PIDS, pidName, chargeRange, combineReadiness, readinessStats } from './obd.js';
import { store } from './store.js';
import { describeDtc } from './dtcdb.js';
import { analyze, analysisCtx, AREA } from './analyst.js';
import { readGmBatch, identify, gmPidInfo, gmOrder, resetGm, gmSupported } from './gm-enhanced.js';

let rec = null, tok = null, timers = [], offs = [], wake = null, dirty = false, pauseTimer = null, beat = 0;
// the adapter's log: the first lines (connection, scan) are always kept, then the latest ones
const LOGHEAD = 2000, MAXLOG = 8000;
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
  // what the readings of the session being recorded say so far
  findings: () => { if (!rec) return []; try { return liveFindings({ ...rec, cyl: vehCylinders(), tEnd: Date.now() }); } catch { return []; } },
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
    events: [], series: {}, volt: [], scans: [], codes: {}, verdicts: [], logHead: [], log: [], logCount: 0, logErr: {}, seen: {}, ops: 0, gaps: [],
    voltFrozen: !!app.conn.voltFrozen,
  };
  ev('start', `بدأ التسجيل تلقائيًا — ${reason}`);
  if (app.conn.voltage) rec.volt.push([Date.now(), r3(app.conn.voltage), app.conn.voltSrc || 'adapter']);
  wake = keepAwake();
  if (!wake.supported) ev('msg', 'المتصفح ما يدعم قفل الشاشة مفتوحة رسميًا — شغّلنا الطريقة البديلة، وللأمان عطّل القفل التلقائي من إعدادات الجوال وقت الفحص (إذا انقفلت الشاشة تتوقف القراءة)', { kind: 'warn' });
  beat = Date.now();
  // every live poll also reads the rest of the car's values now and then, so nothing is missed,
  // and on GM cars the manufacturer readings (oil pressure, transmission temperature, gear…)
  app.liveExtra = () => pidsToRecord();
  resetGm();
  if (app.vehicle.group === 'GM') app.liveExtraRead = () => readGmBatch(3);
  // each full scan of the session also reads who each computer is (part numbers, software, date)
  app.afterScanHook = async (step, alive) => { step(0, 'قراءة هوية الكمبيوترات…'); await identify(step, alive); };
  timers.push(setInterval(ensurePolling, 1500), setInterval(() => save(), 20000), setInterval(heartbeat, 1000));
  ensurePolling(); save();
  bus.emit('session', { state: 'rec' });
}
// A page that was frozen (screen locked, browser in the background) shows up as a long gap
// between two beats: it is written down, so the report says where nothing could be read.
function heartbeat() {
  const now = Date.now();
  if (rec && now - beat > 8000) {
    const g = rec.gaps.at(-1);
    if (g && beat - g[1] < 2500) g[1] = now; else rec.gaps.push([beat, now]);
    dirty = true;
  }
  beat = now;
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
    const s = rec.series[k] ||= { pid: v.pid, ecu: v.ecu, name: v.gm ? v.name : v.pid === 0x42 ? 'فولت الكمبيوتر' : pidName(v.pid), unit: v.unit || PIDS[v.pid]?.[1] || '', pts: [], text: v.value == null, ...(v.gm ? { gm: true, conf: v.conf, mod: v.mod } : {}) };
    const last = s.pts[s.pts.length - 1];
    if (v.value != null) { const x = r3(v.value); if (!last || last[1] !== x || v.t - last[0] >= 5000) s.pts.push([v.t, x]); }
    else if (v.text != null && (!last || last[1] !== v.text)) s.pts.push([v.t, String(v.text)]);
  }
  dirty = true;
}
function onVolt(v) {
  if (!rec || v == null) return;
  const last = rec.volt[rec.volt.length - 1], now = Date.now();
  if (!last || Math.abs(last[1] - v) >= 0.02 || now - last[0] >= 5000 || last[2] !== app.conn.voltSrc) rec.volt.push([now, r3(v), app.conn.voltSrc || 'adapter']);
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
    if (app.idents?.length && !rec.idents) ev('op', `قُرئت هوية ${app.idents.length} كمبيوتر`);
    setTimeout(() => { if (rec && !app.busy) { snapState(rec); lastSnap = Date.now(); save(true); } }, 200);
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
  if (rec.logHead.length < LOGHEAD) rec.logHead.push([Date.now(), line]);
  else { rec.log.push([Date.now(), line]); if (rec.log.length > MAXLOG) rec.log.splice(0, rec.log.length - MAXLOG); }
  const m = String(line).match(/NO DATA|STOPPED|CAN ERROR|BUFFER FULL|BUS INIT|UNABLE TO CONNECT|BUS BUSY|FB ERROR|DATA ERROR|\?$/);
  if (m) { const k = m[0] === 'NO DATA' && app.busy ? 'NO DATA (أثناء المسح)' : m[0]; rec.logErr[k] = (rec.logErr[k] || 0) + 1; }
}
function onToast({ msg, kind }) { if (rec && msg) ev('msg', msg, { kind: kind === 'err' ? 'bad' : kind === 'warn' ? 'warn' : kind === 'ok' ? 'ok' : '' }); }
function onVerdict(d) { if (!rec) return; rec.verdicts.push({ t: Date.now(), ...d }); ev('verdict', `نتيجة فحص «${d.title}»: ${d.verdict} (${AREA[d.area]?.[0] || ''})`, { kind: 'ok' }); }

/* ------------------------------ saving & the end ------------------------------ */
function plain(r) { const { seen, ...o } = r; return o; }
// The car's latest state and the analysis of it, refreshed during the session: if the page dies,
// the report still has them.
function snapState(r) {
  try {
    const snap = snapshotScan();
    r.final = { dtcs: snap.dtcs, ecus: snap.ecus, readiness: snap.readiness, freeze: snap.freeze, mode06: snap.mode06, voltage: snap.voltage, live: snap.live, mode09: m09() };
    if (app.idents?.length) r.idents = app.idents;
    r.trims = app.trims?.() || r.trims || null;
    const a = analyze(analysisCtx(app, vehDisplacement()));
    r.analysis = { plat: a.plat?.title || null, mods: a.mods, shared: a.shared, items: a.items.map(it => ({ title: it.title, codes: it.codes, safety: !!it.safety, areas: it.areas, causes: it.causes.slice(0, 5).map(c => ({ area: c.area, t: c.t, p: c.p, why: c.why })), evidence: it.evidence, path: it.path, loc: it.loc })) };
    r.gmCount = gmSupported();
    r.cyl = vehCylinders();
    r.findings = liveFindings(r, computeStats(r));
  } catch (e) { console.warn('session snapshot', e); }
}
let lastSnap = 0;
async function save(force = false) {
  if (!rec || (!dirty && !force)) return;
  dirty = false;
  if (!app.busy && Date.now() - lastSnap > 30000) { lastSnap = Date.now(); snapState(rec); }
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
  snapState(r);
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
    try { r.findings = liveFindings(r, r.stats); } catch {}
    await store.put('sessions', r).catch(() => {});
    n++; bus.emit('session', { state: 'done', id: r.id, recovered: true });
  }
  return n;
}
export function initSession() {
  offs.push(bus.on('scan', onScan), bus.on('live', onLive), bus.on('volt', onVolt), bus.on('data', onData), bus.on('conn', onConn), bus.on('elmlog', onLog), bus.on('toast', onToast), bus.on('analyst', onVerdict),
    bus.on('voltsrc', d => { if (!rec || !d.frozen) return; rec.voltFrozen = true; ev('volt', `فولت القطعة ثابت على ${d.adapter.toFixed(1)}V ما يتغير، وكمبيوتر المكينة يقرا ${d.ecmMin.toFixed(2)}–${d.ecmMax.toFixed(2)}V — من الآن الفولت من كمبيوتر المكينة`, { kind: 'warn' }); }));
  const flush = () => { if (rec) save(true); };
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (!rec) return;
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); ev('vis', 'الصفحة راحت للخلفية أو الشاشة انقفلت', { kind: 'warn' }); flush(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
    ev('vis', `رجعت الصفحة${away ? ` بعد ${Math.round(away / 1000)} ث` : ''}`);
    if (away > 15000) toast(`القراءة وقفت ${Math.round(away / 60000) || '<1'} د لأن الشاشة انقفلت أو التطبيق راح للخلفية — خلّ الشاشة مفتوحة وBluefy قدّام لين تخلص`, 'warn');
  });
  window.addEventListener('pagehide', flush);
  recoverOpen();
}

/* ------------------------------ the numbers ------------------------------ */
const byPid = (r, pid, ecu) => { const all = Object.values(r.series || {}).filter(s => s.pid === pid && !s.text && s.pts.length && (!ecu || s.ecu === ecu)); return all.find(s => s.ecu === '7E8') || all.sort((a, b) => b.pts.length - a.pts.length)[0] || null; };
function at(s, t, win = 15000) { // value of a series at time t (last point before t, within 15 s)
  if (!s) return null; let lo = 0, hi = s.pts.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s.pts[m][0] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 0 && t - s.pts[k][0] <= win ? s.pts[k][1] : null;
}
const spanOf = v => v.length ? Math.max(...v) - Math.min(...v) : 0;
export function computeStats(r) {
  const S = { dur: (r.tEnd || Date.now()) - r.t };
  const spd = byPid(r, 0x0d), rpm = byPid(r, 0x0c), ect = byPid(r, 0x05), rt = byPid(r, 0x1f), dclr = byPid(r, 0x31);
  // where nothing was read: the page was frozen (screen locked, app in the background) or the link was down
  const gaps = (r.gaps || []).map(g => [...g]);
  if (rpm) for (let i = 1; i < rpm.pts.length; i++) if (rpm.pts[i][0] - rpm.pts[i - 1][0] > 20000) gaps.push([rpm.pts[i - 1][0], rpm.pts[i][0]]);
  gaps.sort((a, b) => a[0] - b[0]);
  const merged = []; for (const g of gaps) { const l = merged.at(-1); if (l && g[0] <= l[1] + 3000) l[1] = Math.max(l[1], g[1]); else merged.push(g); }
  S.gaps = merged.filter(g => g[1] - g[0] > 15000);
  S.gapTotal = S.gaps.reduce((a, g) => a + (g[1] - g[0]), 0);
  // the engine computer's own run-time counter tells whether the engine kept running across a gap
  const ranThrough = (a, b) => { if (!rt) return null; const v0 = at(rt, a, 30000), v1 = rt.pts.find(p => p[0] >= b)?.[1]; if (v0 == null || v1 == null) return null; const exp = (b - a) / 1000; return v1 - v0 >= exp * 0.75 - 5 && v1 - v0 <= exp * 1.25 + 10; };
  const stayed = (a, b) => { if (!dclr) return null; const v0 = at(dclr, a, 60000), v1 = dclr.pts.find(p => p[0] >= b)?.[1]; return v0 == null || v1 == null ? null : v1 - v0 < 1; };
  for (const g of S.gaps) { g[2] = ranThrough(g[0], g[1]); g[3] = stayed(g[0], g[1]); }
  let dist = 0, moving = 0, idle = 0, run = 0, hardA = 0, hardB = 0, maxSpd = 0, maxRpm = 0, idleGap = 0, runGap = 0;
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
  // a gap the engine ran through counts as running; as idling too when the car did not move
  for (const [a, b, ran, still] of S.gaps) if (ran) { runGap += (b - a) / 1000; if (still && (at(spd, a, 30000) ?? 0) < 3 && (spd?.pts.find(p => p[0] >= b)?.[1] ?? 0) < 3) idleGap += (b - a) / 1000; }
  Object.assign(S, { dist, moving, idle: idle + idleGap, run: run + runGap, runSeen: run, idleGap, runGap, hardA, hardB, maxSpd, maxRpm, avgSpd: moving > 0 ? dist / (moving / 3600) : 0 });
  if (rt) { S.rtFirst = rt.pts[0][1]; S.rtLast = rt.pts.at(-1)[1]; }
  if (ect) { S.maxEct = Math.max(...ect.pts.map(p => p[1])); S.hotSec = 0; for (let i = 1; i < ect.pts.length; i++) { const dt = (ect.pts[i][0] - ect.pts[i - 1][0]) / 1000; if (dt > 0 && dt <= 15 && ect.pts[i - 1][1] > 108) S.hotSec += dt; } }
  const engineOn = t => { const x = at(rpm, t); if (x != null) return x > 400; const g = S.gaps.find(g => t >= g[0] && t <= g[1]); return g && g[2] ? true : null; };
  // battery: the adapter's reading — unless it never moved while the engine computer's did
  const ecmV = byPid(r, 0x42, '7E8') || byPid(r, 0x42);
  const ad = (r.volt || []).filter(p => !p[2] || p[2] === 'adapter').map(p => p[1]);
  S.atrvFlat = r.voltFrozen || (ad.length >= 8 && spanOf(ad) < 0.05 && ecmV && spanOf(ecmV.pts.map(p => p[1])) >= 0.15) ? (ad.at(-1) ?? null) : null;
  const vsrc = S.atrvFlat != null && ecmV ? ecmV.pts.map(p => [p[0], p[1]]) : (r.volt || []).filter(p => !(S.atrvFlat != null && (!p[2] || p[2] === 'adapter')));
  S.vFrom = S.atrvFlat != null ? 'ecm' : 'adapter';
  const vRun = [], vOff = [];
  for (const [t, v] of vsrc) { const on = engineOn(t); if (on === true) vRun.push(v); else if (on === false) vOff.push(v); }
  if (vRun.length) { S.vRunMin = Math.min(...vRun); S.vRunMax = Math.max(...vRun); S.vRunAvg = vRun.reduce((a, b) => a + b, 0) / vRun.length; }
  if (vOff.length) { S.vOffMin = Math.min(...vOff); S.vOffMax = Math.max(...vOff); }
  // the engine computer's supply while running, and whether it sank over the session
  if (ecmV) {
    const P = ecmV.pts.filter(p => engineOn(p[0]) === true);
    if (P.length >= 5) {
      const v = P.map(p => p[1]);
      S.ecmV = { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length, ecu: ecmV.ecu };
      const span = (P.at(-1)[0] - P[0][0]) / 60000;
      if (span >= 8) { const lr = linreg(P.map(p => (p[0] - P[0][0]) / 600000), v); if (lr) { S.ecmV.slope10 = lr.slope; S.ecmV.spanMin = span; } }
      const first = P.filter(p => p[0] - P[0][0] < 120000).map(p => p[1]), last = P.filter(p => P.at(-1)[0] - p[0] < 120000).map(p => p[1]);
      S.ecmV.firstAvg = first.reduce((a, b) => a + b, 0) / first.length; S.ecmV.lastAvg = last.reduce((a, b) => a + b, 0) / last.length;
    }
  }
  // every value: min / avg / max / last, and how much of the time it was outside its range
  S.series = Object.entries(r.series || {}).map(([k, s]) => {
    if (s.text) return { k, pid: s.pid, ecu: s.ecu, name: s.name, unit: s.unit, text: true, n: s.pts.length, values: [...new Set(s.pts.map(p => p[1]))].slice(0, 8), last: s.pts.at(-1)?.[1] };
    const v = s.pts.map(p => p[1]); if (!v.length) return null;
    let rg = PIDS[s.pid]?.[7] || (s.gm ? gmPidInfo(s.pid)?.rg : null); let bad = 0, warn = 0, n = 0;
    if (s.pid === 0x42) { const cr = chargeRange(r.vehicle, s.ecu); rg = { ok: cr.ok, warn: cr.warn, when: 'running', rvc: cr.rvc }; }
    if (rg) for (const [t, x] of s.pts) {
      if (rg.when === 'running' && engineOn(t) !== true) continue;
      if (rg.when === 'warm' && !((at(ect, t) ?? 0) > 75)) continue;
      n++;
      if (x < rg.warn[0] || x > rg.warn[1]) bad++; else if (x < rg.ok[0] || x > rg.ok[1]) warn++;
    }
    return { k, pid: s.pid, ecu: s.ecu, name: s.name, unit: s.unit, gm: !!s.gm, conf: s.conf || null, n: v.length, min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, last: v[v.length - 1], judged: n, bad, warn, range: rg || null };
  }).filter(Boolean).sort((a, b) => (a.gm - b.gm) || (a.gm ? gmOrder(a.k) - gmOrder(b.k) || String(a.ecu).localeCompare(String(b.ecu)) : (a.pid - b.pid) || String(a.ecu).localeCompare(String(b.ecu))));
  S.codes = Object.keys(r.codes || {}).length;
  return S;
}

/* ------------------------------ what the readings say ------------------------------ */
// Findings from the recorded values themselves (no fault code needed): warm-up, charging, an
// adapter whose voltage is frozen, codes cleared a moment ago, misfire counts, gaps in the reading.
// [{ kind: 'bad'|'warn'|'info', area: 'mech'|'elec'|'soft'|'mod', t: title, d: details }]
export function liveFindings(r, S = computeStats(r)) {
  const out = [], ser = (pid, ecu) => byPid(r, pid, ecu);
  const n1 = v => v == null ? '—' : Number.isInteger(v) || Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1), n2 = v => v == null ? '—' : v.toFixed(2);
  const mins = sec => { const m = Math.floor(sec / 60), x = Math.round(sec % 60); return m ? `${m} د${x ? ` ${x} ث` : ''}` : `${x} ث`; };
  const runFor = S.rtLast ?? (S.run || 0);
  // 1. gaps
  if (S.gapTotal > 20000) {
    const rel = t => { const s = Math.round((t - r.t) / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    out.push({ kind: 'warn', area: null, t: `القراءة وقفت ${mins(S.gapTotal / 1000)} خلال الجلسة`, d: `${S.gaps.map(g => `من ${rel(g[0])} إلى ${rel(g[1])}${g[2] ? ' (المكينة كانت شغالة طوالها حسب عدّاد الكمبيوتر)' : ''}`).join('، ')} — الشاشة انقفلت أو Bluefy راح للخلفية أو انقطع البلوتوث. خلّ الشاشة مفتوحة وBluefy قدّام وعطّل القفل التلقائي وقت الفحص.` });
  }
  // 2. codes cleared a moment ago → "no faults" is not a verdict yet
  const dc = ser(0x31)?.pts.at(-1)?.[1], wu = ser(0x30)?.pts.at(-1)?.[1];
  const sc = (r.scans || []).at(-1) || r.final;
  const rd = (sc?.readiness || []).filter(x => x && Array.isArray(x.mons)), rs = rd.length ? readinessStats(combineReadiness(rd.map(x => [x.ecu, x]))) : null;
  if ((dc != null && dc <= 20) || (wu != null && wu <= 2)) out.push({ kind: 'warn', area: null, t: 'الأكواد ممسوحة من وقت قريب — «ما فيه أعطال» مو حكم نهائي', d: `المسافة منذ المسح ${dc ?? '—'} كم ودورات التسخين ${wu ?? '—'}${rs ? `؛ الجاهزية ${rs.ready} من ${rs.total}${rs.notReady.length ? ` (ما اكتملت: ${rs.notReady.map(x => x.name).join('، ')})` : ''}` : ''}. الكمبيوتر يعيد اختباراته مع المشاوير (خمول + سرعة ثابتة على الخط + تبريد ليلة)، وأي عطل حقيقي يرجع كود معلّق ثم مخزّن.` });
  // 3. warm-up: the engine ran long enough and the coolant never reached working temperature
  const ect = ser(0x05);
  if (ect && runFor >= 900 && S.maxEct != null && S.maxEct < 82) {
    const tEnd = ect.pts.at(-1)[0], tail = ect.pts.filter(p => tEnd - p[0] <= 180000).map(p => p[1]);
    const flat = tail.length >= 3 && spanOf(tail) <= 2.5;
    const oil = byPid(r, '221154'), oilT = oil?.pts.at(-1)?.[1], amb = ser(0x46)?.pts.at(-1)?.[1] ?? ser(0x0f)?.pts[0]?.[1];
    out.push({ kind: 'warn', area: 'mech', t: `حرارة المكينة ${flat ? 'ثبتت على' : 'ما تعدّت'} ${n1(S.maxEct)}°C وما وصلت حرارة التشغيل (حوالي 90°C)`, d: `المكينة شغالة من ${mins(runFor)}${amb != null ? ` والجو ${n1(amb)}°C` : ''}${flat ? ' والحرارة ثابتة آخر 3 دقائق' : ''} — الأرجح الثرموستات (بلف الحرارة) عالق مفتوح، والكمبيوتر يسجّل له P0128 مع الوقت.${oilT != null ? ` حرارة الزيت ${n1(oilT)}°C ${Math.abs(oilT - S.maxEct) <= 10 ? 'قريبة منها، يعني حساس الحرارة غالبًا صادق' : 'بعيدة عنها — افحص حساس حرارة الماء نفسه'}.` : ''} التأكيد: الخرطوم العلوي للرديتر يسخن بدري والمكينة لسا باردة = الثرموستات مفتوح.` });
  }
  // 4. the adapter's voltage never moved
  if (S.atrvFlat != null) out.push({ kind: 'info', area: 'elec', t: `فولت القطعة ثابت على ${n1(S.atrvFlat)} فولت طول الجلسة — القطعة ما تقيس الفولت فعليًا`, d: `كمبيوتر المكينة في نفس الوقت قرا ${S.ecmV ? `بين ${n2(S.ecmV.min)} و ${n2(S.ecmV.max)} فولت` : 'قيم تتغير'}. أرقام الشحن في هذا التقرير من كمبيوتر المكينة، وللدقة قِس بملتيميتر على أطراف البطارية.` });
  // 5. charging, from the engine computer
  if (S.ecmV) {
    const e = S.ecmV, rvc = chargeRange(r.vehicle, e.ecu).rvc, sink = e.slope10 != null && e.slope10 < -0.12 && e.lastAvg < e.firstAvg - 0.15;
    if (sink) out.push({ kind: 'bad', area: 'elec', t: `الفولت ينزل مع الوقت والمكينة شغالة (من ${n2(e.firstAvg)} إلى ${n2(e.lastAvg)} فولت)`, d: `خلال ${mins(e.spanMin * 60)} نزل تقريبًا ${n2(-e.slope10)} فولت كل 10 دقائق — الدينمو ما يغطي الأحمال: افحص سير الدينمو وأطرافه والأرضي، ثم الدينمو نفسه.` });
    else if (rvc) out.push({ kind: e.avg < 12.3 ? 'warn' : 'info', area: 'elec', t: `الشحن والمكينة شغالة: بين ${n2(e.min)} و ${n2(e.max)} فولت (متوسط ${n2(e.avg)}) حسب كمبيوتر المكينة`, d: `${e.avg < 12.3 ? 'أقل من المتوقع حتى لنظام RVC' : e.avg >= 13.4 ? 'الدينمو يشحن فعليًا (وضع الشحن في RVC: البطارية تتعبّى أو فيه أحمال شغالة)' : 'هذا وضع توفير الوقود في نظام RVC (من 12.5 إلى 13.1 فولت على البطارية، والكمبيوتر يقرا أقل بشوي)'}${e.lastAvg != null && e.firstAvg != null ? `؛ أول الجلسة ${n2(e.firstAvg)} وآخرها ${n2(e.lastAvg)} فولت` : ''}. الحكم الحقيقي باختبار الأحمال: شغّل الأنوار العالية والمروحة على الأعلى ومزيل الضباب 20 ثانية — لازم يرتفع بين 13.9 و 14.5 فولت.` });
    else if (e.avg < 13.2) out.push({ kind: 'bad', area: 'elec', t: `الشحن ضعيف: متوسط ${n2(e.avg)} فولت والمكينة شغالة`, d: 'المتوقع من 13.5 إلى 14.8 فولت. افحص سير الدينمو وأطرافه والأرضي ثم الدينمو.' });
  }
  // 6. misfire counters (GM) — small numbers at idle are normal, a growing one points at a cylinder
  const mis = Object.values(r.series || {}).filter(x => x.gm && /احتراق ناقص/.test(x.name) && x.pts.length).map(x => ({ cyl: +(x.name.match(/سلندر (\d+)/) || [])[1], hist: /سجل/.test(x.name), max: Math.max(...x.pts.map(p => p[1])), first: x.pts[0][1], last: x.pts.at(-1)[1] })).filter(x => x.cyl && (!r.cyl || x.cyl <= r.cyl));
  const hits = mis.filter(x => x.max > 0);
  if (hits.length) {
    const worst = hits.reduce((a, b) => (b.max > a.max ? b : a));
    const big = hits.some(x => x.hist ? x.last - x.first >= 20 : x.max >= 10);
    out.push({ kind: big ? 'warn' : 'info', area: 'mech', t: `عدّات احتراق ناقص: ${[...new Set(hits.map(x => x.cyl))].sort((a, b) => a - b).map(c => `سلندر ${c}`).join('، ')}`, d: `${hits.map(x => `${x.hist ? 'السجل' : 'الحالي'} سلندر ${x.cyl}: ${x.max}`).join(' · ')} — ${big ? `رقم يكبر على سلندر ${worst.cyl}: بدّل الكويل/البوجي بين السلندرات وشوف هل العدّ ينتقل معه.` : 'أرقام بسيطة على الخمول تُعتبر طبيعية ما دام ما ظهر كود P030x ولا تزيد.'}` });
  } else if (mis.length) out.push({ kind: 'info', area: 'mech', t: 'ما فيه احتراق ناقص', d: `عدّات الاحتراق الناقص صفر على ${new Set(mis.map(x => x.cyl)).size} سلندر.` });
  return out;
}
