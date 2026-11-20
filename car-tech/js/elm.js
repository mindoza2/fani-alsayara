// ELM327 protocol layer: command queue, prompt handling, multi-frame assembly,
// automatic protocol detection, capability probing, voltage, smart reconnect.
import { sleep, hex2, hex3, bus } from './util.js';

export const PROTOCOLS = {
  1: 'SAE J1850 PWM (41.6k)', 2: 'SAE J1850 VPW (10.4k)', 3: 'ISO 9141-2', 4: 'ISO 14230-4 KWP (5 baud)',
  5: 'ISO 14230-4 KWP (سريع)', 6: 'ISO 15765-4 CAN (11bit/500k)', 7: 'ISO 15765-4 CAN (29bit/500k)',
  8: 'ISO 15765-4 CAN (11bit/250k)', 9: 'ISO 15765-4 CAN (29bit/250k)', 10: 'SAE J1939 CAN', 11: 'USER1 CAN', 12: 'USER2 CAN',
};
const ERRORS = ['NO DATA', 'UNABLE TO CONNECT', 'CAN ERROR', 'BUS ERROR', 'BUS BUSY', 'FB ERROR', 'DATA ERROR', 'BUFFER FULL', 'STOPPED', 'ERR', 'LV RESET', 'ACT ALERT', 'RX ERROR', '?'];
export const NRC = {
  0x10: 'رفض عام', 0x11: 'الخدمة غير مدعومة', 0x12: 'الوظيفة الفرعية غير مدعومة', 0x13: 'طول/صيغة الطلب غير صحيحة',
  0x14: 'الرد طويل جدًا', 0x21: 'الكمبيوتر مشغول — أعد المحاولة', 0x22: 'الشروط غير مستوفاة (حالة المكينة/السرعة/…)',
  0x24: 'تسلسل خاطئ (يلزم خطوة قبلها)', 0x25: 'لا رد من مكوّن فرعي', 0x26: 'فشل يمنع التنفيذ', 0x31: 'المعرّف خارج النطاق / غير موجود',
  0x33: 'مقفل بمفتاح أمان (Security Access seed/key)', 0x35: 'مفتاح أمان خاطئ', 0x36: 'تجاوز عدد المحاولات', 0x37: 'يلزم الانتظار قبل المحاولة',
  0x70: 'رفض التحميل', 0x72: 'فشل البرمجة', 0x78: 'قيد التنفيذ…', 0x7e: 'غير مدعوم في الجلسة الحالية', 0x7f: 'الخدمة غير مدعومة في الجلسة الحالية',
  0x81: 'دوران المكينة مرتفع', 0x82: 'دوران المكينة منخفض', 0x83: 'المكينة تعمل', 0x84: 'المكينة لا تعمل', 0x88: 'السرعة مرتفعة', 0x8f: 'الفرامل غير مضغوطة', 0x92: 'الفولت مرتفع', 0x93: 'الفولت منخفض',
};

export class Elm {
  constructor(transport) {
    this.t = transport;
    this.buf = ''; this.pending = null; this.queue = Promise.resolve();
    this.proto = 0; this.isCan = false; this.is29 = false; this.headers = true;
    this.info = { version: '', desc: '', stn: '', caps: {}, protocolName: '', clone: false };
    this.log = []; this.curHeader = null; this.stats = { sent: 0, errors: 0 };
    this.t.onData = d => this._onData(d);
  }
  _onData(d) {
    this.buf += d;
    if (this.buf.includes('>') && this.pending) {
      const raw = this.buf.slice(0, this.buf.lastIndexOf('>'));
      this.buf = this.buf.slice(this.buf.lastIndexOf('>') + 1);
      const p = this.pending; this.pending = null; clearTimeout(p.timer); p.res(raw);
    }
  }
  _log(dir, s) { this.log.push(`${dir} ${s}`); if (this.log.length > 400) this.log.splice(0, 100); bus.emit('elmlog'); }
  // Send one raw command, wait for '>' prompt.
  send(cmd, timeout = 3000) {
    const run = async () => {
      // after a timeout the adapter may still answer the old command; give that late answer time
      // to arrive and be discarded so it is never taken as the reply to the next command
      const quiet = (this._quietUntil || 0) - Date.now();
      if (quiet > 0) await sleep(quiet);
      return new Promise((res) => {
        this.buf = '';
        const mine = {
          res: raw => { this._log('←', raw.replace(/\r+/g, ' | ').trim()); res(raw); },
          timer: setTimeout(() => {
            if (this.pending === mine) this.pending = null;
            this._quietUntil = Date.now() + 600;
            this._log('⌛', cmd + ' (مهلة)'); this.stats.errors++; res(this.buf + '\nTIMEOUT');
          }, timeout),
        };
        this.pending = mine;
        this._log('→', cmd); this.stats.sent++;
        // a write that fails late must only finish its own command — never the one queued after it
        this.t.write(cmd + '\r').catch(e => { if (this.pending !== mine) return; this.pending = null; clearTimeout(mine.timer); res('WRITEFAIL ' + e.message); });
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
  lines(raw, cmd) {
    return raw.split(/[\r\n]+/).map(l => l.trim()).filter(l => l && l !== cmd && l.replace(/\s/g, '') !== (cmd || '').replace(/\s/g, ''));
  }
  async at(cmd, timeout) { const r = await this.send('AT' + cmd, timeout); return this.lines(r, 'AT' + cmd).join(' ').trim(); }

  // ---------------- initialisation & discovery ----------------
  async init(progress = () => {}) {
    progress('إعادة تهيئة القطعة (ATZ)…');
    await this.send('ATZ', 4000); await sleep(300);
    // some clones answer ATZ late; flush with a harmless command
    await this.at('E0'); await this.at('E0');
    for (const c of ['L0', 'S1', 'H1', 'AT1', 'CAF1']) await this.at(c);
    this.info.version = (await this.at('I')).replace(/^ATI/, '');
    this.info.desc = await this.at('@1');
    const sti = await this.send('STI'); const stl = this.lines(sti, 'STI').join(' ');
    this.info.stn = /STN|OBDLINK/i.test(stl) ? stl : '';
    progress('فحص قدرات القطعة…');
    const caps = {};
    const probe = async (k, cmd) => { const r = await this.at(cmd); caps[k] = /OK/.test(r) || (r && !/\?/.test(r)); };
    await probe('header', 'SH7DF');
    await probe('canFilter', 'CRA');
    await probe('flowControl', 'FCSM0');
    await probe('timeout', 'ST32');
    await probe('adaptiveTiming', 'AT1');
    await probe('canPriority', 'CP18');
    await probe('progParams', 'PPS');
    caps.voltage = /\d/.test(await this.at('RV'));
    this.info.caps = caps;
    const v = parseFloat((this.info.version.match(/v?(\d+\.\d+)/i) || [])[1] || '0');
    this.info.clone = v >= 2 && !caps.progParams && !this.info.stn;
    progress('البحث عن بروتوكول السيارة تلقائيًا…');
    await this.at('SP0');
    let r = await this.send('0100', 12000);
    let ok = this.hasData(r);
    if (!ok) {
      for (const p of [6, 8, 7, 9, 2, 1, 3, 5, 4]) {
        progress(`تجربة البروتوكول ${PROTOCOLS[p]}…`);
        await this.at('TP' + p.toString(16).toUpperCase());
        r = await this.send('0100', p >= 3 && p <= 5 ? 9000 : 5000);
        if (this.hasData(r)) { ok = true; break; }
      }
    }
    const dpn = await this.at('DPN');
    this.proto = parseInt(dpn.replace(/^A/, ''), 16) || 0;
    this.isCan = this.proto >= 6 && this.proto <= 9;
    this.is29 = this.proto === 7 || this.proto === 9;
    this.info.protocolName = PROTOCOLS[this.proto] || (ok ? 'غير معروف' : '—');
    if (ok) await this.at('SP' + this.proto.toString(16).toUpperCase()); // lock the found protocol for stability
    this.curHeader = null; this._auto = false;
    return ok;
  }
  // light re-init after reconnect (protocol already known)
  async resume() {
    await this.send('ATZ', 4000); await sleep(200);
    for (const c of ['E0', 'E0', 'L0', 'S1', 'H1', 'AT1']) await this.at(c);
    if (this.proto) await this.at('SP' + this.proto.toString(16).toUpperCase());
    this.curHeader = null; this._auto = false; this._physical = false; this.dirty = false;
    const r = await this.send('0100', 8000);
    return this.hasData(r);
  }
  // After raw commands from the terminal: put the adapter back into the state the app relies on.
  async restoreState() {
    if (this._restoring) return this._restoring;
    this._restoring = (async () => {
      for (const c of ['E0', 'L0', 'S1', 'H1', 'AT1', 'CAF1', 'CRA', 'FCSM0', 'ST32']) await this.at(c);
      if (this.proto) await this.at('SP' + this.proto.toString(16).toUpperCase());
      this.curHeader = null; this._auto = false; this._physical = false; this.dirty = false;
      await this.functional();
    })();
    try { await this._restoring; } finally { this._restoring = null; }
  }
  hasData(raw) { return this.lines(raw).some(l => /^[0-9A-F ]+$/i.test(l) && l.replace(/\s/g, '').length >= 6); }

  async voltage() {
    const r = await this.at('RV', 1500);
    const m = r.match(/(\d+(\.\d+)?)\s*V?/i);
    return m ? parseFloat(m[1]) : null;
  }

  // ---------------- addressing ----------------
  async setHeader(h) {
    if (this.curHeader === h) return;
    await this.at('SH' + h);
    this.curHeader = h;
  }
  // Broadcast addressing for standard OBD requests. Cheap when already set, so every standard
  // request can (and does) make sure of it — even right after a physical-addressing operation.
  async functional() {
    const h = this.is29 ? '18DB33F1' : this.isCan ? '7DF' : '686AF1';
    if (this.curHeader === h && this._auto) return;
    await this.setHeader(h);
    await this.at('AR');
    this._auto = true;
  }
  // Physical addressing to one module on 11-bit CAN, with receive filter + flow control.
  async physical(req, res) {
    this._auto = false;
    await this.setHeader(hex3(req));
    await this.at('CRA' + hex3(res));
    await this.at('FCSH' + hex3(req)); await this.at('FCSD300000'); await this.at('FCSM1');
    this._physical = true;
  }
  async clearPhysical() {
    if (!this._physical) return;
    await this.at('CRA'); await this.at('FCSM0'); await this.at('AR');
    this._physical = false; this._auto = false; await this.functional();
  }

  // ---------------- requests ----------------
  // Returns {ok, error, msgs:[{ecu, bytes, neg?}], byEcu: Map}
  async request(hex, timeout = 4000) {
    const cmd = hex.replace(/\s+/g, '').toUpperCase();
    const raw = await this.send(cmd, timeout);
    return this.parse(raw, cmd);
  }
  parse(raw, cmd) {
    const lines = this.lines(raw, cmd);
    const out = { ok: false, error: null, msgs: [], byEcu: new Map(), raw: lines.join(' | ') };
    const asm = new Map();
    for (let line of lines) {
      if (/^SEARCHING|^BUS INIT|^OK$|^ELM/i.test(line)) continue;
      if (/TIMEOUT|WRITEFAIL/.test(line)) { out.error = 'لا رد من القطعة (انتهت المهلة)'; continue; }
      const er = ERRORS.find(e => line.toUpperCase().startsWith(e));
      if (er) { out.error = er; continue; }
      if (!/^[0-9A-F ]+$/i.test(line)) continue;
      let hdr = '?', data;
      const compact = line.replace(/\s/g, '');
      if (this.headers && this.isCan) {
        const hl = this.is29 ? 8 : 3;
        hdr = compact.slice(0, hl);
        data = (compact.slice(hl).match(/../g) || []).map(x => parseInt(x, 16));
        if (this.is29) hdr = hdr.slice(6); // source address
        // ISO-TP
        const pci = data[0], type = pci >> 4;
        let st = asm.get(hdr);
        if (type === 0) { const n = pci & 15; this._push(out, hdr, data.slice(1, 1 + n)); }
        else if (type === 1) { asm.set(hdr, { len: ((pci & 15) << 8) | data[1], buf: data.slice(2) }); }
        else if (type === 2 && st) { st.buf.push(...data.slice(1)); if (st.buf.length >= st.len) { this._push(out, hdr, st.buf.slice(0, st.len)); asm.delete(hdr); } }
      } else if (this.headers && !this.isCan) {
        const b = (compact.match(/../g) || []).map(x => parseInt(x, 16));
        hdr = hex2(b[2] ?? 0); data = b.slice(3, -1);
        this._push(out, hdr, data);
      } else {
        data = (compact.match(/../g) || []).map(x => parseInt(x, 16));
        this._push(out, hdr, data);
      }
    }
    for (const [hdr, st] of asm) this._push(out, hdr, st.buf.slice(0, st.len)); // incomplete multi-frame: keep what arrived
    // drop "response pending" if a final answer came from that module
    out.msgs = out.msgs.filter(m => !(m.neg && m.nrc === 0x78 && out.msgs.some(o => o.ecu === m.ecu && !(o.neg && o.nrc === 0x78))));
    out.byEcu = new Map();
    for (const m of out.msgs) { if (!out.byEcu.has(m.ecu)) out.byEcu.set(m.ecu, []); out.byEcu.get(m.ecu).push(m); }
    out.ok = out.msgs.length > 0;
    if (!out.ok && !out.error) out.error = 'NO DATA';
    return out;
  }
  _push(out, ecu, bytes) {
    if (!bytes || !bytes.length) return;
    const m = { ecu, bytes };
    if (bytes[0] === 0x7f) { m.neg = true; m.sid = bytes[1]; m.nrc = bytes[2]; }
    out.msgs.push(m);
  }
}

// Connection manager: holds the adapter, status, voltage polling and smart reconnect.
export class Connection {
  constructor() {
    this.state = 'off'; this.elm = null; this.transport = null; this.voltage = null; this.manual = false;
    this.attempts = 0; this.vTimer = null; this.lastLog = []; this.gen = 0;
  }
  set(state, msg) { this.state = state; bus.emit('conn', { state, msg }); }
  async open(transport, progress = () => {}) {
    this.gen++; // a reconnect loop from an older connection must never act on this one
    this.manual = false;
    this.transport = transport;
    transport.onDisconnect = () => this._lost();
    this.set('connecting', 'جارٍ الاتصال…');
    try {
      const chosen = await transport.connect(progress);
      this.elm = new Elm(transport);
      const ok = await this.elm.init(progress);
      this.chosen = chosen;
      if (!ok) {
        this.set('adapter', 'القطعة متصلة لكن السيارة لم ترد');
        progress('القطعة متصلة لكن السيارة لم ترد. تأكد أن السويتش على وضع التشغيل (ON) أو المكينة شغالة.');
      } else this.set('on', this.elm.info.protocolName);
      this._startVolt();
      return ok;
    } catch (e) {
      this.set('err', e.message);
      throw e;
    }
  }
  _startVolt() {
    clearInterval(this.vTimer);
    const tick = async () => {
      if (!this.elm || !['on', 'adapter'].includes(this.state) || this.pauseVolt) return;
      const v = await this.elm.voltage();
      if (v != null) { this.voltage = v; bus.emit('volt', v); }
    };
    tick(); this.vTimer = setInterval(tick, 4000);
  }
  async _lost() {
    if (this.manual || this.state === 'off' || this.state === 'reconnecting') return;
    const gen = this.gen;
    this.set('reconnecting', 'انقطع الاتصال — إعادة المحاولة…');
    for (this.attempts = 1; this.attempts <= 6; this.attempts++) {
      await sleep(Math.min(8000, 800 * 2 ** (this.attempts - 1)));
      if (this.manual || gen !== this.gen) return;
      try {
        await this.transport.reconnect(() => {});
        if (this.manual || gen !== this.gen) return;
        this.elm.t.onData = d => this.elm._onData(d);
        const ok = await this.elm.resume();
        if (this.manual || gen !== this.gen) return;
        this.set(ok ? 'on' : 'adapter', ok ? 'أُعيد الاتصال' : 'القطعة عادت لكن السيارة لا ترد');
        bus.emit('reconnected');
        return;
      } catch (e) { if (gen === this.gen) bus.emit('conn', { state: 'reconnecting', msg: `محاولة ${this.attempts} فشلت` }); }
    }
    if (gen === this.gen && !this.manual) this.set('err', 'تعذّرت إعادة الاتصال — اضغط «اتصال» للمحاولة يدويًا');
  }
  async close() {
    this.gen++;
    this.manual = true; clearInterval(this.vTimer);
    try { await this.transport?.close(); } catch {}
    this.elm = null; this.voltage = null; this.set('off', 'غير متصل'); bus.emit('volt', null);
  }
  get ready() { return this.state === 'on' && !!this.elm; }
}
