// GM manufacturer readings (Mode $22) and computer identification (GMLAN $1A) for GM CAN cars
// (E38/E67-class engine computer, 6L80-class transmission computer, body computer). Read during a
// recorded session on top of the standard values. Each reading is probed once: the ones the car
// refuses are dropped, so a car (or a V6) that lacks one simply never shows it. Scaling comes from
// community sources (see the research notes): «best» = checked against captured answers or a
// gauge by more than one source, «est» = one source / unverified — the report says which.
import { hex2, hex3 } from './util.js';
import { app, exclusive } from './core.js';

const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');
const u16 = b => (b[0] << 8) | b[1];
const s16 = b => { const v = u16(b); return v & 0x8000 ? v - 0x10000 : v; };
const ECM = { m: 'كمبيوتر المكينة', req: 0x7e0, res: 0x7e8 }, TCM = { m: 'كمبيوتر القير', req: 0x7e2, res: 0x7ea }, BCM = { m: 'كمبيوتر الهيكل', req: 0x241, res: 0x641 };
const P = (mod, did, n, u, f, l = 'est', extra = {}) => ({ ...mod, did, n, u, f, l, ...extra });
export const GM_PIDS = [
  P(ECM, 0x1470, 'ضغط زيت المكينة', 'kPa', b => b[0] * 4, 'best', { rg: { ok: [100, 700], warn: [60, 800], when: 'running' }, d: 'ضغط الزيت الفعلي من الحساس. ×0.145 = psi. على الخمول الحار عادة 100 kPa (15 psi) أو أكثر.' }),
  P(ECM, 0x1154, 'حرارة زيت المكينة', '°C', b => b[0] - 40, 'best', { rg: { ok: [70, 125], warn: [50, 135], when: 'warm' }, d: 'حرارة الزيت داخل المكينة.' }),
  P(ECM, 0x1141, 'فولت تغذية التشغيل (Ignition 1)', 'V', b => b[0] / 10, 'est', { rg: { ok: [11.5, 15], warn: [10.5, 15.5] }, d: 'الفولت الواصل للكمبيوتر من خط التشغيل — فرقه عن فولت البطارية يكشف هبوط في التغذية.' }),
  P(ECM, 0x1192, 'الخمول المطلوب من الكمبيوتر', 'rpm', b => b[0] * 12.5, 'est', { d: 'الدوران اللي يستهدفه الكمبيوتر على الخمول؛ قارنه بالدوران الفعلي.' }),
  P(ECM, 0x119E, 'نسبة الهواء/الوقود المطلوبة', 'AFR', b => b[0] / 10, 'est', { d: 'الخلطة اللي يطلبها الكمبيوتر (14.7 = مثالية للبنزين).' }),
  P(ECM, 0x11A6, 'سحب التوقيت بسبب الطَّرق (Knock retard)', '°', b => b[0] * 0.09, 'est', { d: 'كم درجة يأخر الكمبيوتر الشرارة لأنه سمع طرق. المقياس غير مؤكد — المهم: صفر طبيعي، وأي رقم ثابت عالي يعني طرق أو حساس طرق يلقط ضجيج.' }),
  P(ECM, 0x1161, 'حرارة الجو (من حساس السيارة)', '°C', b => b[0] - 40, 'est'),
  P(ECM, 0x1564, 'ضغط غاز المكيف — الجهة العالية', 'psi', b => b[0] * 2.02, 'est', { d: 'ضغط الفريون في الجهة العالية والمكيف شغال (يعتمد على الجو).' }),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(c => P(ECM, 0x1192 + c, `زمن فتح البخاخ — سلندر ${c}`, 'ms', b => u16(b) / 65.5, 'est', { d: 'مدة فتح البخاخ في كل دورة؛ البخاخات المتقاربة طبيعي.' })),
  ...[1, 2, 3, 4].map(c => P(ECM, 0x1204 + c, `احتراق ناقص الآن — سلندر ${c}`, 'عدّة', b => b[0], 'est', { rg: { ok: [0, 2], warn: [0, 10], when: 'running' }, d: 'عدد مرات الاحتراق الناقص الحالية لهذا السلندر.' })),
  ...[5, 6, 7, 8].map(c => P(ECM, 0x11e5 + c, `احتراق ناقص الآن — سلندر ${c}`, 'عدّة', b => b[0], 'est', { rg: { ok: [0, 2], warn: [0, 10], when: 'running' }, d: 'عدد مرات الاحتراق الناقص الحالية لهذا السلندر.' })),
  ...[1, 2, 3, 4].map(c => P(ECM, 0x1200 + c, `سجل الاحتراق الناقص — سلندر ${c}`, 'عدّة', b => u16(b), 'est', { d: 'مجموع الاحتراق الناقص المسجّل لهذا السلندر.' })),
  ...[5, 6, 7, 8].map(c => P(ECM, 0x11f3 + c, `سجل الاحتراق الناقص — سلندر ${c}`, 'عدّة', b => u16(b), 'est', { d: 'مجموع الاحتراق الناقص المسجّل لهذا السلندر.' })),
  P(TCM, 0x1940, 'حرارة زيت القير', '°C', b => b[0] - 40, 'best', { rg: { ok: [40, 105], warn: [20, 120], when: 'running' }, d: 'حرارة زيت القير. فوق 120°C ضرر على الزيت والقير.' }),
  P(TCM, 0x199A, 'الغيار الحالي', '', b => b[0], 'best', { d: 'رقم الغيار اللي القير فيه الآن.' }),
  P(TCM, 0x1991, 'انزلاق كلتش محوّل العزم', 'rpm', b => s16(b) / 8, 'est', { d: 'الفرق بين دوران المكينة ودخل القير. مع قفل الكلتش على السرعة يكون قريب من صفر.' }),
  P(TCM, 0x1992, 'زمن آخر تبديل غيار', 's', b => b[0] / 40, 'est', { d: 'كم استغرق آخر تبديل؛ الأطول من الطبيعي يعني انزلاق.' }),
  P(TCM, 0x199E, 'تيار صولونويد الضغط — الفعلي', 'A', b => b[0] * 0.0195, 'est'),
  P(TCM, 0x199F, 'تيار صولونويد الضغط — المطلوب', 'A', b => b[0] * 0.0195, 'est'),
  ...[1, 2, 3, 4].map(k => P(BCM, 0x5004 + k, `ضغط الكفر ${k}`, 'kPa', b => u16(b) / 16, 'best', { rg: { ok: [220, 320], warn: [180, 360] }, d: 'من حساسات ضغط الكفرات عبر كمبيوتر الهيكل (×0.145 = psi). ترتيب الكفرات حسب برمجة السيارة.' })),
];
const key = p => `${hex3(p.res)}:22${hex4(p.did)}`;
const sup = new Map(), fails = new Map();
let cursor = 0, pcursor = 0;
// the ones that matter most are read on every round; the rest take turns
const PRIORITY = new Set([0x1470, 0x1154, 0x1940, 0x199a, 0x1991, 0x11a6, 0x1141]);
export const gmPidInfo = k => GM_PIDS.find(p => key(p) === k || ('22' + hex4(p.did)) === k);

// Reads a few of the readings (rotating), from inside the live poll. Returns live entries.
export async function readGmBatch(max = 3) {
  const elm = app.conn.elm;
  if (!elm?.isCan || elm.is29 || app.vehicle.group !== 'GM') return [];
  const list = GM_PIDS.filter(p => sup.get(key(p)) !== false);
  if (!list.length) return [];
  const pri = list.filter(p => PRIORITY.has(p.did)), rest = list.filter(p => !PRIORITY.has(p.did));
  const batch = [];
  if (pri.length) batch.push(pri[pcursor++ % pri.length]);
  while (batch.length < max && rest.length && batch.length < list.length) { const p = rest[cursor++ % rest.length]; if (batch.includes(p)) break; batch.push(p); }
  if (batch.length < max && pri.length > 1) batch.push(pri[pcursor++ % pri.length]);
  const out = [];
  try {
    for (const p of batch) {
      await elm.physical(p.req, p.res);
      const r = await elm.request('22' + hex4(p.did), 700);
      const m = r.msgs.find(x => parseInt(x.ecu, 16) === p.res);
      if (!m) { const n = (fails.get(key(p)) || 0) + 1; fails.set(key(p), n); if (n >= 2) sup.set(key(p), false); continue; }
      if (m.neg) { sup.set(key(p), false); continue; }
      if (m.bytes[0] !== 0x62 || ((m.bytes[1] << 8) | m.bytes[2]) !== p.did || m.bytes.length < 4) continue;
      sup.set(key(p), true);
      const v = p.f(m.bytes.slice(3));
      if (!Number.isFinite(v)) continue;
      out.push({ key: key(p), ecu: hex3(p.res), pid: '22' + hex4(p.did), name: p.n, unit: p.u, value: v, text: Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0), gm: true, conf: p.l, mod: p.m });
    }
  } finally {
    try { await elm.clearPhysical(); await elm.functional(); } catch {}
  }
  return out;
}
export const gmSupported = () => GM_PIDS.filter(p => sup.get(key(p)) === true).length;
export function resetGm() { sup.clear(); fails.clear(); cursor = 0; }

/* ---------------- identification ---------------- */
const IDS = { 0x90: 'رقم الهيكل VIN', 0x92: 'المورّد', 0x97: 'اسم النظام / نوع المكينة', 0x98: 'رمز الورشة / جهاز البرمجة', 0x99: 'تاريخ البرمجة', 0x9a: 'معرّف بيانات التشخيص', 0xb0: 'عنوان التشخيص', 0xb4: 'رقم التتبع', 0xc1: 'رقم برنامج 1', 0xc2: 'رقم برنامج 2', 0xc3: 'رقم برنامج 3', 0xc4: 'رقم برنامج 4', 0xc5: 'رقم برنامج 5', 0xc6: 'رقم برنامج 6', 0xcb: 'رقم القطعة النهائي (End model)', 0xcc: 'رقم القطعة الأساسي (Base model)' };
const printable = b => b.length >= 3 && b.every(x => x >= 0x20 && x < 0x7f);
function decodeId(did, b) {
  if (!b.length || b.every(x => x === 0xff) || b.every(x => x === 0)) return ''; // empty / never programmed
  if (did === 0x99 && b.length >= 4) { const h = b.slice(0, 4).map(hex2).join(''); return /^\d{8}$/.test(h) ? `${h.slice(0, 4)}-${h.slice(4, 6)}-${h.slice(6, 8)}` : h; }
  if (printable(b)) return String.fromCharCode(...b).trim();
  if (b.length === 4 && (did >= 0xc0 && did <= 0xcc)) return String(((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]); // GM part number
  return b.map(hex2).join(' ');
}
// Reads the identity of the engine and transmission computers (and of the other computers the
// module scan found, from what it already read). Read-only requests.
export async function readIdentities() {
  if (!app.conn.ready || app.conn.elm?.is29 || !app.conn.elm?.isCan) return null;
  return exclusive('قراءة هوية الكمبيوترات', identify);
}
// The same, as a step inside an operation that already owns the adapter (the full scan).
export async function identify(step = () => {}, alive = () => {}) {
  {
    const elm = app.conn.elm, out = [];
    if (!elm?.isCan || elm.is29) return null;
    const targets = [ECM, TCM].filter(t => [...app.ecus.values()].some(e => e.std && parseInt(e.ecu, 16) === t.res));
    let k = 0;
    try {
      for (const t of targets) {
        const fields = [];
        await elm.physical(t.req, t.res);
        for (const did of Object.keys(IDS).map(Number)) {
          alive(); step(++k / (targets.length * 16), `${t.m}: ${IDS[did]}`);
          const r = await elm.request('1A' + hex2(did), 800);
          const m = r.msgs.find(x => parseInt(x.ecu, 16) === t.res);
          if (m && !m.neg && m.bytes[0] === 0x5a && m.bytes[1] === did) { const v = decodeId(did, m.bytes.slice(2)); if (v) fields.push([IDS[did], v]); }
          if (m?.neg && m.nrc === 0x11) break; // this computer does not speak GMLAN identification
        }
        out.push({ ecu: hex3(t.res), name: t.m, fields });
      }
    } finally { try { await elm.clearPhysical(); await elm.functional(); } catch {} }
    // what the module scan already read from the other computers
    for (const e of app.ecus.values()) {
      if (!e.ident || e.std) continue;
      // a GM part number read as 4 raw bytes ("01 5A FD 13") is shown as the number it is
      const pn = (x, v) => /^1AC[0-9A-C]$|^1ACB$|^1ACC$/i.test(x) && /^([0-9A-F]{2} ){3}[0-9A-F]{2}$/i.test(String(v)) ? String(parseInt(String(v).replace(/ /g, ''), 16)) : String(v);
      const fields = Object.entries(e.ident).filter(([x, v]) => x !== 'noUds' && !/^(FF ?)+$|^(00 ?)+$/i.test(String(v))).map(([x, v]) => [/^1A/.test(x) ? IDS[parseInt(x.slice(2), 16)] || x : { 61840: 'VIN', 61847: 'اسم النظام', 61836: 'الرقم التسلسلي', 61845: 'إصدار البرنامج', 61831: 'رقم القطعة', 61834: 'المورّد' }[x] || x, pn(x, v)]);
      if (fields.length) out.push({ ecu: e.addr || e.key, name: e.name, fields });
    }
    app.idents = out;
    return out;
  }
}
