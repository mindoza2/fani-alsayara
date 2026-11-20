// Transports: real Web Bluetooth (any ELM327-style BLE adapter) and a demo adapter
// that speaks the same ELM327 text protocol, so the demo runs through the exact same code.
import { sleep, hex2, hex3 } from './util.js';

// Reference adapters (known, tested values) — used to rank candidates, never as the only option.
export const BLE_REFERENCE = [
  { svc: 'fff0', write: 'fff2', notify: 'fff1', name: 'KONNWEI KDIAG (مُختبَر)', tested: true },
  { svc: 'ffe0', write: 'ffe1', notify: 'ffe1', name: 'وحدات HM-10 / CC2541' },
  { svc: '18f0', write: '2af1', notify: '2af0', name: 'Vgate / OBDLink CX' },
  { svc: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', name: 'Vgate iCar Pro' },
  { svc: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', name: 'Nordic UART' },
  { svc: '0000fff0-0000-1000-8000-00805f9b34fb', name: 'FFF0 (كامل)' },
  { svc: 'ffe5', name: 'FFE5' }, { svc: 'fee7', name: 'FEE7' }, { svc: 'ae30', name: 'AE30' },
  { svc: '49535343-fe7d-4ae5-8fa9-9fafd205e455', name: 'Microchip ISSC' },
];
const full = u => {
  u = String(u).toLowerCase().trim();
  if (/^[0-9a-f]{4}$/.test(u)) return `0000${u}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(u)) return `${u}-0000-1000-8000-00805f9b34fb`;
  return u;
};
const short = u => { const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(u); return m ? m[1] : u; };

export function bleSupport() {
  if (!('bluetooth' in navigator)) return { ok: false, why: 'هذا المتصفح لا يدعم Web Bluetooth. على آيفون استخدم متصفح Bluefy (أو إضافة تدعمه في سفاري)، وعلى ويندوز/أندرويد استخدم Chrome أو Edge.' };
  if (!window.isSecureContext) return { ok: false, why: 'Web Bluetooth يحتاج فتح البرنامج عبر https أو localhost.' };
  return { ok: true };
}

export class BleTransport {
  constructor(extraServices = []) {
    this.kind = 'ble';
    this.extra = extraServices;
    this.onData = () => {}; this.onDisconnect = () => {};
    this.device = null; this.wr = null; this.nt = null; this.discovered = []; this.chosen = null;
    this.chunk = 20; this._dec = new TextDecoder();
    this._handler = e => this.onData(this._dec.decode(e.target.value));
  }
  get name() { return this.device?.name || 'محوّل BLE'; }
  async request() {
    const optionalServices = [...new Set([...BLE_REFERENCE.map(r => full(r.svc)), ...this.extra.map(full)])];
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
    this.device.addEventListener('gattserverdisconnected', () => { this.wr = this.nt = null; this.onDisconnect(); });
  }
  async connect(log = () => {}) {
    if (!this.device) await this.request();
    log(`الاتصال بـ ${this.name}…`);
    const server = await this.device.gatt.connect();
    let services = [];
    try { services = await server.getPrimaryServices(); } catch (e) { log('لم تُرجع القطعة قائمة خدمات: ' + e.message); }
    // Discover characteristics dynamically and choose by properties
    const cands = [];
    this.discovered = [];
    for (const s of services) {
      let chars = [];
      try { chars = await s.getCharacteristics(); } catch { continue; }
      const sv = { uuid: short(s.uuid), chars: chars.map(c => ({ uuid: short(c.uuid), p: Object.entries(c.properties).filter(([, v]) => v === true).map(([k]) => k) })) };
      this.discovered.push(sv);
      const writers = chars.filter(c => c.properties.writeWithoutResponse || c.properties.write);
      const notifiers = chars.filter(c => c.properties.notify || c.properties.indicate);
      for (const w of writers) for (const n of notifiers) {
        let score = 0;
        if (w.properties.writeWithoutResponse) score += 3;
        if (n.properties.notify) score += 2;
        const ref = BLE_REFERENCE.find(r => full(r.svc) === s.uuid);
        if (ref) score += 4;
        if (ref?.write && full(ref.write) === w.uuid) score += 3;
        if (ref?.notify && full(ref.notify) === n.uuid) score += 3;
        if (/^0000180[0-9a]/.test(s.uuid)) score -= 20; // generic GAP/GATT/battery/device info
        cands.push({ s, w, n, score, ref });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    if (!cands.length) throw new Error('لم أجد في القطعة خاصيتَي كتابة وإشعار مناسبتين. إن كانت قطعتك تستخدم خدمة غير شائعة أضف رقمها (UUID) من الإعدادات ثم أعد المحاولة.');
    const c = cands[0];
    this.wr = c.w; this.nt = c.n;
    this.chosen = { service: short(c.s.uuid), write: short(c.w.uuid), notify: short(c.n.uuid), ref: c.ref?.name || null, withoutResponse: !!c.w.properties.writeWithoutResponse };
    await this.nt.startNotifications();
    this.nt.addEventListener('characteristicvaluechanged', this._handler);
    log(`خدمة ${this.chosen.service} · كتابة ${this.chosen.write} · إشعار ${this.chosen.notify}${c.ref ? ' (' + c.ref.name + ')' : ''}`);
    return this.chosen;
  }
  get connected() { return !!(this.device?.gatt?.connected && this.wr); }
  async write(text) {
    if (!this.wr) throw new Error('القطعة غير متصلة');
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += this.chunk) {
      const part = bytes.slice(i, i + this.chunk);
      if (this.chosen.withoutResponse && this.wr.writeValueWithoutResponse) await this.wr.writeValueWithoutResponse(part);
      else if (this.wr.writeValueWithResponse) await this.wr.writeValueWithResponse(part);
      else await this.wr.writeValue(part);
    }
  }
  async reconnect(log) { if (!this.device) throw new Error('لا توجد قطعة سابقة'); return this.connect(log); }
  async close() {
    try { this.nt?.removeEventListener('characteristicvaluechanged', this._handler); } catch {}
    const d = this.device; this.device = null;
    try { d?.gatt?.disconnect(); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* Demo adapter: an ELM327 v1.5 on a CAN 11-bit/500k pickup truck.     */
/* All data here is SAMPLE data, and the UI says so whenever it's on.  */
/* ------------------------------------------------------------------ */
function vinCheck(v) {
  const map = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
  const w = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  let s = 0; for (let i = 0; i < 17; i++) { const c = v[i]; s += (/\d/.test(c) ? +c : map[c] || 0) * w[i]; }
  const r = s % 11; return r === 10 ? 'X' : String(r);
}
const DEMO_VIN = (() => { const v = '1GTR2VE70CZ104235'; return v.slice(0, 8) + vinCheck(v) + v.slice(9); })();
const asc = s => [...s].map(c => c.charCodeAt(0));
const pidBitmap = (list, base) => { const b = [0, 0, 0, 0]; list.forEach(p => { const i = p - base - 1; if (i >= 0 && i < 32) b[i >> 3] |= 0x80 >> (i & 7); }); return b; };
const dtcBytes = code => { const t = 'PCBU'.indexOf(code[0]); const n = parseInt(code.slice(1), 16); return [(t << 6) | (n >> 8), n & 0xff]; };

export class DemoTransport {
  constructor() {
    this.kind = 'demo'; this.onData = () => {}; this.onDisconnect = () => {};
    this.connected = false; this.chosen = { service: 'demo', write: 'demo', notify: 'demo', ref: 'محوّل تجريبي' };
    this.s = { echo: true, headers: false, spaces: true, header: 0x7df, proto: 0, t0: Date.now() };
    this.engine = 'idle'; this.crankUntil = 0; this.rpmTarget = 700;
    this.dtc = { stored: ['P0171', 'P0174'], pending: ['P0300'], perm: ['P0171'] };
    this.modDtc = { 0x641: [], 0x643: [['U0140', 0x00, 0x08]], 0x647: [['B0081', 0x00, 0x09]] };
    this.cleared = Date.now() - 86400e3 * 9;
  }
  get name() { return 'محوّل تجريبي (ELM327 v1.5)'; }
  async connect(log = () => {}) { log('تشغيل المحوّل التجريبي…'); await sleep(250); this.connected = true; return this.chosen; }
  async reconnect(log) { return this.connect(log); }
  async close() { this.connected = false; }
  // demo-only hooks used by guided tests in demo mode
  setEngine(state) { this.engine = state; }
  crank() { this.crankUntil = Date.now() + 1800; setTimeout(() => (this.engine = 'idle'), 1900); }
  setRpm(r) { this.rpmTarget = r; }

  async write(text) {
    const cmds = text.split('\r').map(c => c.trim()).filter(Boolean);
    for (const c of cmds) {
      await sleep(25 + Math.random() * 35);
      const out = this.handle(c.toUpperCase().replace(/\s+/g, ''));
      const echo = this.s.echo ? c + '\r' : '';
      this.onData(echo + out + '\r\r>');
    }
  }
  // live values ----------------------------------------------------------
  live() {
    const t = (Date.now() - this.s.t0) / 1000;
    const cranking = Date.now() < this.crankUntil;
    const running = this.engine !== 'off' && !cranking;
    const target = this.engine === 'off' ? 0 : cranking ? 180 : this.rpmTarget;
    this._rpm = this._rpm == null ? target : this._rpm + (target - this._rpm) * 0.25;
    const rpm = Math.max(0, this._rpm + (running ? Math.sin(t * 3) * 15 + (Math.random() - .5) * 20 : 0));
    const hi = Math.min(1, Math.max(0, (rpm - 700) / 2300));
    const ect = Math.min(93, 70 + t * 0.4) + Math.sin(t / 7);
    return {
      rpm, running, cranking,
      speed: this.driving && running ? 62 + Math.sin(t / 5) * 4 : 0,
      ect, iat: 34 + Math.sin(t / 30) * 2, load: running ? 22 + hi * 30 + Math.random() * 2 : 0,
      map: running ? 33 + hi * 25 : 101, maf: running ? 5.2 + hi * 18 + Math.random() * .3 : 0,
      tps: running ? 15 + hi * 14 : 15, stft1: running ? 5 - hi * 4 + Math.sin(t * 2) * 3 : 0, stft2: running ? 4 - hi * 3 + Math.cos(t * 2) * 3 : 0,
      ltft1: running ? 14 - hi * 9 : 0, ltft2: running ? 13 - hi * 8.5 : 0, timing: running ? 14 + hi * 18 : 0,
      o2: i => running ? 0.45 + Math.sin(t * (4 + i)) * 0.38 : 0.1,
      o2s2: running ? 0.68 + Math.sin(t / 4) * 0.03 : 0.1,
      volt: cranking ? 9.9 + Math.random() * .4 : running ? 14.2 + Math.sin(t / 9) * .1 : 12.55,
      fuel: 63, baro: 101, amb: 31, run: running ? Math.floor(t) : 0, cat: running ? 520 + hi * 160 : 60,
      oil: Math.min(98, 60 + t * .35),
    };
  }
  // ELM command handling -------------------------------------------------
  handle(c) {
    if (c.startsWith('AT')) return this.at(c.slice(2));
    if (c.startsWith('ST')) return '?';
    if (!/^[0-9A-F]+$/.test(c) || c.length % 2) return '?';
    const req = c.match(/../g).map(x => parseInt(x, 16));
    if (!this.s.proto) { this.s.proto = 6; return 'SEARCHING...\r' + this.reply(req); }
    return this.reply(req);
  }
  at(a) {
    const s = this.s;
    if (a === 'Z' || a === 'WS') { Object.assign(s, { echo: true, headers: false, spaces: true, header: 0x7df, proto: 0 }); return '\rELM327 v1.5'; }
    if (a === 'I') return 'ELM327 v1.5';
    if (a === '@1') return 'OBDII to RS232 Interpreter';
    if (a === 'RV') return this.live().volt.toFixed(1) + 'V';
    if (a === 'DPN') return s.proto ? 'A' + s.proto : 'A0';
    if (a === 'DP') return s.proto ? 'AUTO, ISO 15765-4 (CAN 11/500)' : 'AUTO';
    if (/^E[01]$/.test(a)) { s.echo = a[1] === '1'; return 'OK'; }
    if (/^H[01]$/.test(a)) { s.headers = a[1] === '1'; return 'OK'; }
    if (/^S[01]$/.test(a)) { s.spaces = a[1] === '1'; return 'OK'; }
    if (a.startsWith('SH')) { s.header = parseInt(a.slice(2), 16); return 'OK'; }
    if (a.startsWith('SP') || a.startsWith('TP')) { const p = a.slice(2).replace('A', ''); s.proto = p === '0' ? 0 : parseInt(p, 16) === 6 ? 6 : -1; return 'OK'; }
    if (a === 'PPS' || a.startsWith('KW') || a.startsWith('MA')) return '?';
    if (/^(L[01]|AT\d|ST[0-9A-F]{2}|CAF[01]|CRA.*|CF.*|CM.*|FC.*|AR|D|D[01]|M[01]|CP.*|CEA.*|R[01]|AL|NL|BI|PC)$/.test(a)) return 'OK';
    return '?';
  }
  // Which simulated modules answer this header?
  targets() {
    const h = this.s.header;
    if (h === 0x7df) return [0x7e8, 0x7ea];
    if (h >= 0x7e0 && h <= 0x7e7) return [0x7e8, 0x7ea].includes(h + 8) ? [h + 8] : [];
    if ([0x241, 0x243, 0x247].includes(h)) return [h + 0x400];
    return [];
  }
  reply(req) {
    if (this.s.proto === -1) return 'UNABLE TO CONNECT';
    if (this.engine === 'off' && Date.now() < this.crankUntil) return 'BUS ERROR';
    const outs = [];
    for (const id of this.targets()) {
      const p = this.payload(id, req);
      if (p) outs.push(...this.frames(id, p));
    }
    return outs.length ? outs.join('\r') : 'NO DATA';
  }
  frames(id, p) {
    const f = [];
    if (p.length <= 7) f.push([p.length, ...p]);
    else {
      f.push([0x10 | (p.length >> 8), p.length & 0xff, ...p.slice(0, 6)]);
      let seq = 1;
      for (let i = 6; i < p.length; i += 7) { f.push([0x20 | (seq & 15), ...p.slice(i, i + 7)]); seq++; }
    }
    const sp = this.s.spaces ? ' ' : '';
    return f.map(fr => {
      while (fr.length < 8) fr.push(0xaa);
      const body = fr.map(hex2).join(sp);
      if (this.s.headers) return hex3(id) + sp + body;
      return body;
    });
  }
  payload(id, req) {
    const L = this.live(); const sid = req[0];
    if (id === 0x7e8 || id === 0x7ea) return this.obd(id, req, L);
    // manufacturer modules speak UDS here
    const mods = this.modDtc[id];
    const neg = nrc => [0x7f, sid, nrc];
    switch (sid) {
      case 0x3e: return [0x7e, req[1] ?? 0];
      case 0x10: return req[1] ? [0x50, req[1], 0, 0x32, 0x01, 0xf4] : neg(0x13);
      case 0x19: {
        if (req[1] !== 0x02) return neg(0x12);
        if (req.length < 3) return neg(0x13);
        const out = [0x59, 0x02, 0xff];
        mods.forEach(([code, ftb, st]) => { if (st & req[2]) out.push(...dtcBytes(code), ftb, st); });
        return out;
      }
      case 0x14: if (req.length < 4) return neg(0x13); this.modDtc[id] = []; return [0x54];
      case 0x22: {
        const did = (req[1] << 8) | req[2];
        if (did === 0xf190 && id === 0x641) return [0x62, 0xf1, 0x90, ...asc(DEMO_VIN)];
        if (did === 0xf18c) return [0x62, 0xf1, 0x8c, ...asc('SN' + hex3(id) + '7731')];
        if (did === 0xf195) return [0x62, 0xf1, 0x95, ...asc('SW 24.11')];
        if (did === 0x4001 && id === 0x641) return [0x62, 0x40, 0x01, 0x03, 0xe8];
        return neg(0x31);
      }
      case 0x27: return req[1] === 1 ? [0x67, 0x01, 0x3a, 0x9c] : neg(0x35);
      case 0x2f: {
        const did = (req[1] << 8) | req[2];
        if (id === 0x641 && (did === 0x0100 || did === 0x0101)) return req[3] === 0 ? [0x6f, req[1], req[2], 0x00] : [0x7f, 0x2f, 0x22];
        return neg(0x31);
      }
      case 0x31: {
        const rid = (req[2] << 8) | req[3];
        if (id === 0x641 && rid === 0x0203) return req[1] === 3 ? [0x7f, 0x31, 0x24] : [0x71, req[1], req[2], req[3], 0x00];
        if (id === 0x647 && rid === 0x0203) return neg(0x33);
        return neg(0x31);
      }
      case 0x11: return req[1] ? neg(0x22) : neg(0x13);
      default: return neg(0x11);
    }
  }
  obd(id, req, L) {
    const ecm = id === 0x7e8; const mode = req[0];
    const ECM_PIDS = [1, 3, 4, 5, 6, 7, 8, 9, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x14, 0x15, 0x18, 0x19, 0x1c, 0x1f, 0x20, 0x21, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x3c, 0x3e, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x49, 0x4a, 0x4c, 0x4d, 0x4e, 0x51, 0x5c];
    const TCM_PIDS = [1, 0x0d, 0x1c, 0x20, 0x40, 0x42];
    const pids = ecm ? ECM_PIDS : TCM_PIDS;
    const v = (pid) => this.pidVal(pid, L, ecm);
    if (mode === 0x01) {
      const out = [0x41];
      for (const pid of req.slice(1)) {
        if ([0, 0x20, 0x40, 0x60].includes(pid)) { if (pid === 0x60 || (pid && !pids.includes(pid))) continue; out.push(pid, ...pidBitmap(pids, pid)); continue; }
        if (!pids.includes(pid)) continue;
        const d = v(pid); if (d) out.push(pid, ...d);
      }
      return out.length > 1 ? out : null;
    }
    if (mode === 0x03) { if (!ecm) return [0x43, 0]; const c = this.dtc.stored; return [0x43, c.length, ...c.flatMap(dtcBytes)]; }
    if (mode === 0x07) { if (!ecm) return [0x47, 0]; const c = this.dtc.pending; return [0x47, c.length, ...c.flatMap(dtcBytes)]; }
    if (mode === 0x0a) { if (!ecm) return [0x4a, 0]; const c = this.dtc.perm; return [0x4a, c.length, ...c.flatMap(dtcBytes)]; }
    if (mode === 0x04) { this.dtc.stored = []; this.dtc.pending = []; this.cleared = Date.now(); return [0x44]; }
    if (mode === 0x02) {
      if (!ecm) return null;
      const pid = req[1];
      // like real ECUs: the bitmap announces the next range (0x20, 0x40) and PID 02 = 0000 after a clear
      const ffPids = [2, 4, 5, 6, 7, 8, 9, 0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x20, 0x2f, 0x33, 0x40, 0x42];
      if ([0, 0x20, 0x40].includes(pid)) return [0x42, pid, 0, ...pidBitmap(ffPids, pid)];
      if (pid === 2) return [0x42, 2, 0, ...(this.dtc.stored.length ? dtcBytes(this.dtc.stored[0]) : [0, 0])];
      if (!this.dtc.stored.length) return null;
      const ff = { rpm: 690, running: true, ect: 88, iat: 41, load: 24, map: 34, maf: 5.0, tps: 15, stft1: 9, stft2: 8, ltft1: 17, ltft2: 15, speed: 0, timing: 13, o2: () => .2, fuel: 58, baro: 101, volt: 14.1 };
      if (!ffPids.includes(pid)) return null;
      return [0x42, pid, 0, ...this.pidVal(pid, ff, true)];
    }
    if (mode === 0x09) {
      const sup = ecm ? [2, 4, 6, 8, 0x0a] : [2, 4, 0x0a];
      const p = req[1];
      if (p === 0) return [0x49, 0, ...pidBitmap(sup, 0)];
      if (!sup.includes(p)) return null;
      if (p === 2) return [0x49, 2, 1, ...asc(DEMO_VIN)];
      if (p === 4) return [0x49, 4, 1, ...asc((ecm ? '12654321' : '24250011').padEnd(16, '\0'))];
      if (p === 6) return [0x49, 6, 1, ...(ecm ? [0x1a, 0x2b, 0x3c, 0x4d] : [0x0f, 0xe1, 0x22, 0x07])];
      if (p === 8) return [0x49, 8, 20, ...[812, 1930, 640, 780, 0, 0, 600, 780, 0, 0, 120, 780, 0, 0, 230, 780, 0, 0, 0, 0].flatMap(n => [n >> 8, n & 255])];
      if (p === 0x0a) return [0x49, 0x0a, 1, ...asc((ecm ? 'ECM\0-EngineControl' : 'TCM\0-TransmisCtrl').padEnd(20, '\0'))];
    }
    if (mode === 0x06) {
      if (!ecm) return null;
      const m = req[1];
      const mids = [1, 2, 5, 6, 0x21, 0x22, 0x39, 0x3d, 0x41, 0x45, 0x81, 0x82, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9];
      if ([0, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0].includes(m)) return [0x46, m, ...pidBitmap(mids.concat([0x20, 0x40, 0x60, 0x80, 0xa0].filter(x => x > m)), m)];
      if (!mids.includes(m)) return null;
      const t = (tid, uas, val, mn, mx) => [tid, uas, val >> 8 & 255, val & 255, mn >> 8 & 255, mn & 255, mx >> 8 & 255, mx & 255];
      if (m === 0x21) return [0x46, m, ...t(0x80, 0x01, 312, 0, 420)];
      if (m === 0x22) return [0x46, m, ...t(0x80, 0x01, 371, 0, 420)];
      if (m === 0x39) return [0x46, m, ...t(0x80, 0x29, 0xfff0 & 0x7fff, 0, 0x7fff)];
      if (m === 0x81) return [0x46, m, ...t(0x80, 0x24, 17, 0, 25)];
      if (m === 0x82) return [0x46, m, ...t(0x80, 0x24, 16, 0, 25)];
      if (m >= 0xa1) { const cyl = m - 0xa1; const n = [0, 6, 2, 1, 0, 3, 9, 1, 2][cyl] || 0; return [0x46, m, ...t(0x0b, 0x24, n, 0, 65535), ...t(0x0c, 0x24, Math.round(n * 1.4), 0, 65535)]; }
      return [0x46, m, ...t(0x01, 0x0a, 3650, 3000, 65535), ...t(0x02, 0x0a, 1210, 0, 1600)];
    }
    if (mode === 0x08) { if (!ecm) return null; if (req[1] === 0) return [0x48, 0, ...pidBitmap([1], 0)]; if (req[1] === 1) return [0x48, 1, 0, 0, 0, 0, 0]; return null; }
    if (mode === 0x05) return null;
    return [0x7f, mode, 0x11];
  }
  pidVal(pid, L, ecm) {
    const u16 = n => { n = Math.max(0, Math.min(65535, Math.round(n))); return [n >> 8, n & 255]; };
    const u8 = n => [Math.max(0, Math.min(255, Math.round(n)))];
    const tr = p => u8(p * 128 / 100 + 128);
    switch (pid) {
      case 0x01: { const n = this.dtc.stored.length; return [(n ? 0x80 : 0) | n, 0x07, 0x65, 0x00 | 0x04 | 0x20]; }
      case 0x03: return [L.running ? 2 : 1, 0];
      case 0x04: return u8(L.load * 2.55);
      case 0x05: return u8(L.ect + 40);
      case 0x06: return tr(L.stft1); case 0x07: return tr(L.ltft1);
      case 0x08: return tr(L.stft2); case 0x09: return tr(L.ltft2);
      case 0x0b: return u8(L.map);
      case 0x0c: return u16(L.rpm * 4);
      case 0x0d: return u8(L.speed);
      case 0x0e: return u8((L.timing + 64) * 2);
      case 0x0f: return u8(L.iat + 40);
      case 0x10: return u16(L.maf * 100);
      case 0x11: return u8(L.tps * 2.55);
      case 0x13: return [0x33];
      case 0x14: return [Math.round(L.o2(1) * 200), 0x80 + Math.round(L.stft1)];
      case 0x15: return [Math.round(L.o2s2 * 200), 0xff];
      case 0x18: return [Math.round(L.o2(2) * 200), 0x80 + Math.round(L.stft2)];
      case 0x19: return [Math.round((L.o2s2 - .02) * 200), 0xff];
      case 0x1c: return [ecm ? 1 : 1];
      case 0x1f: return u16(L.run);
      case 0x21: return u16(0);
      case 0x2e: return u8(L.running ? 18 : 0);
      case 0x2f: return u8(L.fuel * 2.55);
      case 0x30: return u8(Math.min(255, Math.floor((Date.now() - this.cleared) / 86400e3) * 2));
      case 0x31: return u16(Math.floor((Date.now() - this.cleared) / 86400e3) * 61);
      case 0x33: return u8(L.baro);
      case 0x3c: return u16((L.cat + 40) * 10);
      case 0x3e: return u16((L.cat - 120 + 40) * 10);
      case 0x41: return [0, 0x07, 0x65, 0x61];
      case 0x42: return u16((L.running ? L.volt - .15 : L.volt - .2) * 1000);
      case 0x43: return u16(L.load * 2.55 * .9);
      case 0x44: return u16(32768);
      case 0x45: return u8(L.tps * 0.6 * 2.55);
      case 0x46: return u8(L.amb + 40);
      case 0x47: return u8((L.tps + 3) * 2.55);
      case 0x49: return u8((L.running ? 16 : 15) * 2.55);
      case 0x4a: return u8((L.running ? 8 : 7.5) * 2.55);
      case 0x4c: return u8(L.tps * .9 * 2.55);
      case 0x4d: return u16(0);
      case 0x4e: return u16(Math.floor((Date.now() - this.cleared) / 60000));
      case 0x51: return [1];
      case 0x5c: return u8(L.oil + 40);
      default: return null;
    }
  }
}
