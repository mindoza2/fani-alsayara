// Manufacturer layer (best effort): module discovery by physical addressing, per-module DTCs,
// clearing, identification, service/routine/IO discovery and execution. Nothing here is
// tied to one car: it scans and reports what actually answers, with honest error meanings.
import { hex2, hex3, hex4, sleep } from './util.js';
import { NRC } from './elm.js';
import { dtcFromBytes } from './obd.js';

// Address ranges probed at run time. Users can add more through the reference library.
export const RANGES = [
  { id: 'obd', name: 'نطاق OBD القياسي 7E0–7E7', from: 0x7e0, to: 0x7e7, off: 8, conf: 'sure', quick: true },
  { id: 'uds7', name: 'نطاق UDS الشائع 700–7DF', from: 0x700, to: 0x7df, off: 8, conf: 'best' },
  { id: 'gmlan', name: 'نطاق GMLAN عالي السرعة 240–25F (رد 640–65F)', from: 0x240, to: 0x25f, off: 0x400, conf: 'best', makes: ['GM'], quick: true },
];
// ISO 14229 standard identification DIDs (names are standard → sure)
export const STD_DIDS = {
  0xf180: 'برنامج الإقلاع', 0xf181: 'تعريف البرنامج', 0xf182: 'تعريف بيانات المعايرة', 0xf186: 'الجلسة الحالية', 0xf187: 'رقم القطعة (قطع الغيار)',
  0xf188: 'رقم برنامج الكمبيوتر', 0xf189: 'إصدار البرنامج', 0xf18a: 'المورّد', 0xf18b: 'تاريخ التصنيع', 0xf18c: 'الرقم التسلسلي', 0xf190: 'رقم الهيكل VIN',
  0xf191: 'رقم العتاد (المصنّع)', 0xf192: 'رقم العتاد (المورّد)', 0xf193: 'إصدار العتاد', 0xf194: 'رقم البرنامج (المورّد)', 0xf195: 'إصدار البرنامج (المورّد)',
  0xf197: 'اسم النظام', 0xf199: 'تاريخ البرمجة', 0xf19d: 'تاريخ التركيب',
};
export const SIDS = {
  0x10: 'التحكم بالجلسة التشخيصية', 0x11: 'إعادة تشغيل الكمبيوتر', 0x14: 'مسح الأعطال', 0x19: 'قراءة الأعطال (UDS)', 0x22: 'قراءة بيانات بالمعرّف', 0x23: 'قراءة ذاكرة',
  0x27: 'الوصول الأمني (seed/key)', 0x28: 'التحكم بالاتصال', 0x2e: 'كتابة بيانات بالمعرّف (تهيئة/ترميز)', 0x2f: 'التحكم بالمدخلات/المخرجات (اختبار فعّال)', 0x31: 'تشغيل روتين (خدمة/إعادة تعلّم/اختبار)',
  0x3e: 'إبقاء الجلسة (Tester Present)', 0x85: 'التحكم بتسجيل الأعطال', 0x18: 'قراءة الأعطال (KWP2000)', 0x1a: 'قراءة تعريف الكمبيوتر (KWP/GMLAN)', 0x21: 'قراءة بيانات محلية (KWP)',
  0x30: 'تحكم مدخلات/مخرجات محلي (KWP)', 0x3b: 'كتابة بيانات محلية (KWP/GMLAN)', 0xa9: 'قراءة معلومات تشخيص (GMLAN)', 0xae: 'التحكم بجهاز (GMLAN)', 0x34: 'طلب تنزيل (برمجة)', 0x36: 'نقل بيانات (برمجة)',
};
// Routines that must never be started from this app (safety / programming).
export function routineBlocked(rid) {
  if (rid >= 0xe200 && rid <= 0xe2ff) return 'معرّفات ISO 26021 لإطلاق الوسائد الهوائية/الشدّادات (للتخلّص من السيارة) — محظورة نهائيًا';
  if (rid === 0xff00 || rid === 0xff01) return 'روتين برمجة/مسح ذاكرة — خارج نطاق هذا البرنامج (يحتاج أدوات برمجة منفصلة)';
  return null;
}
export function nrcText(n) { return NRC[n] || `رمز رفض 0x${hex2(n)}`; }

export class ModuleLayer {
  constructor(elm) { this.elm = elm; this.cancel = false; }

  async _rangeFilter(fromRes, toRes) {
    // accept every ID in [fromRes,toRes]; filter precisely in software
    let mask = 0x7ff; for (let b = 0; b < 11; b++) if (((fromRes >> b) & 1) !== ((toRes >> b) & 1)) mask &= ~((1 << (b + 1)) - 1);
    await this.elm.at('CF' + hex3(fromRes & mask)); await this.elm.at('CM' + hex3(mask));
  }
  // Scan address ranges; returns [{req,res,proto,id:{...}}]
  async scan(ranges, onProgress = () => {}) {
    const elm = this.elm;
    if (!elm.isCan || elm.is29) return { found: [], note: elm.isCan ? 'المسح الفيزيائي مدعوم حاليًا على CAN 11-bit فقط؛ سيارتك على 29-bit — نعرض الطبقة القياسية فقط.' : 'السيارة على بروتوكول قديم (غير CAN) — لا يمكن مسح الكمبيوترات بالعنونة الفيزيائية عبر هذه القطعة.' };
    this.cancel = false;
    const total = ranges.reduce((s, r) => s + (r.to - r.from + 1), 0);
    let done = 0; const found = [];
    await elm.at('ST19'); // ~100ms timeout per probe
    for (const r of ranges) {
      await this._rangeFilter(r.from + r.off, r.to + r.off);
      for (let req = r.from; req <= r.to; req++) {
        if (this.cancel) break;
        onProgress(++done / total, `0x${hex3(req)}`);
        if (req === 0x7df) continue;
        await elm.setHeader(hex3(req));
        const resp = await elm.request('3E00', 1500);
        const m = resp.msgs.find(x => parseInt(x.ecu, 16) === req + r.off);
        if (m) found.push({ req, res: req + r.off, range: r.id, conf: r.conf, gm: m.neg && m.sid === 0x3e && (m.nrc === 0x12 || m.nrc === 0x13) });
      }
    }
    await elm.at('CRA'); await elm.at('ST32'); await elm.at('AR');
    elm.curHeader = null;
    for (const f of found) { if (this.cancel) break; f.ident = await this.identify(f); }
    await elm.clearPhysical(); await elm.functional();
    return { found, cancelled: this.cancel };
  }
  async _to(mod) { await this.elm.physical(mod.req, mod.res); }
  async _req(mod, hex, timeout = 3000) {
    const r = await this.elm.request(hex, timeout);
    const m = r.msgs.find(x => parseInt(x.ecu, 16) === mod.res) || null;
    return { m, r };
  }
  async identify(mod) {
    await this._to(mod);
    const id = {};
    for (const did of [0xf190, 0xf197, 0xf18c, 0xf195, 0xf187, 0xf18a]) {
      const { m } = await this._req(mod, '22' + hex4(did), 1500);
      if (m && !m.neg && m.bytes[0] === 0x62) id[did] = ascii(m.bytes.slice(3)) || m.bytes.slice(3).map(hex2).join(' ');
      if (m?.neg && m.nrc === 0x11) { id.noUds = true; break; }
    }
    if (id.noUds) { // KWP / GMLAN identification
      for (const t of [0x90, 0x97, 0xb4, 0xc1]) {
        const { m } = await this._req(mod, '1A' + hex2(t), 1500);
        if (m && !m.neg && m.bytes[0] === 0x5a) id['1A' + hex2(t)] = ascii(m.bytes.slice(2)) || m.bytes.slice(2).map(hex2).join(' ');
      }
    }
    return id;
  }
  // DTCs from one module: UDS 19 02, then KWP 18. Returns {proto, dtcs:[{code,status,kind}], error}
  async readDtcs(mod) {
    await this._to(mod);
    let { m } = await this._req(mod, '1902FF', 4000);
    if (m && !m.neg && m.bytes[0] === 0x59) {
      const out = []; const b = m.bytes;
      for (let i = 3; i + 3 < b.length; i += 4) {
        const st = b[i + 3]; if (!st) continue;
        out.push({ code: dtcFromBytes(b[i], b[i + 1]), ftb: b[i + 2], status: st, kind: st & 0x08 ? 'stored' : st & 0x04 ? 'pending' : 'history', mil: !!(st & 0x80), active: !!(st & 1) });
      }
      return { proto: 'UDS', dtcs: out };
    }
    const udsErr = m?.neg ? m.nrc : null;
    ({ m } = await this._req(mod, '1800FF00', 4000));
    if (m && !m.neg && m.bytes[0] === 0x58) {
      const out = []; const b = m.bytes;
      for (let i = 2; i + 2 < b.length; i += 3) out.push({ code: dtcFromBytes(b[i], b[i + 1]), status: b[i + 2], kind: (b[i + 2] & 0x60) === 0x60 ? 'stored' : 'pending', active: !!(b[i + 2] & 0x40) });
      return { proto: 'KWP2000', dtcs: out };
    }
    return { proto: null, dtcs: [], error: udsErr ? `الكمبيوتر رفض قراءة الأعطال: ${nrcText(udsErr)}` : 'الكمبيوتر يرد لكن لا يدعم قراءة الأعطال بصيغة UDS/KWP عبر هذه القطعة (قد يستخدم بروتوكول المصنّع الخاص)' };
  }
  async clearDtcs(mod, proto) {
    await this._to(mod);
    const req = proto === 'KWP2000' ? '14FF00' : '14FFFFFF';
    const { m } = await this._req(mod, req, 6000);
    if (m && !m.neg && m.bytes[0] === 0x54) return { ok: true };
    return { ok: false, error: m?.neg ? nrcText(m.nrc) : 'لا رد على أمر المسح' };
  }
  // Probe which services the module exposes: NRC 0x11 → not supported; anything else → exists.
  async discoverServices(mod, onProgress = () => {}) {
    await this._to(mod);
    const out = []; const sids = Object.keys(SIDS).map(Number).filter(s => s !== 0x34 && s !== 0x36);
    let i = 0;
    for (const sid of sids) {
      onProgress(++i / sids.length);
      const { m } = await this._req(mod, hex2(sid), 1500);
      let st = 'unknown', why = 'لا رد';
      if (m) {
        if (!m.neg) { st = 'yes'; why = 'رد إيجابي'; }
        else if (m.nrc === 0x11) { st = 'no'; why = nrcText(0x11); }
        else { st = 'yes'; why = nrcText(m.nrc); }
      }
      out.push({ sid, name: SIDS[sid], st, why });
    }
    return out;
  }
  async security(mod) {
    await this._to(mod);
    await this._req(mod, '1003', 2000);
    const { m } = await this._req(mod, '2701', 2500);
    if (!m) return { state: 'unknown', text: 'لا رد على طلب الوصول الأمني' };
    if (m.neg) return { state: m.nrc === 0x11 || m.nrc === 0x12 ? 'none' : 'locked', text: nrcText(m.nrc) };
    const seed = m.bytes.slice(2);
    if (seed.every(x => x === 0)) return { state: 'open', text: 'الكمبيوتر مفتوح أصلًا (seed = 0)' };
    return { state: 'locked', text: `الكمبيوتر أرسل seed (${seed.map(hex2).join(' ')}). خوارزمية المفتاح خاصة بالمصنّع وغير متوفرة هنا — الوظائف المحمية مقفلة.` };
  }
  // Generic range scans
  async scanRoutines(mod, from, to, onProgress) {
    return this._scanIds(mod, from, to, onProgress, id => routineBlocked(id) ? null : '3103' + hex4(id), (m) => {
      if (!m) return null;
      if (!m.neg) return 'موجود (له نتيجة سابقة)';
      if (m.nrc === 0x31 || m.nrc === 0x11 || m.nrc === 0x12) return null;
      return 'موجود — ' + nrcText(m.nrc);
    });
  }
  async scanIo(mod, from, to, onProgress) {
    return this._scanIds(mod, from, to, onProgress, id => '2F' + hex4(id) + '00', m => {
      if (!m) return null;
      if (!m.neg) return 'موجود (إرجاع التحكم للكمبيوتر نجح)';
      if (m.nrc === 0x31 || m.nrc === 0x11 || m.nrc === 0x12) return null;
      return 'موجود — ' + nrcText(m.nrc);
    });
  }
  async scanDids(mod, from, to, onProgress) {
    return this._scanIds(mod, from, to, onProgress, id => '22' + hex4(id), m => {
      if (!m || m.neg || m.bytes[0] !== 0x62) return m?.neg && ![0x31, 0x11, 0x12, 0x13].includes(m.nrc) ? 'موجود — ' + nrcText(m.nrc) : null;
      const d = m.bytes.slice(3);
      return { raw: d.map(hex2).join(' '), ascii: ascii(d) };
    });
  }
  async _scanIds(mod, from, to, onProgress = () => {}, mk, judge) {
    await this._to(mod);
    this.cancel = false;
    const found = []; const n = to - from + 1;
    let k = 0, lastTp = Date.now();
    await this._req(mod, '1003', 2000);
    for (let id = from; id <= to; id++) {
      if (this.cancel) break;
      onProgress(++k / n, '0x' + hex4(id));
      const req = mk(id); if (!req) continue;
      const { m } = await this._req(mod, req, 1200);
      const j = judge(m);
      if (j) found.push({ id, result: j, name: STD_DIDS[id] || null });
      if (Date.now() - lastTp > 2000) { await this._req(mod, '3E00', 800); lastTp = Date.now(); }
    }
    return { found, cancelled: this.cancel };
  }
  async session(mod, s = 0x03) { await this._to(mod); const { m } = await this._req(mod, '10' + hex2(s), 2500); return m && !m.neg ? { ok: true } : { ok: false, error: m?.neg ? nrcText(m.nrc) : 'لا رد' }; }
  async startRoutine(mod, rid, params = '') {
    const bl = routineBlocked(rid); if (bl) return { ok: false, error: bl };
    await this._to(mod);
    await this._req(mod, '1003', 2500);
    const { m } = await this._req(mod, '3101' + hex4(rid) + params, 10000);
    if (m && !m.neg && m.bytes[0] === 0x71) {
      await sleep(500);
      const r2 = await this._req(mod, '3103' + hex4(rid), 4000);
      return { ok: true, data: m.bytes.slice(4).map(hex2).join(' '), result: r2.m && !r2.m.neg ? r2.m.bytes.slice(4).map(hex2).join(' ') : null };
    }
    return { ok: false, error: m?.neg ? nrcText(m.nrc) : 'لا رد من الكمبيوتر' };
  }
  async ioControl(mod, did, stateHex, seconds = 5) {
    await this._to(mod);
    await this._req(mod, '1003', 2500);
    const { m } = await this._req(mod, '2F' + hex4(did) + '03' + stateHex, 4000);
    if (!(m && !m.neg && m.bytes[0] === 0x6f)) return { ok: false, error: m?.neg ? nrcText(m.nrc) : 'لا رد من الكمبيوتر' };
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) { await sleep(1500); await this._req(mod, '3E00', 800); }
    const back = await this._req(mod, '2F' + hex4(did) + '00', 3000);
    return { ok: true, returned: !!(back.m && !back.m.neg) };
  }
  async writeDid(mod, did, dataHex) {
    await this._to(mod);
    await this._req(mod, '1003', 2500);
    const { m } = await this._req(mod, '2E' + hex4(did) + dataHex, 5000);
    if (m && !m.neg && m.bytes[0] === 0x6e) return { ok: true };
    return { ok: false, error: m?.neg ? nrcText(m.nrc) : 'لا رد من الكمبيوتر' };
  }
  async done() { await this.elm.clearPhysical(); }
}
export function ascii(b) { const s = b.filter(x => x >= 0x20 && x < 0x7f).map(x => String.fromCharCode(x)).join('').trim(); return s.length >= Math.min(3, b.length) ? s : ''; }

// Module naming: reference library (user-extensible) → else address-only. Returns {name, conf, src}
export function moduleName(mod, lib, make) {
  const hint = (lib?.modules || []).find(x => (!x.make || x.make === make) && parseInt(x.req, 16) === mod.req);
  if (hint) return { name: hint.name, conf: hint.conf || 'best', src: 'المكتبة المرجعية' };
  if (mod.req >= 0x7e0 && mod.req <= 0x7e7) return { name: ['كمبيوتر المكينة (ECM)', 'كمبيوتر القير (TCM)'][mod.req - 0x7e0] || `كمبيوتر OBD #${mod.req - 0x7e0 + 1}`, conf: mod.req <= 0x7e1 ? 'best' : 'est', src: 'عنونة ISO 15765-4' };
  const sys = mod.ident?.[0xf197] || mod.ident?.['1A97'];
  if (sys) return { name: sys, conf: 'sure', src: 'اسم النظام كما أرسله الكمبيوتر' };
  return { name: `كمبيوتر على العنوان 0x${hex3(mod.req)}`, conf: 'est', src: 'الاسم غير معروف — أضفه للمكتبة المرجعية' };
}
