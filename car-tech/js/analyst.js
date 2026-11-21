// Fault analyst: for every fault in the car, works like a mechanic + electrician + programmer.
// It follows the fault's circuit in the car's own wiring (pins, fuses, grounds), gathers evidence
// from the car (live values, freeze frame, other codes, Mode 6, which computers answer, voltage,
// the car's modifications), weighs the causes by area (electrical / mechanical / programming) with
// the reason for each, and builds a step-by-step test that runs on the car and branches on the
// readings until it reaches the cause.
import { describeDtc } from './dtcdb.js';
import { correlate, circuitFor, getCircuit } from './diag.js';
import { gmPlatform, gmCircuits, gmCircuitFor, MODULES, FUSES } from './wiring-gm.js';
import { chargeRange } from './obd.js';
import { settings } from './store.js';

export const AREA = { elec: ['كهرباء', '#ffb547'], mech: ['ميكانيك', '#3de0ff'], soft: ['برمجة', '#a57bff'], mod: ['تعديل بالسيارة', '#33e39b'] };

/* ------------------------------ the car ------------------------------ */
// What has been changed on the car (from its saved details): changes the weight of programming causes.
export function modsOf(v = {}) {
  const m = v.mods || {}, n = String(m.notes || '');
  return {
    swap: !!m.swap || /سواب|swap|LS3|مركّب|مركب/i.test(n),
    tune: !!m.tune || /تيون|tune|برمج|HP ?Tuners|EFI/i.test(n),
    afmOff: !!m.afmOff || (/AFM|DOD|تعطيل السلندر/i.test(n) && /ملغ|بدون|delete|off|مقفل|مطفي/i.test(n)),
    rearO2Off: !!m.rearO2Off || (/O2|الأكسجين|اكسجين/i.test(n) && /خلف|ملغ|off|delete/i.test(n)),
    absKill: !!m.absKill || (/ABS/i.test(n) && /قاطع|kill|سويتش|مفصول|ملغ/i.test(n)),
    // engines that never had cam phasing (VVT) or cylinder deactivation (AFM)
    noVVT: /\bLS[1-37]\b|LQ[49]|LM7|LR4/i.test(n), noAFM: !!m.afmOff || /\bLS[1-37]\b|LQ[49]|LM7|LR4/i.test(n),
    notes: n,
  };
}
const anyMod = m => m.swap || m.tune || m.afmOff || m.rearO2Off || m.absKill;

/* ------------------------------ fault types ------------------------------ */
// sensors and parts, with the live value that shows them and the wiring sheet that draws them
const S = {
  ect: { n: 'حساس حرارة التبريد', type: 'therm', pid: 0x05, sheet: 'ect', unit: '°C' },
  iat: { n: 'حساس حرارة الهواء', type: 'therm', pid: 0x0f, sheet: 'iat', unit: '°C' },
  map: { n: 'حساس ضغط المنيفولد MAP', type: 'v3', pid: 0x0b, sheet: 'map', unit: 'kPa', lo: 10, hi: 105 },
  tps: { n: 'حساس الثروتل', type: 'v3', pid: 0x11, sheet: 'tps', unit: '%', lo: 1, hi: 98 },
  app: { n: 'حساس دعسة البنزين', type: 'v3', pid: 0x49, sheet: 'tps', unit: '%', lo: 1, hi: 98 },
  eop: { n: 'حساس ضغط الزيت', type: 'v3', pid: null, sheet: null },
  ftp: { n: 'حساس ضغط خزان الوقود', type: 'v3', pid: 0x32, sheet: 'evap', unit: 'Pa' },
  lvl: { n: 'حساس مستوى الوقود', type: 'v3', pid: 0x2f, sheet: null, unit: '%', lo: 1, hi: 99 },
  maf: { n: 'حساس تدفق الهواء MAF', type: 'maf', pid: 0x10, sheet: 'maf', unit: 'g/s' },
  ckp: { n: 'حساس عمود الكرنك', type: 'hall', pid: 0x0c, sheet: 'ckp' },
  cmp: { n: 'حساس عمود الكامات', type: 'hall', pid: null, sheet: 'cmp' },
  vss: { n: 'حساس سرعة السيارة', type: 'hall', pid: 0x0d, sheet: null },
  purge: { n: 'صمام تنقية بخار الوقود', type: 'sol', pid: 0x2e, sheet: 'evap' },
  vent: { n: 'صمام تهوية EVAP', type: 'sol', pid: null, sheet: 'evap' },
  fan: { n: 'مروحة الرديتر', type: 'sol', pid: null, sheet: null },
  vvt: { n: 'نظام توقيت الكامات VVT', type: 'vvt', pid: null, sheet: 'vvt' },
  pump: { n: 'نظام طرمبة البنزين', type: 'pump', pid: null, sheet: 'fuelpump' },
  chg: { n: 'نظام الشحن', type: 'chg', pid: 0x42, sheet: 'charging' },
  ref5: { n: 'مرجع 5V للحساسات', type: 'ref5', sheet: 'ref5' },
  ecm: { n: 'كمبيوتر المكينة', type: 'module', sheet: 'mod:ECM' },
};
const SIMPLE = {
  P0115: ['ect', 'circ'], P0116: ['ect', 'perf'], P0117: ['ect', 'low'], P0118: ['ect', 'high'], P0119: ['ect', 'inter'],
  P0110: ['iat', 'circ'], P0111: ['iat', 'perf'], P0112: ['iat', 'low'], P0113: ['iat', 'high'], P0114: ['iat', 'inter'],
  P0105: ['map', 'circ'], P0106: ['map', 'perf'], P0107: ['map', 'low'], P0108: ['map', 'high'],
  P0100: ['maf', 'circ'], P0101: ['maf', 'perf'], P0102: ['maf', 'low'], P0103: ['maf', 'high'],
  P0120: ['tps', 'circ'], P0121: ['tps', 'perf'], P0122: ['tps', 'low'], P0123: ['tps', 'high'], P0220: ['tps', 'circ'], P0222: ['tps', 'low'], P0223: ['tps', 'high'], P2135: ['tps', 'corr'], P0068: ['tps', 'corr'],
  P2122: ['app', 'low'], P2123: ['app', 'high'], P2127: ['app', 'low'], P2128: ['app', 'high'], P2138: ['app', 'corr'],
  P0520: ['eop', 'circ'], P0521: ['eop', 'perf'], P0522: ['eop', 'low'], P0523: ['eop', 'high'], P0524: ['eop', 'oillow'],
  P0451: ['ftp', 'perf'], P0452: ['ftp', 'low'], P0453: ['ftp', 'high'],
  P0461: ['lvl', 'perf'], P0462: ['lvl', 'low'], P0463: ['lvl', 'high'],
  P0335: ['ckp', 'circ'], P0336: ['ckp', 'perf'], P0337: ['ckp', 'low'], P0338: ['ckp', 'high'],
  P0340: ['cmp', 'circ'], P0341: ['cmp', 'perf'], P0342: ['cmp', 'low'], P0343: ['cmp', 'high'],
  P0500: ['vss', 'circ'], P0501: ['vss', 'perf'], P0502: ['vss', 'low'],
  P0443: ['purge', 'sol'], P0458: ['purge', 'sol'], P0459: ['purge', 'sol'], P0446: ['vent', 'sol'], P0449: ['vent', 'sol'],
  P0480: ['fan', 'sol'], P0481: ['fan', 'sol'],
  P0230: ['pump', 'circ'], P0627: ['pump', 'circ'], P0628: ['pump', 'circ'], P0629: ['pump', 'circ'], P0087: ['pump', 'press'],
  P0601: ['ecm', 'mem'], P0602: ['ecm', 'prog'], P0603: ['ecm', 'mem'], P0604: ['ecm', 'mem'], P0605: ['ecm', 'mem'], P0606: ['ecm', 'proc'], P0610: ['ecm', 'config'], P0630: ['ecm', 'vin'], P0633: ['ecm', 'immo'],
};
const O2PID = { '1-1': 0x14, '1-2': 0x15, '2-1': 0x18, '2-2': 0x19 };
export function classify(code) {
  code = String(code).toUpperCase();
  if (SIMPLE[code]) return { s: SIMPLE[code][0], mode: SIMPLE[code][1] };
  const n = /^P\d{4}$/.test(code) ? parseInt(code.slice(1), 10) : -1;
  // O2 sensors (SAE J2012 layout)
  const o2 = [[130, 1, 1], [136, 1, 2], [150, 2, 1], [156, 2, 2]];
  for (const [b0, bank, sn] of o2) if (n >= b0 && n <= b0 + 5) return { s: 'o2', bank, sn, mode: ['circ', 'low', 'high', 'slow', 'noact', 'heater'][n - b0] };
  const ht = [[30, 1, 1], [36, 1, 2], [50, 2, 1], [56, 2, 2]];
  for (const [b0, bank, sn] of ht) if (n >= b0 && n <= b0 + 2) return { s: 'o2', bank, sn, mode: 'heater' };
  const stuck = { 2195: [1, 1, 'lean'], 2196: [1, 1, 'rich'], 2197: [2, 1, 'lean'], 2198: [2, 1, 'rich'], 2270: [1, 2, 'lean'], 2271: [1, 2, 'rich'], 2272: [2, 2, 'lean'], 2273: [2, 2, 'rich'] };
  if (stuck[n]) return { s: 'o2', bank: stuck[n][0], sn: stuck[n][1], mode: stuck[n][2] === 'lean' ? 'low' : 'high' };
  if (n >= 201 && n <= 212) return { s: 'inj', cyl: n - 200, mode: 'circ' };
  if (n >= 351 && n <= 362) return { s: 'coil', cyl: n - 350, mode: 'circ' };
  if (n >= 300 && n <= 312) return { s: 'mis', cyl: n - 300, mode: 'mis' };
  if (n >= 325 && n <= 334) return { s: 'knock', mode: 'circ', no: n < 330 ? 1 : 2 };
  if ([171, 174].includes(n)) return { s: 'mix', mode: 'lean' };
  if ([172, 175].includes(n)) return { s: 'mix', mode: 'rich' };
  if ([420, 421, 430, 431].includes(n)) return { s: 'cat', mode: 'cat', bank: n >= 430 ? 2 : 1 };
  if (n === 128 || n === 125) return { s: 'ect', mode: 'thermo' };
  if ((n >= 10 && n <= 25)) return { s: 'vvt', mode: n >= 16 && n <= 19 ? 'corr' : [10, 20].includes(n) ? 'sol' : 'timing' };
  if (n >= 3400 && n <= 3496) return { s: 'afm', mode: 'afm', cyl: n === 3400 ? null : Math.floor((n - 3401) / 8) + 1 };
  if ([560, 562, 563, 621, 622, 2500, 2501].includes(n)) return { s: 'chg', mode: n === 563 ? 'high' : [621, 622, 2500, 2501].includes(n) ? 'lterm' : 'low' };
  if ([641, 651, 697].includes(n) || code === 'P06A6') return { s: 'ref5', mode: 'ref' };
  if (n >= 440 && n <= 457 || n === 496) return { s: 'evap', mode: 'leak' };
  if ((n >= 700 && n <= 799) || (n >= 2700 && n <= 2799)) return { s: 'trans', mode: 'trans' };
  if (code[0] === 'U') return { s: 'net', mode: 'net' };
  if (/^B00/.test(code)) return { s: 'srs', mode: 'srs' };
  if (/^C00(3[5-9]|4\d|5\d)$/.test(code)) return { s: 'wss', mode: 'wss' };
  if (code[0] === 'C') return { s: 'abs', mode: 'abs' };
  return null;
}

/* ------------------------------ helpers ------------------------------ */
const pct = (arr) => { const t = arr.reduce((a, c) => a + c.p, 0) || 1; return arr.filter(c => c.p > 0).map(c => ({ ...c, p: c.p / t })).sort((a, b) => b.p - a.p); };
const cause = (area, t, p, why) => ({ area, t, p, why });
const N = (id, k, t, o = {}) => ({ id, k, t, ...o }); // a test step
const end = (id, area, t, fix) => ({ id, k: 'end', verdict: { area, t, fix } });
const fix1 = v => (typeof v === 'number' ? (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0)) : String(v));
// The car's sheet for this part, and the pin text of a wire by its role
function sheetOf(id, plat) {
  if (!id) return null;
  if (plat) { const g = gmCircuits(plat); if (g[id]) return { ...g[id](), vehicle: true }; }
  return getCircuit(id);
}
const wire = (sh, role, re) => sh?.wires.find(w => w.role === role && (!re || re.test(w.label + ' ' + (w.pin || ''))));
const pinOf = (sh, role, fb, re) => { const w = wire(sh, role, re); return w?.pin || w?.label || fb; };
const partLoc = sh => sh?.comps.find(c => c.id === 'c')?.sub || '';
function pathOf(sh) {
  if (!sh) return [];
  return sh.wires.filter(w => !w.quiet).slice(0, 8).map(w => ({ label: w.label, pin: w.pin || '', role: w.role, l: w.l || (sh.vehicle ? 'oem' : 'est') }));
}
const live = (ctx, pid) => (pid != null && ctx.live?.[pid] != null ? ctx.live[pid] : null);
function ffFor(ctx, code) {
  for (const f of ctx.freeze || []) if (f?.dtc === code && f.items?.length) return f.items;
  return null;
}
const lostMods = codes => {
  const MAP = { U0100: 'ECM', U0101: 'TCM', U0121: 'EBCM', U0129: 'EBCM', U0140: 'BCM', U0151: 'SDM', U0155: 'IPC', U0164: 'HVAC', U0168: 'TDM' };
  return [...new Set(codes.map(c => MAP[c]).filter(Boolean))];
};

/* ------------------------------ templates ------------------------------ */
// Each returns { causes, evidence, tree, title? } for one code (or one family of codes).
function thermTpl(sd, mode, ctx, sh, code) {
  const v = live(ctx, sd.pid), ev = [], sig = pinOf(sh, 'sig', 'سلك الإشارة'), gnd = pinOf(sh, 'gnd', 'الأرضي المرجعي');
  if (v != null) ev.push(`القراءة الحية الآن: ${fix1(v)}°C${v <= -38 ? ' — قراءة −40 تعني دائرة مفتوحة' : v >= 130 ? ' — قراءة متطرفة تعني تماس مع الأرضي' : ''}`);
  const ff = ffFor(ctx, code); const fv = ff?.find(i => i.pid === sd.pid);
  if (fv?.value != null) ev.push(`لحظة تسجيل الكود كانت القراءة ${fv.text}°C`);
  if (mode === 'low') return {
    evidence: ev, causes: pct([
      cause('elec', `تماس داخل ${sd.n}`, v != null && v >= 130 ? 0.5 : 0.45, 'الحساس الحراري لما يتماس داخليًا تصير مقاومته قريبة من الصفر، والكمبيوتر يفهمها حرارة عالية جدًا.'),
      cause('elec', `سلك الإشارة (${sig}) متماس مع الأرضي`, 0.4, 'احتكاك الضفيرة أو ذوبانها قرب مصدر حرارة يوصل الإشارة بالأرضي فتنزل للصفر.'),
      cause('elec', 'الكمبيوتر نفسه', 0.05, 'نادر: دائرة القراءة داخل الكمبيوتر.'),
      ...(sd.pid === 0x05 && v != null && v > 110 && v < 130 ? [cause('mech', 'حرارة المكينة عالية فعلًا', 0.2, 'القراءة منطقية وليست متطرفة — تأكد من مستوى الماء والمروحة والثرموستات.')] : []),
    ]),
    tree: [
      N('a', 'live', `شغّل السويتش ON (والمكينة باردة إن أمكن) وراقب قراءة ${sd.n}.`, { pid: sd.pid, unit: '°C', expect: 'قريبة من حرارة الجو إذا المكينة باردة', judge: x => x >= 130 ? { st: 'bad', say: 'القراءة متطرفة: العطل موجود الآن', go: 'b' } : { st: 'ok', say: 'القراءة طبيعية الآن: العطل متقطع', go: 'w' } }),
      N('b', 'live', `افصل فيش ${sd.n} والسويتش ON، وراقب القراءة.`, { pid: sd.pid, unit: '°C', where: partLoc(sh), expect: 'تنزل إلى −40°C تقريبًا', judge: x => x <= -35 ? { st: 'ok', say: 'نزلت لـ−40: الأسلاك سليمة', go: 'e1' } : { st: 'bad', say: 'ما تغيّرت: التماس في السلك', go: 'e2' } }),
      end('e1', 'elec', `${sd.n} متماس من الداخل.`, 'بدّل الحساس. امسح الكود وتأكد أن القراءة صارت منطقية.'),
      end('e2', 'elec', `سلك الإشارة (${sig}) متماس مع الأرضي بين الحساس والكمبيوتر.`, 'تتبّع السلك من الفيش إلى الكمبيوتر وابحث عن احتكاك أو ذوبان، خصوصًا قرب المنيفولد والدبات.'),
      N('w', 'live', 'حرّك ضفيرة الحساس وفيشه بيدك (هزّ خفيف) لمدة 20 ثانية وراقب القراءة، ثم احكم.', { watch: true, pid: sd.pid, unit: '°C', judge: (x, y, e = {}) => (Math.max(x, e.max ?? x) >= 130 || Math.min(x, e.min ?? x) <= -35) ? { st: 'bad', say: 'القراءة قفزت مع الحركة', go: 'e3' } : { st: 'ok', say: 'ما قفزت', go: 'e4' } }),
      end('e3', 'elec', 'فيش أو سلك متقطع في دائرة الحساس.', 'نظّف الفيش وافحص الأطراف (ارتخاء/تآكل) وصلّح موضع الحركة.'),
      end('e4', 'elec', 'العطل متقطع وما ظهر الآن.', 'امسح الكود وسجّل مشوار؛ إذا رجع لاحظ الظروف (حرارة/مطبات) وأعد الفحص وقتها.'),
    ],
  };
  if (mode === 'high' || mode === 'circ') return {
    evidence: ev, causes: pct([
      cause('elec', 'فيش الحساس مفصول أو أطرافه متآكلة', 0.35, 'الدائرة المفتوحة تعطي −40°C ثابتة — أبسط سبب فيش غير مقفّل أو طرف مرتخي.'),
      cause('elec', `${sd.n} مفتوح من الداخل`, 0.3, 'العنصر الحراري لما ينقطع تصير مقاومته لا نهائية.'),
      cause('elec', `سلك الإشارة (${sig}) أو الأرضي المرجعي (${gnd}) مقطوع`, 0.3, 'أي قطع في أحد السلكين يفتح الدائرة.'),
      cause('elec', 'الكمبيوتر', 0.05, 'نادر.'),
    ]),
    tree: [
      N('a', 'live', `شغّل السويتش ON وراقب قراءة ${sd.n}.`, { pid: sd.pid, unit: '°C', expect: 'منطقية (ليست −40)', judge: x => x <= -35 ? { st: 'bad', say: 'القراءة −40: الدائرة مفتوحة الآن', go: 'b' } : { st: 'ok', say: 'طبيعية الآن: العطل متقطع', go: 'w' } }),
      N('b', 'live', 'افصل فيش الحساس، وحط سلك جسر صغير بين طرفي الفيش جهة الضفيرة، والسويتش ON.', { pid: sd.pid, unit: '°C', where: partLoc(sh), expect: 'تقفز فوق 130°C', judge: x => x >= 120 ? { st: 'ok', say: 'قفزت: الأسلاك والكمبيوتر سليمة', go: 'e1' } : { st: 'bad', say: 'ما قفزت: القطع في الأسلاك', go: 'c' } }),
      end('e1', 'elec', `${sd.n} مفتوح من الداخل.`, 'بدّل الحساس.'),
      N('c', 'measure', `شيل الجسر، والفيش مفصول والسويتش ON: قِس الفولت بين طرف الإشارة (${sig}) وسالب البطارية.`, { unit: 'V', expect: '≈ 5V', judge: x => x >= 4.5 && x <= 5.5 ? { st: 'ok', say: '5V موجودة: سلك الإشارة سليم', go: 'e2' } : x < 0.5 ? { st: 'bad', say: 'صفر: سلك الإشارة مقطوع', go: 'e3' } : { st: 'warn', say: 'فولت ناقص: مقاومة عالية', go: 'e4' } }),
      end('e2', 'elec', `الأرضي المرجعي (${gnd}) مقطوع بين الحساس والكمبيوتر.`, 'تتبّع سلك الأرضي المرجعي وصلّحه.'),
      end('e3', 'elec', `سلك الإشارة (${sig}) مقطوع بين الحساس والكمبيوتر.`, 'تتبّع السلك إلى فيش الكمبيوتر وصلّح موضع القطع.'),
      end('e4', 'elec', 'مقاومة عالية في الفيش أو السلك (تآكل).', 'نظّف الأطراف وافحص الفيش عند الحساس وعند الكمبيوتر.'),
      N('w', 'live', 'حرّك الضفيرة والفيش لمدة 20 ثانية وراقب القراءة، ثم احكم.', { watch: true, pid: sd.pid, unit: '°C', judge: (x, y, e = {}) => Math.min(x, e.min ?? x) <= -35 ? { st: 'bad', say: 'نزلت −40 مع الحركة', go: 'e5' } : { st: 'ok', say: 'ثابتة', go: 'e6' } }),
      end('e5', 'elec', 'فيش أو سلك متقطع.', 'صلّح موضع الحركة ونظّف الفيش.'),
      end('e6', 'elec', 'العطل متقطع وما ظهر الآن.', 'امسح الكود وراقب.'),
    ],
  };
  if (mode === 'thermo') {
    const warm = ctx.live?.[0x1f];
    if (v != null) ev.push(`حرارة التبريد الآن ${fix1(v)}°C${warm ? ` بعد ${Math.round(warm / 60)} دقيقة تشغيل` : ''}`);
    return {
      evidence: ev, causes: pct([
        cause('mech', 'الثرموستات عالق مفتوح', 0.65, 'الماء يدور على الرديتر من البداية فالمكينة ما توصل حرارتها في الوقت المتوقع.'),
        cause('elec', `${sd.n} يقرأ أقل من الواقع`, 0.2, 'حساس منحرف يعطي حرارة أقل من الحقيقية.'),
        cause('mech', 'مروحة الرديتر شغالة باستمرار أو مستوى الماء ناقص', 0.15, 'تبريد زائد أو هواء في الدائرة.'),
      ]),
      tree: [
        N('a', 'do', 'ابدأ والمكينة باردة (واقفة 6 ساعات على الأقل). شغّل وسوق قيادة عادية.', {}),
        N('b', 'live', 'بعد 10–15 دقيقة قيادة: كم حرارة التبريد؟', { pid: 0x05, unit: '°C', expect: '85–100°C', judge: x => x >= 85 ? { st: 'ok', say: 'وصلت حرارتها', go: 'c' } : { st: 'bad', say: 'ما وصلت', go: 'd' } }),
        N('c', 'ask', 'هل الكود رجع بعد المسح والقيادة؟', { opts: [['نعم', 'd'], ['لا', 'e0']] }),
        end('e0', 'mech', 'العطل كان مؤقت (جو بارد جدًا أو قيادة قصيرة).', 'لا يحتاج إصلاح الآن؛ راقب.'),
        N('d', 'ask', 'المكينة شغالة: المس الخرطوم العلوي للرديتر بحذر — هل يسخن مبكرًا مع المكينة (قبل ما توصل 80°C)؟', { opts: [['نعم يسخن مبكر', 'e1'], ['لا يبقى بارد ثم يسخن فجأة', 'e2']] }),
        end('e1', 'mech', 'الثرموستات عالق مفتوح.', 'بدّل الثرموستات وجوانه واملأ الماء وطلّع الهواء.'),
        end('e2', 'elec', `الثرموستات يشتغل طبيعي — ${sd.n} يقرأ أقل من الواقع.`, 'قارن قراءة الحساس بميزان حرارة على رأس المكينة، وبدّل الحساس إذا الفرق كبير.'),
      ],
    };
  }
  // performance / intermittent
  const iat = live(ctx, 0x0f), amb = live(ctx, 0x46);
  if (v != null && iat != null) ev.push(`حرارة التبريد ${fix1(v)}°C · حرارة الهواء ${fix1(iat)}°C${amb != null ? ` · الجو ${fix1(amb)}°C` : ''}`);
  return {
    evidence: ev, causes: pct([
      cause('elec', `${sd.n} منحرف (قراءته غير منطقية)`, 0.45, 'الكمبيوتر يقارن الحساس بحساسات الحرارة الثانية عند التشغيل البارد؛ الفرق الكبير يعني حساس منحرف.'),
      cause('elec', 'مقاومة عالية في الفيش أو الأرضي المرجعي', 0.25, 'التآكل يرفع المقاومة فتتغير القراءة.'),
      cause('mech', sd.pid === 0x05 ? 'ثرموستات أو نقص ماء/هواء في دائرة التبريد' : 'هواء ساخن يوصل للحساس (موقع/تسريب)', 0.3, 'سبب حقيقي يغيّر الحرارة نفسها.'),
    ]),
    tree: [
      N('a', 'ask', 'هل السيارة واقفة 6 ساعات أو أكثر (مكينة باردة تمامًا)؟', { opts: [['نعم', 'b'], ['لا', 'x']] }),
      N('x', 'do', 'هذا الفحص يحتاج مكينة باردة. ارجع له بعد ما توقف السيارة الليل.', { next: null }),
      N('b', 'live', 'السويتش ON بدون تشغيل: قارن حرارة التبريد بحرارة الهواء.', { koeo: true, pid: 0x05, pid2: 0x0f, unit: '°C', expect: 'الفرق أقل من 5°C', judge: (x, y) => y == null ? { st: 'warn', say: 'ما توفرت حرارة الهواء للمقارنة', go: 'e2' } : Math.abs(x - y) <= 5 ? { st: 'ok', say: 'متقاربة', go: 'e1' } : { st: 'bad', say: `الفرق ${Math.abs(x - y).toFixed(0)}°C`, go: 'e2' } }),
      end('e1', 'mech', 'الحساسات متطابقة على البارد — الأرجح سبب حقيقي في التبريد/التسخين.', sd.pid === 0x05 ? 'افحص الثرموستات ومستوى الماء وطلّع الهواء من الدائرة.' : 'افحص موقع الحساس ومسار الهواء.'),
      end('e2', 'elec', 'أحد الحساسين منحرف.', 'قِس الحرارة الحقيقية بميزان، وبدّل الحساس اللي قراءته بعيدة عنها.'),
    ],
  };
}

function v3Tpl(sd, mode, ctx, sh, code, codes) {
  const v = live(ctx, sd.pid), ev = [];
  const ref = pinOf(sh, 'ref5', '5V ref'), sig = pinOf(sh, 'sig', 'سلك الإشارة'), gnd = pinOf(sh, 'gnd', 'Low ref');
  if (v != null) ev.push(`القراءة الحية الآن: ${fix1(v)} ${sd.unit || ''}`);
  const refCodes = codes.filter(c => /^P0(641|651|697)$|^P06A6$/.test(c));
  const otherLow = codes.filter(c => c !== code && classify(c)?.mode === 'low' && ['map', 'tps', 'app', 'eop', 'ftp'].includes(classify(c)?.s));
  const lowish = mode === 'low' || mode === 'circ';
  if (lowish && refCodes.length) ev.push(`مع كود مرجع 5V (${refCodes.join('، ')}) — يرجّح المرجع المشترك`);
  if (lowish && otherLow.length) ev.push(`حساسات ثانية «دخل منخفض» معه (${otherLow.join('، ')}) — يرجّح سببًا مشتركًا`);
  const lv = sd.pid != null;
  if (mode === 'low' || mode === 'circ') return {
    evidence: ev, causes: pct([
      cause('elec', `مرجع 5V (${ref}) مقطوع أو منخفض`, refCodes.length || otherLow.length ? 0.55 : 0.3, 'بدون 5V الحساس ما يعطي إشارة فيقرأ الكمبيوتر صفر. لو أكثر من حساس سقط معًا فالمرجع المشترك هو السبب.'),
      cause('elec', `سلك الإشارة (${sig}) متماس مع الأرضي أو مقطوع`, 0.35, 'الإشارة المتصلة بالأرضي تنزل للصفر.'),
      cause('elec', `${sd.n} نفسه`, refCodes.length ? 0.15 : 0.3, 'الحساس التالف ممكن يسحب المرجع أو ما يعطي إشارة.'),
      ...(sd.s === 'eop' ? [cause('mech', 'ضغط زيت منخفض فعلًا', 0.15, 'لازم يتأكد بساعة ضغط ميكانيكية قبل أي شيء.')] : []),
    ]),
    tree: [
      ...(lv ? [N('a', 'live', `السويتش ON: راقب قراءة ${sd.n}.`, { pid: sd.pid, unit: sd.unit, judge: x => sd.lo != null && x <= sd.lo ? { st: 'bad', say: 'القراءة في أدنى حد: العطل موجود الآن', go: 'b' } : { st: 'ok', say: 'القراءة طبيعية الآن: العطل متقطع', go: 'w' } })] : []),
      N('b', 'measure', `افصل فيش الحساس، السويتش ON: قِس بين طرف المرجع (${ref}) وسالب البطارية.`, { unit: 'V', where: partLoc(sh), expect: '4.8–5.2V', judge: x => x >= 4.6 && x <= 5.3 ? { st: 'ok', say: 'المرجع سليم', go: lv ? 'c' : 'c2' } : { st: 'bad', say: 'المرجع ناقص/مقطوع', go: 'e1' } }),
      end('e1', 'elec', `مرجع 5V (${ref}) فيه مشكلة.`, 'افصل الحساسات الثانية اللي على نفس المرجع وحدة وحدة: إذا رجع الـ5V فالحساس المفصول هو اللي يسحبه. وإذا ما رجع فالسلك متماس أو الكمبيوتر.'),
      ...(lv ? [N('c', 'live', `وصّل سلك جسر بين طرف المرجع وطرف الإشارة في فيش الضفيرة (الحساس مفصول)، وراقب القراءة.`, { pid: sd.pid, unit: sd.unit, expect: 'تقفز لأعلى حد', judge: x => sd.hi != null && x >= sd.hi * 0.9 ? { st: 'ok', say: 'قفزت: الإشارة والكمبيوتر سليمة', go: 'e2' } : { st: 'bad', say: 'ما قفزت', go: 'e3' } })]
        : [N('c2', 'measure', 'قِس المقاومة بين طرف الإشارة في فيش الضفيرة والأرضي (البطارية مفصولة).', { unit: 'Ω', expect: 'لا نهائية (OL)', judge: x => x < 1000 ? { st: 'bad', say: 'فيه تماس مع الأرضي', go: 'e3' } : { st: 'ok', say: 'ما فيه تماس', go: 'e2' } })]),
      end('e2', 'elec', `${sd.n} تالف.`, 'بدّل الحساس.'),
      end('e3', 'elec', `سلك الإشارة (${sig}) متماس مع الأرضي أو مقطوع.`, 'تتبّع السلك من الحساس للكمبيوتر وصلّحه.'),
      ...(lv ? [N('w', 'live', 'حرّك الضفيرة والفيش لمدة 20 ثانية وراقب القراءة، ثم احكم.', { watch: true, pid: sd.pid, unit: sd.unit, judge: (x, y, e = {}) => sd.lo != null && Math.min(x, e.min ?? x) <= sd.lo ? { st: 'bad', say: 'سقطت مع الحركة', go: 'e4' } : { st: 'ok', say: 'ثابتة', go: 'e5' } }),
        end('e4', 'elec', 'فيش أو سلك متقطع.', 'صلّح موضع الحركة ونظّف الأطراف.'), end('e5', 'elec', 'العطل متقطع وما ظهر الآن.', 'امسح وراقب.')] : []),
    ],
  };
  if (mode === 'high') return {
    evidence: ev, causes: pct([
      cause('elec', `الأرضي المرجعي (${gnd}) مقطوع`, 0.35, 'بدون أرضي تطلع الإشارة لأعلى حد.'),
      cause('elec', `سلك الإشارة (${sig}) متماس مع 5V أو 12V`, 0.35, 'تماس مع سلك مغذّى يرفع الإشارة.'),
      cause('elec', `${sd.n} نفسه`, 0.3, 'حساس تالف داخليًا.'),
    ]),
    tree: [
      ...(lv ? [N('a', 'live', `افصل فيش ${sd.n}، السويتش ON، وراقب القراءة.`, { pid: sd.pid, unit: sd.unit, where: partLoc(sh), expect: 'تنزل لأدنى حد', judge: x => sd.lo != null && x <= sd.lo * 1.5 + 1 ? { st: 'ok', say: 'نزلت: الإشارة سليمة', go: 'b' } : { st: 'bad', say: 'باقية عالية والحساس مفصول', go: 'e1' } })] : []),
      end('e1', 'elec', `سلك الإشارة (${sig}) متماس مع مصدر فولت.`, 'افحص الضفيرة بحثًا عن احتكاك مع سلك مغذّى.'),
      N('b', 'measure', `الفيش مفصول: قِس الفولت بين طرف الأرضي المرجعي (${gnd}) وسالب البطارية، السويتش ON.`, { unit: 'V', expect: 'أقل من 0.1V (والمقاومة للسالب أقل من 5Ω)', judge: x => x <= 0.15 ? { st: 'ok', say: 'الأرضي سليم', go: 'e2' } : { st: 'bad', say: 'الأرضي فيه مقاومة/قطع', go: 'e3' } }),
      end('e2', 'elec', `${sd.n} تالف.`, 'بدّل الحساس.'),
      end('e3', 'elec', `الأرضي المرجعي (${gnd}) مقطوع أو عالي المقاومة.`, 'تتبّع سلك الأرضي المرجعي إلى الكمبيوتر وصلّحه.'),
    ],
  };
  if (mode === 'oillow') return {
    safety: true, evidence: ev, causes: pct([
      cause('mech', 'ضغط زيت منخفض فعلًا (مستوى/لزوجة/طرمبة/مصفاة)', 0.45, 'الكود يعني الكمبيوتر شاف ضغط أقل من الحد. هذا خطر على المكينة لو صحيح.'),
      cause('elec', 'حساس ضغط الزيت أو دائرته', 0.45, 'حساس ضغط الزيت في مكائن LS معروف بالعطل ويعطي قراءات خاطئة.'),
      cause('soft', 'حدود الضغط في البرمجة ما تناسب المكينة المركّبة', ctx.mods?.swap ? 0.1 : 0, 'بعد السواب ممكن تختلف قيم الضغط الطبيعية عن معايرة الكمبيوتر.'),
    ]),
    tree: [
      N('a', 'measure', '⚠ قبل أي شي: افحص مستوى الزيت بالعصا. ثم ركّب ساعة ضغط ميكانيكية مكان الحساس وشغّل على الخمول والمكينة حارّة. كم الضغط (psi)؟', { unit: 'psi', expect: 'خمول حار عادة 15–25 psi أو أكثر (تقديري)', judge: x => x >= 10 ? { st: 'ok', say: 'الضغط الحقيقي مقبول', go: 'e1' } : { st: 'bad', say: 'الضغط الحقيقي منخفض', go: 'e2' } }),
      end('e1', 'elec', 'الضغط الحقيقي سليم — الحساس أو دائرته يقرأ غلط.', 'بدّل حساس ضغط الزيت وافحص فيشه وأسلاكه (5V، إشارة، أرضي).'),
      end('e2', 'mech', 'ضغط الزيت منخفض فعلًا.', '⚠ لا تسوق السيارة. افحص لزوجة الزيت ومصفاة الطرمبة والجوانات، وراجع ميكانيكي.'),
    ],
  };
  // performance / correlation
  const baro = live(ctx, 0x33);
  if (sd.pid === 0x0b && v != null && baro != null) ev.push(`MAP ${fix1(v)} kPa · الضغط الجوي ${fix1(baro)} kPa`);
  return {
    evidence: ev, causes: pct([
      cause('elec', `${sd.n} منحرف أو بطيء`, 0.4, 'الكمبيوتر يقارن قراءته مع حساسات ثانية (مثل MAP مع الثروتل والدوران)، وعدم التطابق يعني قراءة غير منطقية.'),
      cause('elec', 'فيش أو سلك متقطع/عالي المقاومة', 0.25, 'انقطاع لحظي يسبب قفزات في القراءة.'),
      cause('mech', sd.pid === 0x0b ? 'تسريب هواء أو خلل ميكانيكي يغيّر الضغط فعلًا' : sd.pid === 0x11 ? 'بوابة الهواء متّسخة أو ميكانيكيتها عالقة' : 'سبب ميكانيكي يغيّر القيمة الحقيقية', 0.25, 'القيمة نفسها تتغير لسبب حقيقي.'),
      cause('soft', 'معايرة الكمبيوتر ما تطابق المكينة/البوابة المركّبة', ctx.mods?.swap || ctx.mods?.tune ? 0.15 : 0.03, 'بعد السواب أو التيون، جداول التوقّع في الكمبيوتر لازم تطابق القطع الجديدة.'),
    ]),
    tree: sd.pid === 0x0b ? [
      N('a', 'live', 'السويتش ON والمكينة طافية: قارن MAP مع الضغط الجوي.', { koeo: true, pid: 0x0b, pid2: 0x33, unit: 'kPa', expect: 'الفرق أقل من 3 kPa', judge: (x, y) => y == null ? { st: 'warn', say: 'الضغط الجوي غير متوفر', go: 'b' } : Math.abs(x - y) <= 3 ? { st: 'ok', say: 'متطابقة', go: 'b' } : { st: 'bad', say: `الفرق ${Math.abs(x - y).toFixed(0)} kPa`, go: 'e1' } }),
      end('e1', 'elec', 'حساس MAP منحرف.', 'بدّل الحساس، وتأكد من خرطوم/فتحة الحساس نظيفة.'),
      N('b', 'live', 'شغّل المكينة على الخمول والمكينة حارّة: كم MAP؟', { run: true, pid: 0x0b, unit: 'kPa', expect: '25–45 kPa', judge: x => x <= 45 ? { st: 'ok', say: 'فاكيوم طبيعي', go: 'e2' } : { st: 'bad', say: 'فاكيوم ضعيف', go: 'e3' } }),
      end('e2', 'elec', 'الحساس يقرأ صح الآن — العطل متقطع.', 'افحص الفيش والسلك (هز وراقب)، وامسح وراقب.'),
      end('e3', 'mech', 'فاكيوم المكينة ضعيف (تسريب هواء أو خلل ميكانيكي) أو كامة/تيون بفاكيوم منخفض.', 'ابحث عن تسريب هواء، وإذا الكامة معدّلة فهذا طبيعي لها ولازم تُعدّل المعايرة.'),
    ] : [
      ...(lv ? [N('a', 'live', `حرّك القطعة على كامل مداها ببطء (لو دعسة/ثروتل: والمكينة طافية والسويتش ON) وراقب: هل القراءة ترتفع بسلاسة بدون قفزات؟`, { pid: sd.pid, unit: sd.unit, judge: () => ({ st: 'info', say: 'جاوب بعد المراقبة', go: 'b' }) })] : []),
      N('b', 'ask', 'هل لاحظت قفزة أو انقطاع في القراءة أثناء الحركة؟', { opts: [['نعم', 'e1'], ['لا', 'e2']] }),
      end('e1', 'elec', `${sd.n} فيه نقطة ميتة أو اتصاله متقطع.`, 'نظّف الفيش، وإذا تكرر بدّل الحساس.'),
      end('e2', ctx.mods?.swap || ctx.mods?.tune ? 'soft' : 'mech', ctx.mods?.swap || ctx.mods?.tune ? 'الحساس يقرأ بسلاسة — الأرجح معايرة الكمبيوتر ما تطابق القطع المركّبة.' : 'الحساس يقرأ بسلاسة — افحص الأسباب الميكانيكية.', ctx.mods?.swap || ctx.mods?.tune ? 'راجع التيون (جداول البوابة/الهواء) مع اللي برمج الكمبيوتر.' : 'نظّف البوابة وافحص تسريب الهواء.'),
    ],
  };
}

function mafTpl(sd, mode, ctx, sh) {
  const v = live(ctx, 0x10), ev = [], ig = pinOf(sh, 'b+', 'تغذية التشغيل'), disp = ctx.displacement;
  if (v != null) ev.push(`MAF الآن ${fix1(v)} g/s${disp && ctx.running && (ctx.live?.[0x0c] || 0) < 1000 ? ` (المتوقع على الخمول تقريبًا ${(disp * 0.6).toFixed(1)}–${(disp * 1.0).toFixed(1)} تقديري)` : ''}`);
  return {
    evidence: ev, causes: pct([
      cause('elec', 'حساس MAF متّسخ أو تالف', mode === 'perf' ? 0.35 : 0.3, 'الغبار والزيت على السلك الحار يخلّونه يقرأ أقل من الهواء الحقيقي.'),
      cause('elec', `تغذية الحساس (${ig}) أو أرضيه أو سلك الإشارة`, mode === 'perf' ? 0.15 : 0.4, 'بدون تغذية أو مع إشارة مقطوعة تنزل القراءة للصفر.'),
      cause('mech', 'تسريب هواء بعد الحساس أو فلتر هواء مسدود', mode === 'perf' ? 0.35 : 0.15, 'هواء يدخل المكينة بدون ما يمر على الحساس، فيختلف عن حسبة الكمبيوتر.'),
      cause('soft', 'جدول MAF في البرمجة ما يطابق الحساس/قطر الهواء المركّب', ctx.mods?.swap || ctx.mods?.tune ? 0.25 : 0.02, 'أي تغيير في قطر أنبوب الهواء أو نوع الحساس يحتاج تعديل جدول المعايرة.'),
    ]),
    tree: [
      N('a', 'live', 'شغّل المكينة على الخمول والمكينة حارّة: كم قراءة MAF؟', { run: true, pid: 0x10, unit: 'g/s', expect: disp ? `تقريبًا ${(disp * 0.6).toFixed(1)}–${(disp * 1.0).toFixed(1)} g/s (تقديري)` : 'تقريبًا 0.6–1.0 × حجم المكينة باللتر', judge: x => x < 1 ? { st: 'bad', say: 'شبه صفر: الحساس ما يعطي إشارة', go: 'b' } : disp && x < disp * 0.5 ? { st: 'warn', say: 'أقل من المتوقع', go: 'd' } : { st: 'ok', say: 'ضمن المعقول', go: 'd' } }),
      N('b', 'measure', `افصل فيش MAF، السويتش ON: قِس بين طرف التغذية (${ig}) وسالب البطارية.`, { unit: 'V', where: partLoc(sh), expect: 'فولت البطارية (≈12–12.6V)', judge: x => x >= 11 ? { st: 'ok', say: 'التغذية موجودة', go: 'c' } : { st: 'bad', say: 'ما فيه تغذية', go: 'e1' } }),
      end('e1', 'elec', 'تغذية حساس MAF مقطوعة.', 'افحص الفيوز اللي يغذّي الحساس (شوف صفحة المخطط) والسلك بينه وبين الحساس.'),
      N('c', 'measure', 'قِس فرق الجهد بين طرف أرضي الحساس وسالب البطارية والسويتش ON.', { unit: 'V', expect: 'أقل من 0.1V', judge: x => x <= 0.15 ? { st: 'ok', say: 'الأرضي سليم', go: 'e2' } : { st: 'bad', say: 'الأرضي ضعيف', go: 'e3' } }),
      end('e2', 'elec', 'التغذية والأرضي سليمة — الحساس أو سلك إشارته.', 'نظّف الحساس بمنظّف MAF المخصص، وإذا ما تحسّن بدّله أو افحص سلك الإشارة للكمبيوتر.'),
      end('e3', 'elec', 'أرضي حساس MAF ضعيف.', 'نظّف وشدّ نقطة الأرضي وأطراف الفيش.'),
      N('d', 'ask', 'رشّ منظّف حول أنبوب الهواء بعد الحساس والمنيفولد والمكينة شغالة: هل تغيّر صوت المكينة أو الدوران؟', { opts: [['نعم', 'e4'], ['لا', 'f']] }),
      end('e4', 'mech', 'فيه تسريب هواء بعد حساس MAF.', 'صلّح التسريب (خرطوم/جوان/كلبس) وامسح الكود.'),
      N('f', 'ask', 'هل أنبوب الهواء أو الحساس أو الفلتر غير أصلي (معدّل) بعد السواب؟', { opts: [['نعم', 'e5'], ['لا', 'e6']] }),
      end('e5', 'soft', 'جدول MAF في البرمجة لازم يطابق القطع المركّبة.', 'راجع مع المبرمج اللي سوّى التيون: معايرة MAF لقطر الأنبوب الجديد.'),
      end('e6', 'elec', 'الأرجح حساس MAF متّسخ أو منحرف.', 'نظّف الحساس، وإذا رجع الكود بدّله.'),
    ],
  };
}

function o2Tpl(c, ctx, sh, code, codes) {
  const pid = O2PID[`${c.bank}-${c.sn}`], v = live(ctx, pid), ev = [];
  const where = `البنك ${c.bank} (${c.bank === 1 ? 'جهة السائق' : 'جهة الراكب'}) — ${c.sn === 1 ? 'قبل الدبة' : 'بعد الدبة'}`;
  const nm = `حساس الأكسجين ${where}`;
  if (v != null) ev.push(`فولت الحساس الآن ${fix1(v)}V`);
  const lean = codes.filter(x => /^P017[14]$/.test(x)), rich = codes.filter(x => /^P017[25]$/.test(x));
  if (lean.length && c.mode === 'low') ev.push(`مع كود خلطة فقيرة (${lean.join('، ')}) — الحساس غالبًا صادق والخلطة فقيرة فعلًا`);
  if (rich.length && c.mode === 'high') ev.push(`مع كود خلطة غنية (${rich.join('، ')}) — الحساس غالبًا صادق`);
  if (c.mode === 'heater') {
    const fz = c.bank === 1 ? 'O2-A 18 أو O2-B 8 (10A)' : 'O2-A 18 أو O2-B 8 (10A)';
    const both = codes.filter(x => classify(x)?.s === 'o2' && classify(x)?.mode === 'heater').length > 1;
    if (both) ev.push('أكثر من سخّان عطلان معًا — يرجّح الفيوز أو التغذية المشتركة');
    return {
      title: `سخّان ${nm}`, evidence: ev, causes: pct([
        cause('elec', 'سخّان الحساس مقطوع (الحساس نفسه)', both ? 0.25 : 0.5, 'السخّان سلك حراري داخل الحساس ويعطل مع الوقت.'),
        cause('elec', `فيوز السخّانات (${fz}) أو سلك التغذية`, both ? 0.55 : 0.25, 'الفيوز يغذّي أكثر من حساس؛ احتراقه يوقف السخّانات معًا.'),
        cause('elec', 'سلك التحكم من الكمبيوتر أو الفيش', 0.2, 'الفيش قريب من العادم ويتأكسد أو يذوب.'),
        cause('soft', 'الحساس ملغى/مفصول بعد التيون والبرمجة ما زالت تراقبه', ctx.mods?.rearO2Off && c.sn === 2 ? 0.6 : 0, 'لو الحساس الخلفي مشال، لازم يُطفأ اختباره في البرمجة.'),
      ]),
      tree: [
        ...(ctx.mods?.rearO2Off && c.sn === 2 ? [N('z', 'ask', 'الحساس الخلفي مشال أو مفصول في سيارتك؟', { opts: [['نعم', 'ez'], ['لا', 'a']] }), end('ez', 'soft', 'الكود متوقع: البرمجة ما زالت تراقب حساس مشال.', 'اطلب من المبرمج إطفاء اختبار الحساس الخلفي وسخّانه في التيون.')] : []),
        N('a', 'ask', `افحص فيوز السخّانات ${fz} في علبة فيوزات المكينة. هل الفيوز سليم؟`, { opts: [['سليم', 'b'], ['محروق', 'e1']] }),
        end('e1', 'elec', 'فيوز سخّانات الأكسجين محروق.', 'بدّله بنفس الأمبير، وإذا احترق مرة ثانية ففيه سلك سخّان متماس مع الأرضي — افحص ضفائر الحساسات قرب العادم.'),
        N('b', 'measure', `افصل فيش ${nm} وقِس مقاومة السخّان بين طرفيه (جهة الحساس).`, { unit: 'Ω', expect: 'عادة 3–15Ω والحساس بارد (تقديري)', judge: x => x > 50 || x === 0 ? { st: 'bad', say: x === 0 ? 'تماس' : 'مقطوع', go: 'e2' } : { st: 'ok', say: 'السخّان سليم', go: 'c' } }),
        end('e2', 'elec', `سخّان ${nm} عطلان.`, 'بدّل الحساس.'),
        N('c', 'measure', 'جهة الضفيرة والسويتش ON: قِس فولت طرف تغذية السخّان للأرضي.', { unit: 'V', expect: 'فولت البطارية', judge: x => x >= 11 ? { st: 'ok', say: 'التغذية موجودة', go: 'e3' } : { st: 'bad', say: 'ما فيه تغذية', go: 'e4' } }),
        end('e3', 'elec', 'السخّان والتغذية سليمة — سلك التحكم (للكمبيوتر) أو الفيش.', 'افحص سلك التحكم من الفيش إلى الكمبيوتر، ونظّف الفيش.'),
        end('e4', 'elec', 'تغذية السخّان مقطوعة بين الفيوز والحساس.', 'تتبّع السلك من الفيوز للحساس.'),
      ],
    };
  }
  const isLow = c.mode === 'low', isHigh = c.mode === 'high';
  return {
    title: nm + (isLow ? ' — يقرأ فقير' : isHigh ? ' — يقرأ غني' : ' — بطيء/خامل'), evidence: ev, causes: pct([
      ...(isLow ? [
        cause('mech', 'الخلطة فقيرة فعلًا (تسريب هواء/ضعف وقود)', lean.length ? 0.45 : 0.3, 'الحساس يقيس الأكسجين في العادم؛ لو فيه هواء زيادة فهو صادق.'),
        cause('mech', 'تسريب عادم قبل الحساس', c.sn === 1 ? 0.2 : 0.1, 'هواء خارجي يدخل من التسريب فيقرأ الحساس فقير.'),
        cause('elec', 'سلك الإشارة متماس مع الأرضي أو الحساس تالف', 0.35, 'الإشارة تنزل للصفر.'),
      ] : isHigh ? [
        cause('mech', 'الخلطة غنية فعلًا (بخاخ يسرّب/ضغط وقود عالي)', rich.length ? 0.45 : 0.25, 'وقود زيادة يعطي إشارة عالية صادقة.'),
        cause('elec', 'سلك الإشارة متماس مع سلك السخّان أو مصدر فولت', 0.35, 'تماس مع سلك السخّان يرفع الإشارة فوق 1V.'),
        cause('elec', 'الحساس ملوّث (زيت/مانع تجمد/سيليكون)', 0.2, 'التلوث يغيّر قراءته.'),
      ] : [
        cause('elec', 'الحساس قديم وبطيء', 0.5, 'مع الكيلومترات يصير الحساس بطيء في التبديل.'),
        cause('elec', 'السخّان ما يشتغل', 0.2, 'الحساس البارد خامل.'),
        cause('mech', 'تسريب عادم قريب من الحساس', 0.2, 'الهواء الخارجي يخلط القراءة.'),
      ]),
      cause('soft', 'التيون غيّر أهداف الخلطة أو ألغى الحساس', ctx.mods?.tune ? 0.1 : 0, 'تعديلات البرمجة تأثر على قراءات واختبارات الحساسات.'),
    ]),
    tree: [
      N('a', 'live', 'شغّل المكينة لين تحمى، وارفع الدوران لـ2500 لمدة 30 ثانية ثم خلّه خمول. راقب فولت الحساس.', { run: true, pid, unit: 'V', expect: c.sn === 1 ? 'يتذبذب بسرعة بين 0.1 و 0.9V' : 'ثابت تقريبًا 0.5–0.8V', judge: x => x < 0.15 ? { st: 'bad', say: 'ثابت منخفض (فقير)', go: 'b' } : x > 0.95 ? { st: 'bad', say: 'ثابت مرتفع (غني)', go: 'd' } : { st: 'ok', say: 'ضمن المدى', go: 'f' } }),
      N('b', 'live', 'دوس البنزين دعسة سريعة قوية (Snap) وراقب: هل يقفز الفولت فوق 0.8V؟', { pid, unit: 'V', judge: x => x >= 0.8 ? { st: 'ok', say: 'يتجاوب: الحساس سليم والخلطة فقيرة فعلًا', go: 'e1' } : { st: 'bad', say: 'ما يتجاوب', go: 'e2' } }),
      end('e1', 'mech', 'الحساس سليم — الخلطة فقيرة فعلًا أو فيه تسريب عادم قبله.', 'ابحث عن تسريب هواء (منظّف حول المنيفولد) وتسريب عادم قبل الحساس، وافحص ضغط البنزين.'),
      end('e2', 'elec', 'الحساس ما يتجاوب — تالف أو إشارته متماسة مع الأرضي.', 'افحص الفيش والسلك، وإذا سليمة بدّل الحساس.'),
      N('d', 'measure', 'افصل فيش الحساس والسويتش ON: قِس فولت طرف الإشارة جهة الضفيرة للأرضي.', { unit: 'V', expect: 'قريب من 0.45V أو أقل', judge: x => x > 1.2 ? { st: 'bad', say: 'فولت عالي في الإشارة', go: 'e3' } : { st: 'ok', say: 'طبيعي', go: 'e4' } }),
      end('e3', 'elec', 'سلك الإشارة متماس مع مصدر فولت (غالبًا سلك السخّان).', 'افحص ضفيرة الحساس قرب العادم وصلّح التماس.'),
      end('e4', 'mech', 'الدائرة سليمة — الخلطة غنية فعلًا أو الحساس ملوّث.', 'افحص البخاخات وضغط البنزين وصمام EVAP، وبدّل الحساس إذا ملوّث.'),
      N('f', 'ask', 'هل الكود رجع بعد المسح؟', { opts: [['نعم', 'g'], ['لا', 'e5']] }),
      end('e5', 'elec', 'العطل كان متقطع.', 'راقب؛ إذا رجع أعد الفحص وقتها.'),
      N('g', 'ask', 'كم عمر الحساس تقريبًا؟', { opts: [['أكثر من 150 ألف كم أو أصلي قديم', 'e6'], ['جديد', 'e7']] }),
      end('e6', 'elec', 'الحساس قديم وبطيء.', 'بدّل الحساس.'),
      end('e7', 'mech', 'حساس جديد ويرجع الكود — افحص تسريب العادم والخلطة.', 'افحص العادم قبل الحساس، وراجع التيون إذا معدّل.'),
    ],
  };
}

function solTpl(kind, c, ctx, sh, codes) {
  // injectors, coils, purge/vent valves, VVT solenoid, fan
  const isInj = kind === 'inj', isCoil = kind === 'coil';
  const cyl = c.cyl;
  const side = cyl ? (cyl % 2 ? 'جهة السائق (البنك 1)' : 'جهة الراكب (البنك 2)') : '';
  const feed = pinOf(sh, 'b+', 'التغذية'), ctrl = pinOf(sh, 'ctrl', 'سلك التحكم');
  const name = isInj ? `بخاخ السلندر ${cyl}` : isCoil ? `كويل السلندر ${cyl}` : S[c.s]?.n || 'الصولونويد';
  const same = codes.filter(x => classify(x)?.s === kind).length;
  const ev = [];
  if (cyl) ev.push(`السلندر ${cyl} ${side} — الفردية جهة السائق (${ctx.plat?.v6 ? '1-3-5' : '1-3-5-7'}) والزوجية جهة الراكب (${ctx.plat?.v6 ? '2-4-6' : '2-4-6-8'})`);
  if (same > 1) ev.push(`${same} ${isInj ? 'بخاخات' : isCoil ? 'كويلات' : 'صولونويدات'} عطلانة معًا — يرجّح التغذية أو الأرضي المشترك`);
  const mis = codes.filter(x => /^P030\d$/.test(x));
  if (mis.length) ev.push(`مع أكواد احتراق ناقص (${mis.join('، ')})`);
  return {
    title: `دائرة ${name}`, evidence: ev, causes: pct([
      cause('elec', `${name} نفسه (ملف مقطوع/متماس)`, same > 1 ? 0.2 : 0.4, 'الملف الداخلي يعطل فيلاحظ الكمبيوتر تيار غير طبيعي.'),
      cause('elec', `سلك التحكم (${ctrl}) أو الفيش`, 0.35, 'السلك اللي يؤرّضه الكمبيوتر — قطع أو تماس فيه يسجّل الكود.'),
      cause('elec', `التغذية (${feed})`, same > 1 ? 0.45 : 0.15, 'فيوز أو سلك تغذية مشترك لأكثر من قطعة.'),
      cause('elec', 'الكمبيوتر (المشغّل الداخلي)', 0.05, 'نادر.'),
      cause('soft', kind === 'vvt' ? 'المكينة ما فيها VVT والبرمجة ما زالت تتحكم فيه' : 'إعداد البرمجة للقطعة', kind === 'vvt' ? (ctx.mods?.noVVT ? 1.5 : ctx.mods?.swap || ctx.mods?.tune ? 0.35 : 0) : 0, 'بعد السواب لازم تطفأ في الكمبيوتر الأنظمة اللي ما هي موجودة في المكينة الجديدة.'),
    ]),
    tree: [
      ...(kind === 'vvt' && (ctx.mods?.swap || ctx.mods?.tune) ? [N('z', 'ask', 'هل المكينة الحالية فيها توقيت كامات متغير (VVT)؟ (LS3 عادة ما فيها)', { opts: [['ما فيها', 'ez'], ['فيها', 'a'], ['ما أدري', 'a']] }), end('ez', 'soft', 'البرمجة تتحكم بنظام مو موجود.', 'اطلب من المبرمج إطفاء VVT في التيون (الكمبيوتر مقفول على اللي برمجه).')] : []),
      N('a', 'measure', `افصل فيش ${name}، السويتش ON: قِس فولت طرف التغذية (${feed}) للأرضي.`, { unit: 'V', expect: 'فولت البطارية', judge: x => x >= 11 ? { st: 'ok', say: 'التغذية موجودة', go: 'b' } : { st: 'bad', say: 'ما فيه تغذية', go: 'e1' } }),
      end('e1', 'elec', `تغذية ${name} مقطوعة.`, 'افحص الفيوز (شوف المخطط) والسلك.'),
      N('b', 'measure', `قِس مقاومة ${name} بين طرفيه (جهة القطعة).`, { unit: 'Ω', expect: isInj ? '11–18Ω (تقديري)' : isCoil ? 'ما ينطبق على كويل فيه مشغّل — جاوب بأي رقم وانتقل' : '7–25Ω (تقديري)', judge: x => isCoil ? { st: 'info', say: '', go: 'c' } : (x < (isInj ? 9 : 5) || x > (isInj ? 20 : 40)) ? { st: 'bad', say: 'خارج المدى', go: 'e2' } : { st: 'ok', say: 'ضمن المدى', go: 'c' } }),
      end('e2', 'elec', `${name} تالف.`, 'بدّل القطعة.'),
      N('c', 'ask', isCoil || isInj ? `بدّل ${isCoil ? 'الكويل' : 'البخاخ'} مع سلندر جنبه، امسح الأكواد وسوق. هل انتقل الكود للسلندر الثاني؟` : 'ركّب لمبة اختبار (Noid/LED) مكان القطعة وشغّل: هل تومض/تولّع؟', { opts: [['نعم', isCoil || isInj ? 'e3' : 'e4'], ['لا', 'e5']] }),
      end('e3', 'elec', `${name} هو السبب (العطل انتقل معه).`, 'بدّل القطعة.'),
      end('e4', 'elec', 'الكمبيوتر يتحكم والدائرة سليمة — القطعة نفسها.', 'بدّل القطعة.'),
      end('e5', 'elec', `سلك التحكم (${ctrl}) أو الفيش بين القطعة والكمبيوتر.`, 'افحص السلك من الفيش للكمبيوتر (قطع/تماس) ونظّف الأطراف.'),
    ],
  };
}

function netTpl(group, ctx, codes) {
  const lost = lostMods(group.codes);
  const mods = ctx.mods || {};
  const absK = mods.absKill && lost.includes('EBCM');
  const ev = [...group.evidence];
  const respond = id => (ctx.ecus || []).some(e => !e.ghost && e.status !== 'unreach' && e.status !== 'noresp' && MODULES.find(m => m.id === id)?.match.test(e.name || ''));
  for (const id of lost) { const m = MODULES.find(x => x.id === id); if (m && respond(id)) ev.push(`${m.ar} يرد الآن على المسح — الفقد كان متقطع`); }
  if (absK) ev.push('سيارتك فيها قاطع للـABS: لما يكون مفصول، الكمبيوترات الثانية تسجّل فقد اتصال مع كمبيوتر الفرامل');
  const m0 = MODULES.find(x => x.id === lost[0]);
  const fz = m0 ? m0.fuses.map(n => { const f = FUSES.find(z => z.n === n); return f ? `${f.name} ${n} (${f.a}A)` : n; }).join('، ') : '';
  return {
    evidence: ev, causes: pct([
      ...(absK ? [cause('mod', 'قاطع الـABS مفصول — الكود متوقع وليس عطلًا', 0.7, 'الكمبيوتر المفصول عمدًا ما يرد، والباقي يسجّل فقده.')] : []),
      cause('elec', m0 ? `تغذية أو أرضي ${m0.ar} (${fz || 'الفيوزات'})` : 'تغذية أو أرضي الكمبيوتر المفقود', lost.length === 1 ? 0.4 : 0.15, 'الكمبيوتر بدون كهرباء ما يرد على الشبكة.'),
      cause('elec', 'أسلاك الشبكة أو مقاومة الإنهاء أو فيش', lost.length > 1 ? 0.35 : 0.25, 'تماس أو قطع في زوج الشبكة يسكّت أكثر من كمبيوتر.'),
      cause('elec', 'فولت البطارية هبط (تدوير/بطارية ضعيفة)', ctx.volt && ctx.volt < 12.2 ? 0.35 : 0.15, 'الكمبيوترات تفصل لحظيًا مع هبوط الفولت وتسجّل فقد اتصال.'),
      cause('soft', 'كمبيوتر مبدّل أو مبرمج وما انعمل له إعداد/برمجة مطابقة', mods.swap || mods.tune ? 0.15 : 0.05, 'الكمبيوتر الجديد يحتاج برمجة بالرقم والإعدادات عشان يتعرّف عليه الباقي.'),
      cause('elec', 'الكمبيوتر نفسه', 0.1, 'نادر بعد استبعاد الكهرباء.'),
    ]),
    tree: [
      ...(absK ? [N('k', 'ask', 'قاطع الـABS الحين مفصول؟', { opts: [['مفصول', 'ek'], ['موصول', 'a']] }), end('ek', 'mod', 'الكود سببه القاطع المفصول.', 'طبيعي مع القاطع. وصّله وامسح الأكواد لو تبي تتأكد.')] : []),
      N('a', 'auto', 'هل الكمبيوتر المفقود يرد الآن؟ (يعتمد على «مسح سريع للكمبيوترات» من خريطة الشبكة)', { check: () => lost.length ? (lost.every(respond) ? { st: 'ok', say: 'يرد الآن', go: 'e0' } : { st: 'bad', say: 'ما يرد', go: 'b' }) : { st: 'warn', say: 'ما حددنا الكمبيوتر من الكود', go: 'b' } }),
      end('e0', 'elec', 'الفقد متقطع (هبوط فولت أو فيش يتحرك).', 'افحص البطارية وأطرافها، ونقاط الأرضي، وفيش الكمبيوتر. امسح الأكواد وراقب.'),
      N('b', 'ask', m0 ? `افحص فيوزات ${m0.ar}: ${fz || 'شوف صفحة المخطط'}. سليمة؟` : 'افحص فيوزات الكمبيوتر المفقود. سليمة؟', { opts: [['سليمة', 'c'], ['فيه محروق', 'e1']] }),
      end('e1', 'elec', 'فيوز الكمبيوتر محروق.', 'بدّله بنفس الأمبير. لو احترق مرة ثانية ففيه تماس في التغذية أو الكمبيوتر.'),
      N('c', 'measure', `السويتش ON: قِس فرق الجهد بين أرضي الكمبيوتر وسالب البطارية${m0?.grounds?.length ? ` (نقطة ${m0.grounds.join('/')})` : ''}.`, { unit: 'V', expect: 'أقل من 0.1V', judge: x => x <= 0.15 ? { st: 'ok', say: 'الأرضي سليم', go: 'd' } : { st: 'bad', say: 'الأرضي ضعيف', go: 'e2' } }),
      end('e2', 'elec', 'أرضي الكمبيوتر ضعيف أو مرتخي.', 'فكّ نقطة الأرضي ونظّفها وشدّها.'),
      N('d', 'measure', 'البطارية مفصولة: قِس المقاومة بين طرف 6 وطرف 14 في فيش الفحص.', { unit: 'Ω', expect: '≈ 60Ω', judge: x => x >= 50 && x <= 70 ? { st: 'ok', say: 'الشبكة سليمة', go: 'e3' } : x > 100 ? { st: 'bad', say: 'مقاومة إنهاء مفصولة أو سلك مقطوع', go: 'e4' } : { st: 'bad', say: 'تماس في الشبكة', go: 'e5' } }),
      end('e3', 'elec', 'التغذية والأرضي والشبكة سليمة — فيش الكمبيوتر أو سلك الإيقاظ أو الكمبيوتر نفسه.', 'افحص فيش الكمبيوتر وسلك الإيقاظ (DK BLU 5985) — لو كل شي سليم فالكمبيوتر يحتاج فحص/برمجة.'),
      end('e4', 'elec', 'الشبكة مفتوحة: مقاومة إنهاء مفصولة أو سلك مقطوع.', 'افحص مقاومة الإنهاء عند كمبيوتر المكينة وفي الشاصي (Data Link Resistor) والفيشات بينهم.'),
      end('e5', 'elec', 'تماس في أسلاك الشبكة.', 'افصل الكمبيوترات واحد واحد وقِس كل مرة لين ترجع 60Ω — آخر واحد فصلته هو مكان التماس.'),
    ],
  };
}

function chgTpl(c, ctx, group) {
  const cr = ctx.charge || { ok: [13.5, 14.8], rvc: false };
  return {
    evidence: group.evidence, causes: pct([
      cause('elec', 'البطارية ضعيفة أو أطرافها متأكسدة', 0.35, 'بطارية تالفة تسحب أو ما تمسك الشحن.'),
      cause('elec', c.mode === 'lterm' ? 'دائرة تحكم الدينمو (طرف L/F) أو الفيش' : 'الدينمو ما يشحن كفاية', c.mode === 'lterm' ? 0.45 : 0.3, c.mode === 'lterm' ? 'الكمبيوتر ما يقدر يتحكم بالدينمو إذا السلك مقطوع.' : 'المنظّم أو الدايودات.'),
      cause('elec', 'أرضي المكينة/الهيكل (G103/G101) أو كيبل B+', 0.2, 'هبوط الجهد في الكيبلات يقلل الشحن الواصل.'),
      cause('elec', 'حساس تيار البطارية (على الكيبل السالب)', cr.rvc ? 0.1 : 0, 'قراءة غلط تخلّي الكمبيوتر يخفض الشحن أكثر من اللازم.'),
    ]),
    tree: [
      N('a', 'live', 'المكينة شغالة على الخمول بدون أحمال: كم الفولت؟', { run: true, pid: '__volt', unit: 'V', expect: cr.rvc ? '12.6–14.8V (RVC ينزله عمدًا لما البطارية مليانة)' : '13.5–14.8V', judge: x => x < 12.4 ? { st: 'bad', say: 'منخفض جدًا: ما يشحن', go: 'c' } : x > 15.2 ? { st: 'bad', say: 'مرتفع: شحن زائد', go: 'e3' } : { st: 'ok', say: 'ضمن المدى', go: 'b' } }),
      N('b', 'live', 'شغّل الأنوار العالية والمكيف على أعلى مروحة والمساحات. انتظر 20 ثانية وراقب الفولت.', { pid: '__volt', unit: 'V', expect: '≥ 13.8V', judge: x => x >= 13.8 ? { st: 'ok', say: 'يرفع الشحن مع الحِمل', go: 'e0' } : { st: 'bad', say: 'ما يرفع كفاية', go: 'c' } }),
      end('e0', 'elec', 'نظام الشحن يشتغل صح (RVC).', 'لو الكود موجود فغالبًا كان هبوط لحظي — افحص أطراف البطارية والبطارية نفسها (فحص تحميل).'),
      N('c', 'measure', 'المكينة شغالة مع الأحمال: قِس الفرق بين طرف B+ في الدينمو وموجب البطارية.', { unit: 'V', expect: 'أقل من 0.3V', judge: x => x <= 0.3 ? { st: 'ok', say: 'الكيبل سليم', go: 'd' } : { st: 'bad', say: 'هبوط في كيبل B+', go: 'e1' } }),
      end('e1', 'elec', 'هبوط جهد في كيبل B+ أو فيوز الميغا 175A أو الأطراف.', 'نظّف وشدّ الأطراف وافحص فيوز الميغا على قطب البطارية.'),
      N('d', 'measure', 'قِس الفرق بين سالب البطارية وجسم المكينة أثناء التشغيل مع الأحمال.', { unit: 'V', expect: 'أقل من 0.3V', judge: x => x <= 0.3 ? { st: 'ok', say: 'الأرضي سليم', go: 'e2' } : { st: 'bad', say: 'الأرضي ضعيف', go: 'e4' } }),
      end('e2', 'elec', 'الكيبلات والأرضي سليمة — الدينمو أو دائرة تحكمه (L/F).', 'افحص فيش الدينمو وأسلاك L/F للكمبيوتر، وإذا سليمة افحص الدينمو في محل.'),
      end('e3', 'elec', 'شحن زائد: منظّم الدينمو أو قراءة حساس التيار.', 'افحص حساس تيار البطارية وفيشه، وإذا سليم فالمنظّم.'),
      end('e4', 'elec', 'أرضي المكينة ضعيف (G103).', 'نظّف وشدّ كيبل السالب على المكينة والهيكل.'),
    ],
  };
}

function afmTpl(group, ctx) {
  const m = ctx.mods || {};
  const notExpected = m.afmOff || m.noAFM || m.swap;
  return {
    evidence: group.evidence.concat(notExpected ? ['سيارتك: المكينة مركّبة/AFM ملغى — نظام إيقاف السلندرات غالبًا مو موجود'] : []),
    causes: pct([
      cause('soft', 'البرمجة ما زالت تتوقع نظام AFM بعد إزالته أو تبديل المكينة', m.afmOff || m.noAFM ? 1.2 : notExpected ? 0.7 : 0.15, 'الكمبيوتر يختبر صولونويدات AFM فقط لأن معايرته تقول إنها موجودة. مكينة LS3 ما فيها هالنظام.'),
      cause('elec', 'فيش أو سلك مجموعة الصولونويدات (VLOM) مفتوح/متآكل', notExpected ? 0.15 : 0.4, 'المجموعة تحت المنيفولد ويوصلها الزيت والحرارة.'),
      cause('elec', 'الصولونويد نفسه', notExpected ? 0.05 : 0.2, 'الملف الداخلي يعطل.'),
      cause('mech', 'مستوى أو ضغط الزيت', 0.1, 'النظام يشتغل بضغط الزيت.'),
    ]),
    tree: [
      N('a', 'ask', 'هل المكينة الحالية فيها نظام إيقاف السلندرات (AFM)؟', { opts: [['ما فيها (LS3/ملغى)', 'e1'], ['فيها', 'b'], ['ما أدري', 'c']] }),
      end('e1', 'soft', 'الكود سببه البرمجة: الكمبيوتر يختبر نظام مو موجود.', 'اطلب من المبرمج إطفاء AFM في التيون (الكمبيوتر مقفول على اللي برمجه، فلازم يكون هو).'),
      N('c', 'ask', 'شوف تحت المنيفولد خلف المكينة: هل فيه مجموعة صولونويدات (VLOM) عليها فيش؟ (أو اسأل اللي ركّب المكينة)', { opts: [['ما فيه', 'e1'], ['فيه', 'b']] }),
      N('b', 'measure', 'افصل فيش مجموعة الصولونويدات، السويتش ON: قِس فولت طرف التغذية للأرضي.', { unit: 'V', expect: 'فولت البطارية', judge: x => x >= 11 ? { st: 'ok', say: 'التغذية موجودة', go: 'd' } : { st: 'bad', say: 'ما فيه تغذية', go: 'e2' } }),
      end('e2', 'elec', 'تغذية مجموعة صولونويدات AFM مقطوعة.', 'افحص الفيوز والسلك (شوف صفحة المخطط الأصلي ص5).'),
      N('d', 'ask', 'افحص مستوى الزيت. ضمن الحد؟', { opts: [['نعم', 'e3'], ['ناقص', 'e4']] }),
      end('e3', 'elec', 'سلك التحكم أو الصولونويد نفسه.', 'قِس مقاومة الصولونويد المذكور في الكود وقارنه بالباقي، وافحص السلك للكمبيوتر.'),
      end('e4', 'mech', 'الزيت ناقص.', 'كمّل الزيت وامسح الكود وراقب.'),
    ],
  };
}

function wssTpl(code, ctx) {
  const corner = { C0035: 'الأمامي اليسار', C0040: 'الأمامي اليمين', C0045: 'الخلفي اليسار', C0050: 'الخلفي اليمين' }[code] || '';
  const front = /C00(35|40)/.test(code);
  return {
    evidence: ctx.mods?.absKill ? ['سيارتك فيها قاطع ABS — لو مفصول، أكواد الفرامل قد تكون قديمة من قبل الفصل'] : [],
    causes: pct([
      cause('mech', front ? 'رمان العجلة (الحساس مدمج فيه في هذي الشاحنات)' : 'حلقة الحساس أو بلي العجلة', front ? 0.4 : 0.25, front ? 'في شاحنات GMT900 الحساس الأمامي جزء من رمان العجلة؛ الرمان المتآكل يعطي إشارة متذبذبة.' : 'التآكل أو الصدأ على الحلقة يخرب الإشارة.'),
      cause('elec', `فيش أو سلك حساس العجلة ${corner}`, 0.4, 'الأسلاك عند العجلة تتعرض للماء والحركة.'),
      cause('elec', 'الحساس نفسه', front ? 0.1 : 0.3, 'تلف داخلي.'),
      cause('mod', 'قاطع الـABS', ctx.mods?.absKill ? 0.1 : 0, 'فصل الكمبيوتر أثناء التشغيل يخزّن أكواد.'),
    ]),
    tree: [
      N('a', 'ask', `ارفع العجلة ${corner} وحرّكها من فوق وتحت: هل فيه لعب (طقطقة) في الرمان؟`, { opts: [['فيه لعب', 'e1'], ['ما فيه', 'b']] }),
      end('e1', 'mech', 'رمان العجلة متآكل.', front ? 'بدّل رمان العجلة (يجي مع الحساس).' : 'بدّل البلي وافحص الحلقة.'),
      N('b', 'ask', 'افحص فيش الحساس والسلك على طول الشاصي: فيه تآكل/قطع/احتكاك؟', { opts: [['فيه', 'e2'], ['سليم', 'e3']] }),
      end('e2', 'elec', 'فيش أو سلك الحساس.', 'صلّح السلك ونظّف الفيش.'),
      end('e3', 'elec', 'الحساس أو حلقته.', front ? 'الحساس مدمج في الرمان — بدّل الرمان.' : 'بدّل الحساس.'),
    ],
  };
}

function genericTpl(code, ctx, sh) {
  const d = describeDtc(code);
  return {
    evidence: [], causes: pct([
      cause('elec', 'الفيش أو الأسلاك للقطعة المذكورة', 0.45, 'أغلب أكواد الدوائر سببها فيش أو سلك.'),
      cause('elec', 'القطعة نفسها', 0.3, 'بعد التأكد من الأسلاك.'),
      cause('mech', 'سبب ميكانيكي يأثر على القطعة', 0.1, 'حسب الكود.'),
      cause('soft', 'برمجة الكمبيوتر', ctx.mods?.swap || ctx.mods?.tune ? 0.15 : 0.05, 'بعد السواب/التيون بعض الاختبارات تحتاج إطفاء أو تعديل.'),
    ]),
    tree: [
      N('a', 'do', `ابدأ بالفحص البصري: فيش ${d.text} وأسلاكه.`, {}),
      N('b', 'ask', 'لقيت فيش مفصول أو متآكل أو سلك مقطوع؟', { opts: [['نعم', 'e1'], ['لا', 'e2']] }),
      end('e1', 'elec', 'فيش أو سلك.', 'صلّحه وامسح الكود.'),
      end('e2', 'elec', 'افحص التغذية والأرضي والإشارة حسب المخطط.', sh ? 'افتح الرسم الكهربائي للدائرة وقِس كل سلك حسب القيم المتوقعة.' : 'راجع مخطط المصنّع لهذي الدائرة.'),
    ],
  };
}

function areaOf(t) {
  if (/برمج|معاير|تيون|calibration/.test(t)) return 'soft';
  if (/تسريب|ضغط وقود|ضغط السلندر|ثرموستات|زيت|توقيت|سلسلة|بلوف|حفاز|ميكانيك|غطاء|طرمبة|فلتر|عادم|مروحة|بخاخ يسرّب/.test(t)) return 'mech';
  return 'elec';
}

/* ------------------------------ the analyst ------------------------------ */
// ctx: { dtcs, live, volt, running, trims, mode06, displacement, charge, freeze:[{dtc, items}], ecus, vehicle }
export function analyze(ctx) {
  const v = ctx.vehicle || {};
  const plat = gmPlatform(v, ctx.platOverride || 'auto', ctx.displacement);
  const mods = modsOf(v);
  const X = { ...ctx, plat, mods };
  const codes = [...new Set((ctx.dtcs || []).map(d => d.code))];
  const kinds = {}; for (const d of ctx.dtcs || []) (kinds[d.code] ||= new Set()).add(d.kind);
  const fam = correlate(ctx);
  const items = [];
  const sheetFor = code => plat ? gmCircuitFor(code) : circuitFor(code);
  const sameKey = code => { const c = classify(code); return c ? [c.s, c.mode, c.bank, c.sn, c.cyl].join('|') : null; };
  const seen = new Map();
  for (const g of fam) {
    const single = g.codes.length === 1 && g.score === 0.4 && g.title.startsWith(g.codes[0]);
    if (single) { const k = sameKey(g.codes[0]); if (k && seen.has(k)) { const it = seen.get(k); it.codes.push(g.codes[0]); continue; } }
    const code = g.codes[0];
    const c = code ? classify(code) : null;
    let r = null, sheetId = g.circuit || (code ? sheetFor(code) : null);
    if (c && single) {
      const sd = S[c.s];
      sheetId = (plat ? gmCircuitFor(code) : null) || sd?.sheet || sheetId;
      const sh = sheetOf(sheetId, plat);
      if (sd?.type === 'therm') r = thermTpl({ ...sd, s: c.s }, c.mode, X, sh, code);
      else if (sd?.type === 'v3') r = v3Tpl({ ...sd, s: c.s }, c.mode, X, sh, code, codes);
      else if (sd?.type === 'maf') r = mafTpl(sd, c.mode, X, sh);
      else if (c.s === 'o2') r = o2Tpl(c, X, sh, code, codes);
      else if (['inj', 'coil'].includes(c.s) || ['sol', 'vvt'].includes(sd?.type)) r = solTpl(c.s === 'inj' || c.s === 'coil' ? c.s : (sd?.type === 'vvt' ? 'vvt' : c.s), c, X, sh, codes);
      else if (c.s === 'wss') r = wssTpl(code, X);
      else if (c.s === 'ecm') r = moduleTpl(code, c, X);
      else if (c.s === 'trans') r = transTpl(code, X);
      if (!r) r = genericTpl(code, X, sh);
      const it = finish({ title: r.title || `${code}: ${describeDtc(code).text}`, codes: [code], sheet: sheetId, ...r }, X, sh, kinds);
      items.push(it); const k = sameKey(code); if (k) seen.set(k, it);
      continue;
    }
    // families from the correlation engine: keep their reasoning, add the areas, the car's wiring
    // and the test that runs on the car
    const sh = sheetOf(sheetId, plat);
    let causes = g.causes.map(x => ({ area: areaOf(x.t), t: x.t, p: x.p, why: '' }));
    let tree = null, extra = {};
    if (c?.s === 'net') { const n = netTpl(g, X, codes); causes = n.causes; tree = n.tree; extra.evidence = n.evidence; }
    else if (c?.s === 'chg' || g.circuit === 'charging') { const n = chgTpl(c || { mode: 'low' }, X, g); causes = n.causes; tree = n.tree; }
    else if (c?.s === 'afm') { const n = afmTpl(g, X); causes = n.causes; tree = n.tree; extra.evidence = n.evidence; }
    else if (c?.s === 'mis') tree = misTree(g, X);
    else if (c?.s === 'mix') tree = mixTree(g, X);
    else if (c?.s === 'cat') { const n = catAdj(g, X); causes = n.causes; tree = n.tree; extra.evidence = n.evidence; }
    else if (c?.s === 'ect' && c.mode === 'thermo') { const n = thermTpl(S.ect, 'thermo', X, sh, code); causes = n.causes; tree = n.tree; }
    else if (c?.s === 'vvt') { const n = solTpl('vvt', c, X, sh, codes); causes = n.causes; tree = n.tree; }
    else if (c?.s === 'ref5') tree = ref5Tree(X, sh);
    else if (c?.s === 'srs') tree = srsTree(X);
    // programming causes that this car's modifications make likely
    if (c?.s === 'mix' && (mods.swap || mods.tune)) causes = pct([...causes, cause('soft', 'بيانات البخاخات أو جدول MAF في البرمجة ما تطابق المكينة المركّبة', 0.25, 'بعد السواب: بخاخات المكينة الجديدة وحجمها يحتاجون معايرة مطابقة، وإلا يصحح الكمبيوتر الخلطة بشكل دائم.')]);
    if (c?.s === 'mis' && mods.tune) causes = pct([...causes, cause('soft', 'توقيت الشرارة أو الخلطة في التيون', 0.12, 'تقديم زائد في التيون يسبب طرق واحتراق ناقص تحت الحِمل.')]);
    items.push(finish({ title: g.title, codes: g.codes, sheet: sheetId, safety: g.safety, early: g.early, causes: pct(causes), evidence: [...(extra.evidence || g.evidence)], steps: g.steps, tree }, X, sh, kinds));
  }
  // causes shared by several faults: the same fuse, ground or 5V reference
  const shared = sharedCauses(items, X);
  items.sort((a, b) => (b.safety ? 1 : 0) - (a.safety ? 1 : 0) || b.score - a.score);
  return { items, shared, plat, mods, codes };
}
function finish(it, X, sh, kinds) {
  const perm = it.codes.filter(c => kinds[c] && [...kinds[c]].every(k => k === 'perm'));
  const ev = [...(it.evidence || [])];
  if (perm.length) ev.push(`${perm.join('، ')} «دائم» فقط: تأكّد سابقًا والكمبيوتر ما أعاد اختباره بنجاح بعد — ممكن يكون انصلح`);
  const top = it.causes?.[0];
  const areas = { elec: 0, mech: 0, soft: 0 }; for (const c of it.causes || []) areas[c.area] += c.p;
  return {
    ...it, evidence: ev, path: pathOf(sh), loc: partLoc(sh), sheetTitle: sh?.title, vehicleSheet: !!sh?.vehicle,
    areas, top, score: (it.safety ? 1 : 0) + (top?.p || 0) * 0.5 + (it.codes.length * 0.05),
    tree: it.tree || stepsTree(it.steps || []),
  };
}
function moduleTpl(code, c, X) {
  const soft = ['prog', 'config', 'vin', 'immo'].includes(c.mode);
  const m = MODULES[0];
  return {
    evidence: X.mods.tune ? ['سيارتك: الكمبيوتر معدّل البرمجة (تيون)'] : [],
    causes: pct([
      cause('soft', c.mode === 'vin' ? 'رقم الهيكل (VIN) مو مبرمج في الكمبيوتر' : c.mode === 'config' ? 'إعدادات السيارة في الكمبيوتر ناقصة/غلط' : c.mode === 'immo' ? 'المفتاح أو منع السرقة مو مبرمج مع الكمبيوتر' : 'برمجة الكمبيوتر تالفة أو ناقصة (فلاش فاشل/تيون)', soft ? 0.7 : 0.3, 'هذي الأكواد يكتبها الكمبيوتر لما يفحص برمجته نفسها.'),
      cause('elec', 'تغذية أو أرضي الكمبيوتر ضعيف (هبوط لحظي)', soft ? 0.15 : 0.4, `الكمبيوتر يتغذى من ${m.fuses.map(n => { const f = FUSES.find(z => z.n === n); return f ? f.name + ' ' + n : n; }).join(' و')} وأرضيه ${m.grounds.join('/')}. الهبوط يخرب الذاكرة.`),
      cause('elec', 'الكمبيوتر نفسه (عطل داخلي)', soft ? 0.15 : 0.3, 'بعد استبعاد الكهرباء والبرمجة.'),
    ]),
    tree: [
      N('a', 'ask', 'هل انبرمج الكمبيوتر أو انقطعت الكهرباء أثناء برمجة أو تركيب قطعة قريبًا؟', { opts: [['نعم', 'e1'], ['لا', 'b']] }),
      end('e1', 'soft', 'البرمجة ناقصة/تالفة.', 'أعد البرمجة عند اللي برمج الكمبيوتر (مقفول على أداته) والبطارية على شاحن ثابت.'),
      N('b', 'measure', 'السويتش ON: قِس فرق الجهد بين أرضي الكمبيوتر وسالب البطارية.', { unit: 'V', expect: 'أقل من 0.1V', judge: x => x <= 0.15 ? { st: 'ok', say: 'الأرضي سليم', go: 'c' } : { st: 'bad', say: 'الأرضي ضعيف', go: 'e2' } }),
      end('e2', 'elec', 'أرضي الكمبيوتر ضعيف.', 'نظّف وشدّ نقطة الأرضي (G102).'),
      N('c', 'ask', 'امسح الكود وشغّل: رجع على طول؟', { opts: [['رجع', 'e3'], ['ما رجع', 'e4']] }),
      end('e3', soft ? 'soft' : 'elec', soft ? 'البرمجة تحتاج إعادة.' : 'الكمبيوتر فيه عطل داخلي.', soft ? 'أعد البرمجة.' : 'افحص الكمبيوتر عند مختص قبل التبديل (لاحظ أنه مقفول على التيون).'),
      end('e4', 'elec', 'كان هبوط كهرباء مؤقت.', 'افحص البطارية وأطرافها.'),
    ],
  };
}
function transTpl(code, X) {
  const n = parseInt(code.slice(1), 10);
  const sensorish = (n >= 705 && n <= 724) || (n >= 1700 && n <= 1799);
  return {
    evidence: code === 'P0700' ? ['P0700 مجرد إشارة: كمبيوتر القير عنده كود — اقرأ أكواد كمبيوتر القير (7EA) نفسه'] : [],
    causes: pct([
      cause('mech', 'مستوى أو حالة زيت القير', sensorish ? 0.15 : 0.35, 'زيت ناقص أو محروق يسبب انزلاق وحرارة وأكواد أداء.'),
      cause('elec', 'فيش القير أو الضفيرة الداخلية (القير 6 سرعات: الكمبيوتر داخل القير)', sensorish ? 0.45 : 0.25, 'التسريب داخل الفيش أو الضفيرة يقطع الإشارات.'),
      cause('soft', 'معايرة كمبيوتر القير ما تطابق المكينة المركّبة (العزم/التبديل)', X.mods.swap || X.mods.tune ? 0.3 : 0.05, 'بعد السواب لازم تتعدل جداول العزم والتبديل وإلا يحسب الانزلاق غلط.'),
      cause('elec', 'تغذية كمبيوتر القير (TCM-BATT 14 / TRANS IGN1 19)', 0.15, 'نقص التغذية يسبب أكواد متفرقة.'),
    ]),
    tree: [
      N('a', 'ask', 'افحص مستوى زيت القير ولونه (والمكينة شغالة والقير حار حسب الطريقة). سليم؟', { opts: [['سليم', 'b'], ['ناقص/محروق', 'e1']] }),
      end('e1', 'mech', 'زيت القير.', 'كمّل/بدّل الزيت بالنوع الصحيح وامسح الأكواد وراقب.'),
      N('b', 'ask', 'افحص فيش القير على جسمه: فيه زيت أو تآكل؟', { opts: [['فيه', 'e2'], ['نظيف', 'c']] }),
      end('e2', 'elec', 'تسريب زيت أو تآكل في فيش القير.', 'نظّف الفيش وبدّل جوانه.'),
      N('c', 'ask', 'السيارة مركّبة لها مكينة غير الأصلية أو معدّلة البرمجة؟', { opts: [['نعم', 'e3'], ['لا', 'e4']] }),
      end('e3', 'soft', 'معايرة القير غالبًا ما تطابق المكينة.', 'راجع المبرمج لتعديل جداول العزم والتبديل للقير.'),
      end('e4', 'elec', 'افحص حسب الكود المحدد (حساس سرعة/صولونويد).', 'افتح رسم كمبيوتر القير وقِس التغذية والأرضي.'),
    ],
  };
}
function misTree(g, X) {
  const cyl = g.codes.filter(c => c !== 'P0300').map(c => +c.slice(3));
  const one = cyl[0];
  const seq = X.plat?.v6 ? ['1-3-5', '2-4-6'] : ['1-3-5-7', '2-4-6-8'];
  return [
    N('a', 'do', one ? `حدّد السلندر ${one}: ${one % 2 ? 'جهة السائق' : 'جهة الراكب'} (الترتيب من قدام: ${one % 2 ? seq[0] : seq[1]}).` : 'شوف عدّادات الاحتراق الناقص لكل سلندر في «الأعطال ← Mode 6» وحدّد أكثر سلندر.', {}),
    N('b', 'ask', 'بدّل الكويل بين هذا السلندر وسلندر جنبه، امسح الأكواد وسوق 15 دقيقة. انتقل الاحتراق الناقص؟', { opts: [['انتقل', 'e1'], ['ما انتقل', 'c']] }),
    end('e1', 'elec', 'الكويل.', 'بدّل الكويل.'),
    N('c', 'ask', 'شيل البوجي وافحصه (تشقق/لون/مسافة). سليم؟', { opts: [['تالف', 'e2'], ['سليم', 'd']] }),
    end('e2', 'elec', 'البوجي أو سلكه.', 'بدّل البوجي (وسلكه إذا محروق).'),
    N('d', 'ask', 'بدّل البخاخ مع سلندر جنبه (أو استمع له بسماعة): انتقل العطل أو البخاخ ساكت؟', { opts: [['نعم', 'e3'], ['لا', 'f']] }),
    end('e3', 'elec', 'البخاخ.', 'نظّف أو بدّل البخاخ.'),
    N('f', 'measure', 'سوّ اختبار ضغط للسلندر (Compression). كم psi؟', { unit: 'psi', expect: 'قريب من باقي السلندرات (الفرق أقل من 10–15%)', judge: x => x >= 130 ? { st: 'ok', say: 'الضغط مقبول', go: 'e4' } : { st: 'bad', say: 'ضغط منخفض', go: 'e5' } }),
    end('e4', X.mods.tune ? 'soft' : 'mech', X.mods.tune ? 'القطع سليمة والضغط سليم — راجع التيون (التوقيت/الخلطة) وتسريب الهواء عند هذا السلندر.' : 'الضغط سليم — افحص تسريب هواء عند جوان المنيفولد لهذا السلندر.', X.mods.tune ? 'راجع المبرمج.' : 'رش منظّف حول المنيفولد عند السلندر.'),
    end('e5', 'mech', 'مشكلة ميكانيكية: بلف أو حلقات أو رفّاع (Lifter).', 'سوّ اختبار تسريب (Leak-down) لتحديد المصدر. في مكائن AFM الرفّاع المعطّل شائع.'),
  ];
}
function mixTree(g, X) {
  const lean = g.codes.some(c => /^P017[14]$/.test(c));
  return [
    N('a', 'live', 'المكينة حارّة على الخمول: كم تعديل الوقود الطويل للبنك 1؟', { run: true, pid: 0x07, unit: '%', expect: 'بين −10% و +10%', judge: x => (lean ? x > 10 : x < -10) ? { st: 'bad', say: lean ? 'يضيف وقود كثير (فقير)' : 'ينقص وقود كثير (غني)', go: 'b' } : { st: 'ok', say: 'طبيعي الآن', go: 'b' } }),
    N('b', 'live', 'ارفع الدوران لـ2500 وثبّته 30 ثانية: كم التعديل الطويل الحين؟', { pid: 0x07, unit: '%', judge: x => lean && x < 8 ? { st: 'info', say: 'يتحسن مع الدوران: بصمة تسريب هواء', go: 'c' } : { st: 'info', say: 'ما يتحسن مع الدوران: بصمة وقود/MAF', go: 'd' } }),
    N('c', 'ask', 'رشّ منظّف حول المنيفولد والخراطيم وخرطوم البوستر والـPCV: تغيّر الدوران عند نقطة؟', { opts: [['نعم', 'e1'], ['لا', 'd']] }),
    end('e1', 'mech', 'تسريب هواء في المكان اللي تغيّر عنده الدوران.', 'صلّح الجوان/الخرطوم.'),
    N('d', 'measure', 'قِس ضغط البنزين على السكة بساعة (المكينة شغالة). كم psi؟', { unit: 'psi', expect: 'حسب مواصفة المكينة (LS عادة ~55–62 psi تقديري)', judge: x => x >= 50 ? { st: 'ok', say: 'الضغط مقبول', go: 'f' } : { st: 'bad', say: 'ضغط منخفض', go: 'e2' } }),
    end('e2', 'mech', 'ضغط البنزين ضعيف.', 'افحص فلتر البنزين والطرمبة وكمبيوتر الطرمبة (FPCM) وأرضيه G300.'),
    N('f', 'ask', 'المكينة مركّبة أو البرمجة معدّلة؟', { opts: [['نعم', 'e3'], ['لا', 'e4']] }),
    end('e3', 'soft', 'بيانات البخاخات أو جدول MAF في التيون ما تطابق المكينة.', 'راجع المبرمج لتصحيح بيانات البخاخات وجدول MAF.'),
    end('e4', 'elec', 'حساس MAF متّسخ أو منحرف.', 'نظّف الحساس وأعد الفحص.'),
  ];
}
function catAdj(g, X) {
  const rear = X.mods.rearO2Off;
  const causes = pct([...g.causes.map(x => ({ area: areaOf(x.t), t: x.t, p: x.p, why: '' })), ...(rear ? [cause('soft', 'الحساس الخلفي أو الدبة ملغاة والبرمجة ما زالت تختبر الدبة', 0.6, 'اختبار الدبة يقارن الحساس الأمامي بالخلفي — لو الدبة مشالة لازم يطفأ الاختبار في البرمجة.')] : [])]);
  const bank = g.codes.some(c => /P043/.test(c)) ? 2 : 1;
  const f = O2PID[`${bank}-1`], r = O2PID[`${bank}-2`];
  return {
    causes, evidence: g.evidence.concat(rear ? ['سيارتك: الحساسات الخلفية/الدبات معدّلة'] : []),
    tree: [
      ...(rear ? [N('z', 'ask', 'الدبة مشالة أو الحساس الخلفي مفصول/معدّل؟', { opts: [['نعم', 'ez'], ['لا', 'a']] }), end('ez', 'soft', 'الكود سببه التعديل: البرمجة تختبر دبة مو موجودة.', 'اطلب من المبرمج إطفاء اختبار الدبة والحساسات الخلفية.')] : []),
      N('a', 'live', `المكينة حارّة على 2000 دورة: راقب الحساس الخلفي للبنك ${bank}.`, { run: true, pid: r, pid2: f, unit: 'V', expect: 'الخلفي ثابت تقريبًا (0.5–0.8V) والأمامي يتذبذب', judge: (x, y) => ({ st: 'info', say: `الخلفي ${fix1(x)}V${y != null ? ` · الأمامي ${fix1(y)}V` : ''}`, go: 'b' }) }),
      N('b', 'ask', 'هل الحساس الخلفي يتذبذب بسرعة مثل الأمامي؟', { opts: [['نعم يتذبذب', 'c'], ['ثابت', 'e2']] }),
      N('c', 'ask', 'فيه تسريب عادم بين المكينة والحساس الخلفي (صوت/سواد عند الوصلات)؟', { opts: [['فيه', 'e3'], ['ما فيه', 'e1']] }),
      end('e1', 'mech', 'الدبة ضعيفة (ما تخزّن الأكسجين).', 'بدّل الدبة بعد ما تتأكد ما فيه احتراق ناقص أو خلطة غنية سابقة (تحرقها من جديد).'),
      end('e2', 'elec', 'الدبة تشتغل والحساس الخلفي ثابت — الأرجح حساس أو اختبار حدّي.', 'افحص الحساس الخلفي، وامسح الكود وراقب اختبار الدبة في Mode 6.'),
      end('e3', 'mech', 'تسريب عادم قبل الحساس الخلفي.', 'صلّح التسريب ثم أعد الفحص.'),
    ],
  };
}
function ref5Tree(X, sh) {
  return [
    N('a', 'measure', 'السويتش ON: قِس 5V ref في فيش أي حساس من المجموعة (MAP/الثروتل/الدعسة/ضغط الزيت).', { unit: 'V', expect: '4.8–5.2V', judge: x => x >= 4.6 && x <= 5.3 ? { st: 'ok', say: 'المرجع سليم الآن', go: 'e0' } : { st: 'bad', say: 'المرجع ساقط', go: 'b' } }),
    end('e0', 'elec', 'المرجع سليم الآن — العطل متقطع.', 'حرّك ضفائر الحساسات وراقب، وافحص الفيشات.'),
    N('b', 'ask', 'افصل الحساسات وحدة وحدة وأنت تقيس: رجع الـ5V لما فصلت واحد منها؟', { opts: [['رجع', 'e1'], ['ما رجع مع أي واحد', 'e2']] }),
    end('e1', 'elec', 'الحساس اللي فصلته متماس داخليًا ويسحب المرجع.', 'بدّل هذا الحساس.'),
    end('e2', 'elec', 'سلك المرجع متماس مع الأرضي في الضفيرة أو الكمبيوتر.', 'افحص الضفيرة بين الحساسات والكمبيوتر (احتكاك/ذوبان).'),
  ];
}
function srsTree(X) {
  return [
    N('a', 'do', '⚠ افصل سالب البطارية وانتظر دقيقتين على الأقل قبل لمس أي فيش أصفر. لا تقِس الوسائد بالملتيميتر أبدًا.', {}),
    N('b', 'ask', 'افحص فيشات تحت الكراسي (حساس الحزام وحساس الراكب): مثبّتة ونظيفة؟ (حرّك الكرسي لقدام ولورا)', { opts: [['فيه فيش مرتخي/متآكل', 'e1'], ['سليمة', 'c']] }),
    end('e1', 'elec', 'فيش تحت الكرسي.', 'ثبّت/نظّف الفيش ثم امسح أكواد الوسائد بجهاز يوصل الشبكة البطيئة.'),
    N('c', 'ask', 'هل الهرن أو أزرار الطارة فيها مشكلة أو تغيّر شي عند لف الدركسون؟', { opts: [['نعم', 'e2'], ['لا', 'e3']] }),
    end('e2', 'elec', 'الساعة الحلزونية (Clock spring) خلف الطارة.', 'بدّل الساعة الحلزونية.'),
    end('e3', 'elec', 'يحتاج قراءة كود الوسائد التفصيلي.', 'كمبيوتر الوسائد على الشبكة البطيئة (طرف 1) — يحتاج قطعة فيها SW-CAN لقراءة الكود التفصيلي.'),
  ];
}
function stepsTree(steps) {
  if (!steps.length) return [];
  const t = steps.map((s, i) => N('s' + i, 'do', `${s.t}${s.m ? ` — القياس: ${s.m}` : ''}${s.e ? ` — المتوقع: ${s.e}` : ''}`, { next: i < steps.length - 1 ? 's' + (i + 1) : 'end' }));
  t.push(end('end', 'elec', 'انتهت خطوات الفحص.', 'قارن نتائجك بالمتوقع في كل خطوة.'));
  return t;
}
function sharedCauses(items, X) {
  const out = [];
  if (!X.plat) return out;
  const fuseUse = {};
  const add = (key, it) => { (fuseUse[key] ||= new Set()).add(it.codes.join('/')); };
  for (const it of items) for (const p of it.path) for (const f of FUSES) if (p.pin && new RegExp(`\\b${f.name.replace(/[/-]/g, '.')}\\b`).test(p.pin)) add(`${f.name} ${f.n} (${f.a}A)`, it);
  for (const [k, set] of Object.entries(fuseUse)) if (set.size > 1) out.push({ t: `فيوز ${k}`, codes: [...set], why: 'أكثر من عطل دائرته تمر على نفس الفيوز — افحصه قبل أي شي.' });
  const lowIn = items.filter(it => it.codes.some(c => classify(c)?.mode === 'low' && ['map', 'tps', 'app', 'eop', 'ftp'].includes(classify(c)?.s)));
  if (lowIn.length > 1) out.push({ t: 'مرجع 5V المشترك', codes: lowIn.flatMap(i => i.codes), why: 'أكثر من حساس «دخل منخفض» معًا — غالبًا المرجع المشترك وليس حساسات متعددة.' });
  const nets = items.filter(it => it.codes.some(c => c[0] === 'U'));
  const volt = X.volt;
  if (nets.length && volt && volt < 12.2) out.push({ t: 'فولت البطارية', codes: nets.flatMap(i => i.codes), why: `الفولت الآن ${volt.toFixed(2)}V — أكواد فقد الاتصال كثير منها يجي من هبوط الفولت.` });
  return out;
}

// Everything the analyst needs, taken from the app state.
export function analysisCtx(app, displacement = null) {
  return {
    dtcs: app.allDtcs(), live: app.liveValues(), volt: app.conn.voltage, running: app.running(), trims: app.trims(),
    mode06: app.mode06?.map ? [...app.mode06.map.values()].flat() : [], displacement: displacement ?? app.vehicle?.displacement ?? null,
    charge: chargeRange(app.vehicle), freeze: [...(app.freeze?.values?.() || [])], ecus: [...app.ecus.values()], vehicle: app.vehicle,
    platOverride: settings().wiringPlat || 'auto',
  };
}
// A compact text of the analysis for the AI technician.
export function analysisText(a) {
  if (!a?.items?.length) return '';
  const L = [];
  if (a.plat) L.push(`مخطط السيارة: ${a.plat.title}`);
  const m = a.mods; const ml = [m.swap && 'مكينة مركّبة (سواب)', m.tune && 'برمجة معدّلة (تيون)', m.afmOff && 'AFM ملغى', m.rearO2Off && 'حساسات/دبات خلفية ملغاة', m.absKill && 'قاطع ABS'].filter(Boolean);
  if (ml.length || m.notes) L.push(`تعديلات السيارة: ${ml.join('، ')}${m.notes ? ' — ' + m.notes : ''}`);
  for (const it of a.items.slice(0, 6)) {
    L.push(`• ${it.title} [${it.codes.join(' ')}]`);
    L.push('  أسباب مرجّحة: ' + it.causes.slice(0, 4).map(c => `${AREA[c.area][0]}: ${c.t} ${Math.round(c.p * 100)}%`).join(' | '));
    if (it.evidence.length) L.push('  أدلة: ' + it.evidence.slice(0, 4).join(' | '));
    if (it.path.length) L.push('  الدائرة: ' + it.path.slice(0, 6).map(p => `${p.label}${p.pin ? ' = ' + p.pin : ''}`).join(' | '));
  }
  for (const sc of a.shared || []) L.push(`سبب مشترك محتمل: ${sc.t} — ${sc.why} (${sc.codes.join(' ')})`);
  return L.join('\n');
}
