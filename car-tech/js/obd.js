// Standard OBD-II layer (SAE J1979 + best-effort J1979-2 / OBDonUDS).
// Everything here is discovered from the car at run time: supported PIDs, MIDs, TIDs, info types.
import { hex2, hex3 } from './util.js';

const S = b => (b > 127 ? b - 256 : b);
const S16 = (a, b) => { const v = (a << 8) | b; return v > 32767 ? v - 65536 : v; };
const trim = a => (a - 128) * 100 / 128;
const pct = a => a * 100 / 255;
const u16 = (a, b) => (a << 8) | b;

// pid: [name, unit, byteLen, decode(bytes), gaugeMin, gaugeMax, decimals, healthy]
// healthy: {ok:[lo,hi], warn:[lo,hi], when:'running'|'warm'|'off'} — outside warn = bad
export const PIDS = {
  0x01: ['حالة المراقبات والجاهزية', '', 4, null],
  0x02: ['الكود المسبّب للقطة', '', 2, null],
  0x03: ['حالة نظام الوقود', '', 2, b => fuelSys(b[0])],
  0x04: ['الحِمل المحسوب', '%', 1, b => pct(b[0]), 0, 100, 0, { ok: [0, 80], warn: [0, 95] }],
  0x05: ['حرارة سائل التبريد', '°C', 1, b => b[0] - 40, -40, 130, 0, { ok: [80, 105], warn: [70, 110], when: 'warm' }],
  0x06: ['تعديل الوقود قصير — بنك 1', '%', 1, b => trim(b[0]), -30, 30, 1, { ok: [-10, 10], warn: [-20, 20], when: 'running' }],
  0x07: ['تعديل الوقود طويل — بنك 1', '%', 1, b => trim(b[0]), -30, 30, 1, { ok: [-8, 8], warn: [-15, 15], when: 'running' }],
  0x08: ['تعديل الوقود قصير — بنك 2', '%', 1, b => trim(b[0]), -30, 30, 1, { ok: [-10, 10], warn: [-20, 20], when: 'running' }],
  0x09: ['تعديل الوقود طويل — بنك 2', '%', 1, b => trim(b[0]), -30, 30, 1, { ok: [-8, 8], warn: [-15, 15], when: 'running' }],
  0x0a: ['ضغط الوقود', 'kPa', 1, b => b[0] * 3, 0, 765, 0],
  0x0b: ['ضغط المنيفولد MAP', 'kPa', 1, b => b[0], 0, 110, 0, { ok: [15, 105], warn: [10, 110] }],
  0x0c: ['دوران المكينة', 'rpm', 2, b => u16(b[0], b[1]) / 4, 0, 7000, 0, { ok: [500, 6000], warn: [400, 6500], when: 'running' }],
  0x0d: ['السرعة', 'km/h', 1, b => b[0], 0, 220, 0],
  0x0e: ['تقديم الشرارة', '°', 1, b => b[0] / 2 - 64, -20, 50, 1, { ok: [-5, 45], warn: [-12, 50], when: 'running' }],
  0x0f: ['حرارة هواء السحب', '°C', 1, b => b[0] - 40, -40, 100, 0, { ok: [-30, 60], warn: [-35, 75] }],
  0x10: ['تدفق الهواء MAF', 'g/s', 2, b => u16(b[0], b[1]) / 100, 0, 250, 1, { ok: [1.5, 300], warn: [1, 400], when: 'running' }],
  0x11: ['فتحة البوابة (الثروتل)', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x12: ['حالة الهواء الثانوي', '', 1, b => ({ 1: 'قبل الحفاز', 2: 'بعد الحفاز', 4: 'من الخارج/مطفأ', 8: 'تشخيص' }[b[0]] || hex2(b[0]))],
  0x13: ['حساسات الأكسجين الموجودة', '', 1, b => o2map(b[0], 2)],
  0x1c: ['معيار OBD للسيارة', '', 1, b => OBD_STD[b[0]] || 'رمز ' + b[0]],
  0x1d: ['حساسات الأكسجين (4 بنوك)', '', 1, b => o2map(b[0], 4)],
  0x1e: ['حالة المدخل المساعد (PTO)', '', 1, b => (b[0] & 1 ? 'فعّال' : 'غير فعّال')],
  0x1f: ['زمن التشغيل منذ التشغيل', 's', 2, b => u16(b[0], b[1]), 0, 3600, 0],
  0x21: ['مسافة مع لمبة المكينة', 'km', 2, b => u16(b[0], b[1]), 0, 1000, 0, { ok: [0, 0], warn: [0, 50] }],
  0x22: ['ضغط سكة الوقود (نسبي)', 'kPa', 2, b => u16(b[0], b[1]) * 0.079, 0, 5000, 0],
  0x23: ['ضغط سكة الوقود', 'kPa', 2, b => u16(b[0], b[1]) * 10, 0, 200000, 0],
  0x2c: ['EGR المطلوب', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x2d: ['خطأ EGR', '%', 1, b => trim(b[0]), -100, 100, 0],
  0x2e: ['تنقية البخار EVAP المطلوبة', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x2f: ['مستوى الوقود', '%', 1, b => pct(b[0]), 0, 100, 0, { ok: [12, 100], warn: [5, 100] }],
  0x30: ['دورات تسخين منذ المسح', '', 1, b => b[0], 0, 255, 0],
  0x31: ['مسافة منذ مسح الأعطال', 'km', 2, b => u16(b[0], b[1]), 0, 5000, 0],
  0x32: ['ضغط بخار EVAP', 'Pa', 2, b => S16(b[0], b[1]) / 4, -2000, 2000, 1],
  0x33: ['الضغط الجوي', 'kPa', 1, b => b[0], 60, 110, 0, { ok: [70, 106], warn: [60, 110] }],
  0x3c: ['حرارة الحفاز بنك1 حساس1', '°C', 2, b => u16(b[0], b[1]) / 10 - 40, 0, 1000, 0, { ok: [250, 850], warn: [150, 950], when: 'warm' }],
  0x3d: ['حرارة الحفاز بنك2 حساس1', '°C', 2, b => u16(b[0], b[1]) / 10 - 40, 0, 1000, 0, { ok: [250, 850], warn: [150, 950], when: 'warm' }],
  0x3e: ['حرارة الحفاز بنك1 حساس2', '°C', 2, b => u16(b[0], b[1]) / 10 - 40, 0, 1000, 0],
  0x3f: ['حرارة الحفاز بنك2 حساس2', '°C', 2, b => u16(b[0], b[1]) / 10 - 40, 0, 1000, 0],
  0x41: ['حالة المراقبات في هذه الدورة', '', 4, null],
  0x42: ['فولت كمبيوتر المكينة', 'V', 2, b => u16(b[0], b[1]) / 1000, 8, 16, 2, { ok: [13.2, 14.9], warn: [12.4, 15.2], when: 'running' }],
  0x43: ['الحِمل المطلق', '%', 2, b => u16(b[0], b[1]) * 100 / 255, 0, 100, 0],
  0x44: ['نسبة الخلط المطلوبة (λ)', 'λ', 2, b => u16(b[0], b[1]) * 2 / 65536, 0.5, 1.5, 3],
  0x45: ['فتحة الثروتل النسبية', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x46: ['حرارة الجو', '°C', 1, b => b[0] - 40, -20, 60, 0],
  0x47: ['موضع الثروتل B', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x48: ['موضع الثروتل C', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x49: ['دعسة البنزين D', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x4a: ['دعسة البنزين E', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x4b: ['دعسة البنزين F', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x4c: ['محرك الثروتل المطلوب', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x4d: ['زمن التشغيل مع اللمبة', 'min', 2, b => u16(b[0], b[1]), 0, 1000, 0],
  0x4e: ['زمن منذ مسح الأعطال', 'min', 2, b => u16(b[0], b[1]), 0, 10000, 0],
  0x50: ['أقصى تدفق هواء', 'g/s', 4, b => b[0] * 10, 0, 2550, 0],
  0x51: ['نوع الوقود', '', 1, b => FUEL[b[0]] || 'رمز ' + b[0]],
  0x52: ['نسبة الإيثانول', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x53: ['ضغط EVAP المطلق', 'kPa', 2, b => u16(b[0], b[1]) / 200, 0, 330, 1],
  0x54: ['ضغط بخار EVAP', 'Pa', 2, b => S16(b[0], b[1]), -32768, 32767, 0],
  0x55: ['تعديل O2 الثانوي قصير بنك1', '%', 1, b => trim(b[0]), -30, 30, 1],
  0x56: ['تعديل O2 الثانوي طويل بنك1', '%', 1, b => trim(b[0]), -30, 30, 1],
  0x57: ['تعديل O2 الثانوي قصير بنك2', '%', 1, b => trim(b[0]), -30, 30, 1],
  0x58: ['تعديل O2 الثانوي طويل بنك2', '%', 1, b => trim(b[0]), -30, 30, 1],
  0x59: ['ضغط سكة الوقود المطلق', 'kPa', 2, b => u16(b[0], b[1]) * 10, 0, 200000, 0],
  0x5a: ['دعسة البنزين النسبية', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x5b: ['شحن البطارية الهجينة', '%', 1, b => pct(b[0]), 0, 100, 0],
  0x5c: ['حرارة الزيت', '°C', 1, b => b[0] - 40, -40, 160, 0, { ok: [80, 120], warn: [60, 135], when: 'warm' }],
  0x5d: ['توقيت الحقن', '°', 2, b => u16(b[0], b[1]) / 128 - 210, -210, 300, 1],
  0x5e: ['معدّل استهلاك الوقود', 'L/h', 2, b => u16(b[0], b[1]) / 20, 0, 50, 1],
  0x61: ['العزم المطلوب من السائق', '%', 1, b => b[0] - 125, -125, 130, 0],
  0x62: ['العزم الفعلي', '%', 1, b => b[0] - 125, -125, 130, 0],
  0x63: ['العزم المرجعي', 'Nm', 2, b => u16(b[0], b[1]), 0, 2000, 0],
  0x67: ['حرارة التبريد (حساسات)', '°C', 3, b => b[1] - 40, -40, 130, 0],
  0x68: ['حرارة السحب (حساسات)', '°C', 7, b => b[1] - 40, -40, 100, 0],
  0xa6: ['عدّاد المسافة', 'km', 4, b => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) / 10, 0, 1e6, 0],
};
// O2 sensor PIDs (narrow band) 0x14..0x1B
for (let i = 0; i < 8; i++) {
  const bank = Math.floor(i / 4) + 1, s = (i % 4) + 1;
  PIDS[0x14 + i] = [`حساس الأكسجين بنك${bank} حساس${s}`, 'V', 2, b => b[0] / 200, 0, 1.1, 2, { ok: [0, 1.0], warn: [0, 1.1] }];
  PIDS[0x24 + i] = [`حساس O2 واسع بنك${bank} حساس${s} (λ)`, 'λ', 4, b => u16(b[0], b[1]) * 2 / 65536, 0, 2, 3];
  PIDS[0x34 + i] = [`حساس O2 واسع بنك${bank} حساس${s} (تيار)`, 'mA', 4, b => u16(b[2], b[3]) / 256 - 128, -5, 5, 2];
}
export const SUPPORT_PIDS = [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0];
const OBD_STD = { 1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD و OBD-II', 4: 'OBD-I', 5: 'غير متوافق OBD', 6: 'EOBD (أوروبا)', 7: 'EOBD و OBD-II', 8: 'EOBD و OBD', 9: 'EOBD و OBD و OBD-II', 10: 'JOBD (اليابان)', 11: 'JOBD و OBD-II', 12: 'JOBD و EOBD', 13: 'JOBD و EOBD و OBD-II', 17: 'EMD', 18: 'EMD+', 19: 'HD OBD-C', 20: 'HD OBD', 21: 'WWH OBD', 23: 'HD EOBD-I', 29: 'KOBD (كوريا)', 30: 'IOBD (الهند)', 33: 'Brazil OBD', 34: 'China OBD' };
const FUEL = { 1: 'بنزين', 2: 'ميثانول', 3: 'إيثانول', 4: 'ديزل', 5: 'LPG', 6: 'CNG', 8: 'كهرباء', 9: 'ثنائي بنزين', 16: 'هجين بنزين', 17: 'هجين إيثانول', 18: 'هجين ديزل', 19: 'هجين كهربائي' };
function fuelSys(a) { return ({ 0: '—', 1: 'حلقة مفتوحة (تسخين)', 2: 'حلقة مغلقة (طبيعي)', 4: 'حلقة مفتوحة (حِمل/تخفيف)', 8: 'حلقة مفتوحة (عطل)', 16: 'حلقة مغلقة مع عطل حساس' })[a] || hex2(a); }
function o2map(a, banks) { const out = []; for (let i = 0; i < 8; i++) if (a & (1 << i)) out.push(banks === 2 ? `ب${(i >> 2) + 1}ح${(i & 3) + 1}` : `ب${(i >> 1) + 1}ح${(i & 1) + 1}`); return out.join('، ') || 'لا شيء'; }

export function pidName(pid) { return PIDS[pid]?.[0] || `PID 0x${hex2(pid)} (غير موجود في الجدول القياسي — بيانات خام)`; }
export function decodePid(pid, bytes) {
  const d = PIDS[pid];
  if (!d || !d[3]) return { value: null, text: bytes.map(hex2).join(' '), unit: '', raw: true };
  try {
    const v = d[3](bytes);
    return { value: typeof v === 'number' ? v : null, text: typeof v === 'number' ? v.toFixed(d[6] ?? 0) : v, unit: d[1] };
  } catch { return { value: null, text: bytes.map(hex2).join(' '), unit: '', raw: true }; }
}
// Health status of a value vs its normal range. ctx = {running, warm, charge}
export function rangeStatus(pid, v, ctx = {}) {
  let hl = PIDS[pid]?.[7];
  if (!hl || v == null) return { st: 'na' };
  // the ECM's own voltage follows the charging strategy of the car (see chargeRange)
  if (pid === 0x42 && ctx.charge?.rvc) hl = { ...hl, ok: [ctx.charge.ok[0] - 0.2, hl.ok[1]], warn: [ctx.charge.warn[0] - 0.2, hl.warn[1]] };
  if (hl.when === 'running' && !ctx.running) return { st: 'na', note: 'يُقيَّم والمكينة شغالة' };
  if (hl.when === 'warm' && !ctx.warm) return { st: 'na', note: 'يُقيَّم بعد تسخين المكينة' };
  if (v >= hl.ok[0] && v <= hl.ok[1]) return { st: 'ok', hl };
  if (hl.warn && v >= hl.warn[0] && v <= hl.warn[1]) return { st: 'warn', hl };
  return { st: 'bad', hl };
}
export const VOLT_RANGES = { off: { ok: [12.4, 12.9], warn: [12.0, 13.1] }, running: { ok: [13.5, 14.8], warn: [13.0, 15.2] }, crank: { ok: [9.6, 13], warn: [9.0, 13] } };
// Charging voltage expected with the engine running, for this vehicle. GM cars and trucks from 2007
// use Regulated Voltage Control (RVC): with a charged battery and light loads the computer lowers
// charging on purpose to about 12.6–13.1V ("fuel economy mode") and raises it under load — normal
// operation, not a weak alternator. Elsewhere the classic 13.5–14.8V applies.
export function chargeRange(v = {}) {
  const rvc = v?.group === 'GM' && (+v?.year || 0) >= 2007;
  return rvc
    ? { ok: [12.6, 14.8], warn: [12.4, 15.2], rvc: true, note: 'جنرال موتورز (نظام RVC): 12.6–13.1V بدون أحمال والبطارية مشحونة طبيعي، وتحت حِمل (أنوار/مكيف/مروحة) يرتفع إلى ~13.9–14.5V' }
    : { ok: [13.5, 14.8], warn: [13.0, 15.2], rvc: false, note: '' };
}

/* ------------------------------ DTCs ------------------------------ */
export function dtcFromBytes(a, b) {
  const sys = 'PCBU'[a >> 6];
  return sys + ((a >> 4) & 3) + (a & 15).toString(16).toUpperCase() + hex2(b);
}
function parseDtcList(bytes, isCan) {
  const out = [];
  let i = 1;
  if (isCan) { const n = bytes[1]; if ((bytes.length - 2) / 2 === n || bytes.length - 2 >= n * 2) i = 2; }
  for (; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) continue;
    out.push(dtcFromBytes(bytes[i], bytes[i + 1]));
  }
  return [...new Set(out)];
}

/* ------------------------- readiness ------------------------- */
export const MONITORS_SPARK = ['الحفاز (Catalyst)', 'الحفاز المسخَّن', 'نظام البخار EVAP', 'الهواء الثانوي', 'غاز المكيف (قديم)', 'حساسات الأكسجين', 'سخّان حساسات الأكسجين', 'EGR / VVT'];
export const MONITORS_DIESEL = ['حفاز NMHC', 'NOx / SCR', 'محجوز', 'ضغط التيربو', 'محجوز', 'حساس غازات العادم', 'فلتر الجزيئات DPF', 'EGR / VVT'];
export function decodeReadiness(b) {
  const [A, B, C, D] = b;
  const diesel = !!(B & 0x08);
  const mons = [];
  const cont = ['احتراق ناقص (Misfire)', 'نظام الوقود', 'المكوّنات الشاملة'];
  cont.forEach((n, i) => mons.push({ name: n, cont: true, sup: !!(B & (1 << i)), ready: !(B & (1 << (i + 4))) }));
  (diesel ? MONITORS_DIESEL : MONITORS_SPARK).forEach((n, i) => {
    if (n === 'محجوز') return;
    mons.push({ name: n, sup: !!(C & (1 << i)), ready: !(D & (1 << i)) });
  });
  return { mil: !!(A & 0x80), dtcCount: A & 0x7f, diesel, mons };
}
// Readiness of several emission computers as one vehicle status (SAE J1979): a monitor is
// supported if any computer supports it and complete only when every computer that supports it
// reports it complete; the MIL is on if any computer commands it. entries: [[ecu, readiness], …]
export function combineReadiness(entries) {
  const list = (entries || []).filter(([, r]) => r && Array.isArray(r.mons));
  if (!list.length) return null;
  const score = r => r.mons.filter(m => m.sup).length;
  const base = list.slice().sort((a, b) => score(b[1]) - score(a[1]))[0][1]; // normally the engine computer
  const mons = base.mons.map(m => ({ name: m.name, cont: !!m.cont, sup: !!m.sup, ready: !!m.ready }));
  for (const [, r] of list) {
    if (r === base) continue;
    for (const m of r.mons) {
      if (!m.sup) continue;
      const x = mons.find(y => y.name === m.name);
      if (!x) mons.push({ name: m.name, cont: !!m.cont, sup: true, ready: !!m.ready });
      else if (!x.sup) { x.sup = true; x.ready = !!m.ready; } else if (!m.ready) x.ready = false;
    }
  }
  return { mil: list.some(([, r]) => r.mil), dtcCount: list.reduce((s, [, r]) => s + (r.dtcCount || 0), 0), diesel: !!base.diesel, mons, count: list.length };
}
// Completion counted over the non-continuous monitors (the ones an emissions inspection checks).
export function readinessStats(r) {
  if (!r) return null;
  const sup = r.mons.filter(m => m.sup && !m.cont), notReady = sup.filter(m => !m.ready);
  return { total: sup.length, ready: sup.length - notReady.length, notReady };
}

/* --------------------------- Mode 06 --------------------------- */
const UAS = {
  0x01: [1, ''], 0x02: [0.1, ''], 0x03: [0.01, ''], 0x04: [0.001, ''], 0x05: [0.0000305, ''], 0x06: [0.000305, ''], 0x07: [0.25, 'rpm'], 0x08: [0.01, 'km/h'], 0x09: [1, 'km/h'],
  0x0a: [0.122, 'mV'], 0x0b: [0.001, 'V'], 0x0c: [0.01, 'V'], 0x0d: [0.00390625, 'mA'], 0x0e: [0.001, 'A'], 0x0f: [0.01, 'A'], 0x10: [1, 'ms'], 0x11: [100, 'ms'], 0x12: [1, 's'],
  0x13: [1, 'mΩ'], 0x14: [1, 'Ω'], 0x15: [1, 'kΩ'], 0x16: [0.1, '°C', -40], 0x17: [0.01, 'kPa'], 0x18: [0.0117, 'kPa'], 0x19: [0.079, 'kPa'], 0x1a: [1, 'kPa'], 0x1b: [10, 'kPa'],
  0x1c: [0.01, '°'], 0x1d: [0.5, '°'], 0x1e: [0.0000305, 'λ'], 0x1f: [0.05, 'A/F'], 0x20: [0.0039062, ''], 0x21: [1, 'mHz'], 0x22: [1, 'Hz'], 0x23: [1, 'kHz'], 0x24: [1, 'عدّة'],
  0x25: [1, 'km'], 0x26: [0.1, 'mV/ms'], 0x27: [0.01, 'g/s'], 0x28: [1, 'g/s'], 0x29: [0.25, 'Pa/s'], 0x2a: [0.001, 'kg/h'], 0x2b: [1, 'تبديل'], 0x2c: [0.01, 'g/cyl'], 0x2d: [0.01, 'mg/stroke'],
  0x2e: [1, ''], 0x2f: [0.01, '%'], 0x30: [0.001526, '%'], 0x31: [0.001, 'L'], 0x32: [0.0000305, 'in'], 0x33: [0.00024414, ''], 0x34: [1, 'min'], 0x35: [10, 'ms'], 0x36: [0.01, 'g'], 0x37: [0.1, 'g'], 0x38: [1, 'g'],
  0x81: [1, '', 0, 1], 0x82: [0.1, '', 0, 1], 0x83: [0.01, '', 0, 1], 0x84: [0.001, '', 0, 1], 0x85: [0.0000305, '', 0, 1], 0x86: [0.000305, '', 0, 1], 0x8a: [0.122, 'mV', 0, 1], 0x8b: [0.001, 'V', 0, 1], 0x8c: [0.01, 'V', 0, 1],
  0x8d: [0.00390625, 'mA', 0, 1], 0x8e: [0.001, 'A', 0, 1], 0x90: [1, 'ms', 0, 1], 0x96: [0.1, '°C', 0, 1], 0x9c: [0.01, '°', 0, 1], 0x9d: [0.5, '°', 0, 1], 0xa8: [1, 'g/s', 0, 1], 0xa9: [0.25, 'Pa/s', 0, 1], 0xaf: [0.01, '%', 0, 1], 0xfc: [0.01, 'kPa', 0, 1], 0xfd: [0.001, 'kPa', 0, 1], 0xfe: [0.25, 'Pa', 0, 1],
};
export function midName(m) {
  if (m >= 0x01 && m <= 0x10) { const i = m - 1; return `مراقب حساس الأكسجين بنك${(i >> 2) + 1} حساس${(i & 3) + 1}`; }
  if (m >= 0x41 && m <= 0x50) { const i = m - 0x41; return `مراقب سخّان حساس الأكسجين بنك${(i >> 2) + 1} حساس${(i & 3) + 1}`; }
  if (m >= 0xa2 && m <= 0xad) return `احتراق ناقص — سلندر ${m - 0xa1}`;
  return ({ 0x21: 'الحفاز بنك1', 0x22: 'الحفاز بنك2', 0x23: 'الحفاز بنك3', 0x24: 'الحفاز بنك4', 0x31: 'EGR بنك1', 0x32: 'EGR بنك2', 0x35: 'VVT بنك1', 0x36: 'VVT بنك2', 0x39: 'تسريب EVAP ‎(0.150″)', 0x3a: 'تسريب EVAP ‎(0.090″)', 0x3b: 'تسريب EVAP ‎(0.040″)', 0x3c: 'تسريب EVAP ‎(0.020″)', 0x3d: 'تدفق التنقية EVAP', 0x61: 'الحفاز المسخّن بنك1', 0x62: 'الحفاز المسخّن بنك2', 0x71: 'الهواء الثانوي 1', 0x72: 'الهواء الثانوي 2', 0x81: 'نظام الوقود بنك1', 0x82: 'نظام الوقود بنك2', 0x85: 'ضغط التيربو بنك1', 0x86: 'ضغط التيربو بنك2', 0x90: 'NOx بنك1', 0x98: 'حفاز NOx بنك1', 0xa1: 'احتراق ناقص — عام', 0xb0: 'فلتر الجزيئات بنك1', 0xb1: 'فلتر الجزيئات بنك2' })[m] || `مراقب 0x${hex2(m)}`;
}
function tidName(mid, tid) {
  if (mid >= 0xa1 && mid <= 0xad) return ({ 0x0b: 'متوسط الاحتراق الناقص (آخر 10 دورات)', 0x0c: 'عدد الاحتراق الناقص (الدورة الحالية/الأخيرة)' })[tid] || `اختبار 0x${hex2(tid)}`;
  if (tid >= 0x80) return `اختبار المصنّع 0x${hex2(tid)}`;
  return ({ 0x01: 'عتبة غني→فقير', 0x02: 'عتبة فقير→غني', 0x03: 'فولت منخفض لزمن التبديل', 0x04: 'فولت مرتفع لزمن التبديل', 0x05: 'زمن تبديل غني→فقير', 0x06: 'زمن تبديل فقير→غني', 0x07: 'أدنى فولت', 0x08: 'أعلى فولت', 0x09: 'زمن بين التحولات', 0x0a: 'فترة الحساس' })[tid] || `اختبار 0x${hex2(tid)}`;
}
function uasVal(uas, a, b) {
  const u = UAS[uas];
  if (!u) return { v: u16(a, b), unit: '(وحدة غير معروفة)', known: false };
  const raw = u[3] ? S16(a, b) : u16(a, b);
  return { v: raw * u[0] + (u[2] || 0), unit: u[1], known: true };
}

/* ======================= service functions ======================= */
export class Obd {
  constructor(elm) { this.elm = elm; this.uds = false; this.sup = new Map(); }
  get isCan() { return this.elm.isCan; }

  // Discover supported mode-01 PIDs per ECU (functional broadcast). No fixed lists.
  async discoverPids() {
    await this.elm.functional();
    const sup = new Map(); // ecu → Set
    let base = 0;
    let more = true; const asked = new Set();
    while (more && base <= 0xe0) {
      more = false; asked.add(base);
      const r = await this.elm.request('01' + hex2(base), 6000);
      for (const m of r.msgs) {
        if (m.neg || m.bytes[0] !== 0x41 || m.bytes[1] !== base) continue;
        const set = sup.get(m.ecu) || new Set(); sup.set(m.ecu, set);
        const bm = m.bytes.slice(2, 6);
        for (let i = 0; i < 32; i++) if (bm[i >> 3] & (0x80 >> (i & 7))) set.add(base + i + 1);
        if (set.has(base + 0x20)) more = true;
      }
      base += 0x20;
    }
    if (!sup.size && this.isCan) {
      // J1979-2 / OBDonUDS best effort
      const r = await this.elm.request('22F400', 5000);
      for (const m of r.msgs) {
        if (m.neg || m.bytes[0] !== 0x62) continue;
        this.uds = true;
        const set = new Set(); sup.set(m.ecu, set);
        const bm = m.bytes.slice(3, 7);
        for (let i = 0; i < 32; i++) if (bm[i >> 3] & (0x80 >> (i & 7))) set.add(i + 1);
      }
    }
    this.sup = sup;
    return sup;
  }
  // Read a list of PIDs (from one ECU's supported set). Uses multi-PID requests on CAN.
  async readPids(pids, onlyEcu = null) {
    const res = new Map(); // `${ecu}:${pid}` → {ecu,pid,bytes,...decoded}
    if (!pids.length) return res;
    await this.elm.functional();
    const groups = [];
    const known = pids.filter(p => PIDS[p] && PIDS[p][2]);
    const unknown = pids.filter(p => !(PIDS[p] && PIDS[p][2]));
    if (this.isCan && !this.uds) { for (let i = 0; i < known.length; i += 6) groups.push(known.slice(i, i + 6)); unknown.forEach(p => groups.push([p])); }
    else pids.forEach(p => groups.push([p]));
    for (const g of groups) {
      const req = this.uds ? '22F4' + hex2(g[0]) : '01' + g.map(hex2).join('');
      const r = await this.elm.request(req, 3000);
      for (const m of r.msgs) {
        if (onlyEcu && m.ecu !== onlyEcu) continue;
        if (m.neg) continue;
        const b = m.bytes;
        if (this.uds) { if (b[0] === 0x62) this._put(res, m.ecu, g[0], b.slice(3)); continue; }
        if (b[0] !== 0x41) continue;
        let i = 1;
        while (i < b.length) {
          const pid = b[i]; const len = PIDS[pid]?.[2];
          if (g.length === 1 && pid === g[0]) { this._put(res, m.ecu, pid, b.slice(i + 1)); break; }
          if (!len || !g.includes(pid)) break;
          this._put(res, m.ecu, pid, b.slice(i + 1, i + 1 + len));
          i += 1 + len;
        }
      }
    }
    return res;
  }
  _put(res, ecu, pid, bytes) { res.set(`${ecu}:${pid}`, { ecu, pid, bytes, ...decodePid(pid, bytes) }); }

  async readDtcs(mode) {
    await this.elm.functional();
    const out = new Map();
    if (this.uds) {
      const mask = { '03': '08', '07': '04', '0A': '08' }[mode];
      const r = await this.elm.request('1902' + mask, 6000);
      for (const m of r.msgs) {
        if (m.neg || m.bytes[0] !== 0x59) continue;
        const codes = []; for (let i = 3; i + 3 < m.bytes.length; i += 4) codes.push(dtcFromBytes(m.bytes[i], m.bytes[i + 1]));
        out.set(m.ecu, codes);
      }
      return { map: out, error: r.ok ? null : r.error };
    }
    const r = await this.elm.request(mode, 8000);
    const want = parseInt(mode, 16) + 0x40;
    for (const m of r.msgs) {
      if (m.neg) { out.set(m.ecu, out.get(m.ecu) || []); continue; }
      if (m.bytes[0] !== want) continue;
      const prev = out.get(m.ecu) || [];
      out.set(m.ecu, [...new Set([...prev, ...parseDtcList(m.bytes, this.isCan)])]);
    }
    return { map: out, error: r.ok ? null : r.error, raw: r.raw };
  }
  async readiness() {
    const r = await this.readPids([0x01]);
    const r41 = await this.readPids([0x41]);
    const out = new Map();
    for (const v of r.values()) out.set(v.ecu, { ...decodeReadiness(v.bytes), cycle: null });
    for (const v of r41.values()) { const o = out.get(v.ecu); if (o) o.cycle = decodeReadiness(v.bytes); }
    return out;
  }
  // Freeze frame (Mode 02, frame 0). PID 02 names the code that stored the frame; 0000 means no
  // frame is stored, so nothing is shown for that computer. Support PIDs (00/20/40…) are bitmaps
  // that announce the next range — they are followed, never shown as data.
  async freezeFrame() {
    await this.elm.functional();
    const sup = new Map(); // ecu → Set of announced PIDs
    let base = 0, more = true;
    while (more && base <= 0xe0) {
      more = false;
      const r = await this.elm.request('02' + hex2(base) + '00', 4000);
      for (const m of r.msgs) {
        if (m.neg || m.bytes[0] !== 0x42 || m.bytes[1] !== base) continue;
        const set = sup.get(m.ecu) || new Set(); sup.set(m.ecu, set);
        const bm = m.bytes.slice(3, 7);
        for (let i = 0; i < 32; i++) if (bm[i >> 3] & (0x80 >> (i & 7))) set.add(base + i + 1);
        if (set.has(base + 0x20)) more = true;
      }
      base += 0x20;
    }
    const trigger = new Map(); // ecu → code, or null when the computer reports 0000 (no frame stored)
    if ([...sup.values()].some(s => s.has(2))) {
      const r = await this.elm.request('020200', 3000);
      for (const m of r.msgs) {
        if (m.neg || m.bytes[0] !== 0x42 || m.bytes[1] !== 2 || !sup.has(m.ecu)) continue;
        const d = m.bytes.slice(3);
        trigger.set(m.ecu, d[0] || d[1] ? dtcFromBytes(d[0], d[1]) : null);
      }
    }
    const none = ecu => trigger.has(ecu) && trigger.get(ecu) === null;
    const items = new Map([...sup.keys()].filter(e => !none(e)).map(e => [e, []]));
    const isData = p => p % 0x20 !== 0 && p !== 0x01 && p !== 0x02 && p !== 0x41;
    const pids = [...new Set([...items.keys()].flatMap(e => [...sup.get(e)]))].filter(isData).sort((a, b) => a - b);
    for (const pid of pids) { // one request per PID; every computer that stored a frame answers it
      const r = await this.elm.request('02' + hex2(pid) + '00', 3000);
      for (const m of r.msgs) {
        if (m.neg || m.bytes[0] !== 0x42 || m.bytes[1] !== pid || !items.has(m.ecu) || !sup.get(m.ecu).has(pid)) continue;
        items.get(m.ecu).push({ pid, name: pidName(pid), ...decodePid(pid, m.bytes.slice(3)) });
      }
    }
    const out = new Map();
    for (const ecu of sup.keys()) out.set(ecu, none(ecu) ? { dtc: null, items: [], none: true } : { dtc: trigger.get(ecu) || null, items: items.get(ecu) || [] });
    return out;
  }
  async supportBitmap(modeHex, extraZero = '') {
    // generic: mode XX, ids 00,20,40...  → Map ecu → Set
    await this.elm.functional();
    const out = new Map();
    for (let base = 0; base <= 0xe0; base += 0x20) {
      const r = await this.elm.request(modeHex + hex2(base) + extraZero, 4000);
      let more = false;
      for (const m of r.msgs) {
        if (m.neg || m.bytes[0] !== parseInt(modeHex, 16) + 0x40 || m.bytes[1] !== base) continue;
        const set = out.get(m.ecu) || new Set(); out.set(m.ecu, set);
        const bm = m.bytes.slice(2 + (extraZero ? 1 : 0), 6 + (extraZero ? 1 : 0));
        for (let i = 0; i < 32; i++) if (bm[i >> 3] & (0x80 >> (i & 7))) set.add(base + i + 1);
        if (set.has(base + 0x20)) more = true;
      }
      if (!more) break;
    }
    return out;
  }
  async mode06() {
    await this.elm.functional();
    if (!this.isCan) {
      // legacy format: best effort raw listing
      const r = await this.elm.request('0600', 5000);
      return { legacy: true, raw: r.raw, map: new Map() };
    }
    const sup = await this.supportBitmap('06');
    const out = new Map();
    for (const [ecu, set] of sup) {
      const rows = [];
      for (const mid of [...set].filter(m => m % 0x20 !== 0)) {
        const r = await this.elm.request('06' + hex2(mid), 4000);
        for (const m of r.msgs) {
          if (m.ecu !== ecu || m.neg || m.bytes[0] !== 0x46 || m.bytes[1] !== mid) continue;
          const b = m.bytes;
          // SAE J1979 on CAN: each test record repeats the MID — [MID TID UASID TV(2) MIN(2) MAX(2)]
          for (let i = 1; i + 8 < b.length; i += 9) {
            if (b[i] !== mid) break;
            const tid = b[i + 1], uas = b[i + 2];
            const val = uasVal(uas, b[i + 3], b[i + 4]), mn = uasVal(uas, b[i + 5], b[i + 6]), mx = uasVal(uas, b[i + 7], b[i + 8]);
            const pass = val.v >= mn.v && val.v <= mx.v;
            rows.push({ mid, tid, midName: midName(mid), tidName: tidName(mid, tid), value: val.v, min: mn.v, max: mx.v, unit: val.unit, known: val.known, pass });
          }
        }
      }
      out.set(ecu, rows);
    }
    return { legacy: false, map: out };
  }
  async mode05() {
    if (this.isCan) return { notOnCan: true };
    await this.elm.functional();
    const r = await this.elm.request('050100', 5000);
    const rows = [];
    if (!r.ok) return { rows, error: r.error };
    const names = { 1: 'عتبة غني→فقير', 2: 'عتبة فقير→غني', 3: 'فولت منخفض للتبديل', 4: 'فولت مرتفع للتبديل', 5: 'زمن غني→فقير', 6: 'زمن فقير→غني', 7: 'أدنى فولت', 8: 'أعلى فولت', 9: 'زمن بين التحولات' };
    for (let tid = 1; tid <= 9; tid++) for (const o2 of [0x01, 0x02, 0x11, 0x12]) {
      const rr = await this.elm.request('05' + hex2(tid) + hex2(o2), 2500);
      for (const m of rr.msgs) {
        if (m.neg || m.bytes[0] !== 0x45) continue;
        const [, , , v, mn, mx] = m.bytes;
        const time = tid >= 5 && tid !== 7 && tid !== 8;
        const k = time ? 0.004 : 0.005;
        rows.push({ ecu: m.ecu, tid, o2, name: names[tid] || 'اختبار ' + tid, sensor: `ب${(o2 >> 4) + 1}ح${o2 & 15}`, value: v * k, min: mn != null ? mn * k : null, max: mx != null ? mx * k : null, unit: time ? 's' : 'V' });
      }
    }
    return { rows };
  }
  async mode09() {
    await this.elm.functional();
    const sup = await this.supportBitmap('09');
    const out = new Map();
    const ascii = b => b.filter(x => x >= 0x20 && x < 0x7f).map(x => String.fromCharCode(x)).join('').trim();
    for (const [ecu, set] of sup) {
      const info = { supported: [...set] };
      for (const t of [2, 4, 6, 8, 0x0a, 0x0b, 0x0d]) {
        if (!set.has(t)) continue;
        const r = await this.elm.request('09' + hex2(t), 6000);
        const msgs = r.msgs.filter(m => m.ecu === ecu && !m.neg && m.bytes[0] === 0x49 && m.bytes[1] === t);
        if (!msgs.length) continue;
        // CAN: one message [49 t N data]; legacy: many [49 t seq data4]
        const data = this.isCan ? msgs[0].bytes.slice(3) : msgs.sort((a, b) => a.bytes[2] - b.bytes[2]).flatMap(m => m.bytes.slice(3));
        if (t === 2) info.vin = ascii(data).slice(-17);
        if (t === 4) { const ids = []; for (let i = 0; i < data.length; i += 16) { const s = ascii(data.slice(i, i + 16)); if (s) ids.push(s); } info.calid = ids; }
        if (t === 6) { const c = []; for (let i = 0; i + 3 < data.length; i += 4) c.push(data.slice(i, i + 4).map(hex2).join('')); info.cvn = c; }
        if (t === 0x0a) info.ecuName = ascii(data).replace(/\0/g, ' ').replace(/\s+/g, ' ');
        if (t === 0x0d) info.esn = ascii(data);
        if (t === 8 || t === 0x0b) {
          const n = []; for (let i = 0; i + 1 < data.length; i += 2) n.push(u16(data[i], data[i + 1]));
          const L = t === 8 ? ['OBDCOND', 'IGNCNTR', 'CAT1 comp', 'CAT1 cond', 'CAT2 comp', 'CAT2 cond', 'O2S1 comp', 'O2S1 cond', 'O2S2 comp', 'O2S2 cond', 'EGR comp', 'EGR cond', 'AIR comp', 'AIR cond', 'EVAP comp', 'EVAP cond', 'SO2S1 comp', 'SO2S1 cond', 'SO2S2 comp', 'SO2S2 cond'] : [];
          info.ipt = n.map((v, i) => ({ k: L[i] || '#' + i, v }));
        }
      }
      out.set(ecu, info);
    }
    return out;
  }
  async mode08Supported() { await this.elm.functional(); return this.supportBitmap('08', '00'.repeat(0)); }
  async runMode08(tid) { await this.elm.functional(); return this.elm.request('08' + hex2(tid) + '0000000000', 15000); }
  async clearAll() { await this.elm.functional(); return this.elm.request(this.uds ? '14FFFFFF' : '04', 10000); }
}

// ECU address naming for standard responders.
export function stdEcuName(ecu, isCan, is29) {
  if (isCan && !is29) {
    const n = parseInt(ecu, 16) - 0x7e8;
    if (n >= 0 && n <= 7) return { name: n === 0 ? 'كمبيوتر المكينة (ECM/PCM)' : `كمبيوتر انبعاثات #${n + 1}${n <= 2 ? ' (غالبًا القير)' : ''}`, addr: `0x${hex3(0x7e0 + n)} → 0x${ecu}`, conf: n === 0 ? 'best' : 'est', req: 0x7e0 + n, res: 0x7e8 + n };
  }
  if (isCan && is29) return { name: ecu === '10' ? 'كمبيوتر المكينة (ECM)' : ecu === '18' ? 'كمبيوتر القير (TCM)' : `كمبيوتر 0x${ecu}`, addr: `18DAF1${ecu}`, conf: 'est' };
  return { name: ecu === '10' ? 'كمبيوتر المكينة (ECM)' : ecu === '18' ? 'كمبيوتر القير (TCM)' : `كمبيوتر 0x${ecu}`, addr: '0x' + ecu, conf: 'est' };
}
