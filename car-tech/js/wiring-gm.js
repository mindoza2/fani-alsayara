// Vehicle-specific wiring for GM GMT900 trucks/SUVs (Sierra/Silverado/Tahoe/Yukon… 2007–2014).
// Names, locations, fuses and grounds come from the factory system wiring diagrams of the
// GMC Sierra 1500 2012 (same platform as the 2010 Silverado); the data-network pin numbers, wire
// colours and circuit numbers come from the 2010 Tahoe "Computer Data Lines" diagram of the same
// platform. Every fact says where it came from, and every circuit links to the original page.
import { esc } from './util.js';
import { circuitFor } from './diag.js';

const page = sys => `https://portal-diagnostov.com/en/2020/04/13/${sys}-gmc-sierra-1500-2012-system-wiring-diagrams/`;
export const SRC = {
  data: page('computer-data-lines'), power: page('power-distribution'), ground: page('ground-distribution'),
  charging: page('starting-charging'), engine: page('engine-performance'), abs: page('anti-lock-brakes'),
  srs: page('supplemental-restraints'), trans: page('transmission'), bcm: page('body-control-modules'), ipc: page('instrument-cluster'),
};
// Where a fact comes from (shown as a small badge)
const LV = {
  oem: ['c-sure', 'مخطط المصنّع', 'من مخطط المصنّع لسييرا 2012 (نفس منصة سيارتك)'],
  plat: ['c-best', 'نفس المنصة', 'من مخطط المصنّع لسيارة أخرى على منصة GMT900 (تاهو 2010) — طابقه مع مخطط سيارتك قبل القياس'],
  std: ['c-sure', 'معيار SAE', 'معيار فيش الفحص SAE J1962'],
  est: ['c-est', 'تقديري', 'قيمة متوقعة تقديرية — تحقّق منها'],
};
export function srcBadge(l) { const [cls, t, tip] = LV[l] || LV.est; return `<span class="conf ${cls}" title="${esc(tip)}">${t}</span>`; }

/* ---------------------------- platform ---------------------------- */
const TRUCK = /sierra|silverado|tahoe|yukon|suburban|avalanche|escalade|سييرا|سيرا|سلفرادو|سلفادو|تاهو|يوكن|يوكون|سوبربان|افلانش/i;
// override: 'auto' | 'gmt900' | 'generic'
export function gmPlatform(v = {}, override = 'auto', disp = null) {
  if (override === 'generic') return null;
  const y = +v.year || 0;
  const auto = v.group === 'GM' && y >= 2007 && y <= 2014 && (/شاحنة/.test(v.make || '') || /^(1GT|1GC|2GT|2GC|3GT|3GC)/.test(v.vin || '') || TRUCK.test(v.model || ''));
  if (!auto && override !== 'gmt900') return null;
  const d = +(v.displacement ?? disp) || 0;
  const eng = d ? (d < 4.5 ? '4.3' : d < 5.0 ? '4.8' : d < 5.7 ? '5.3' : d < 6.1 ? '6.0' : '6.2') : null;
  const name = /GMC/.test(v.make || '') ? 'GMC سييرا' : /Chevrolet/.test(v.make || '') ? 'شفروليه سلفرادو' : 'شاحنة GM';
  return { id: 'gmt900', eng, v6: eng === '4.3', title: `${name}${y ? ' ' + y : ''} — منصة GMT900${eng ? ` · مكينة ${eng}` : ''}`, manual: !auto };
}

/* ---------------------------- reference data ---------------------------- */
const UH = 'علبة فيوزات المكينة (يسار غرفة المكينة)', IP = 'علبة فيوزات الطبلون (يسار الطبلون)';
export const FUSES = [
  { n: '—', name: 'MEGA', a: '175', where: 'علبة الفيوز على قطب البطارية الموجب', feeds: 'خرج الدينمو B+ إلى البطارية', l: 'oem', src: 'charging' },
  { n: '53', name: 'LTR', a: '20', where: UH, feeds: 'فيش الفحص طرف 16 (تغذية قطعة الفحص) والولاعة', l: 'plat', src: 'data' },
  { n: '12', name: 'ECM-BATT', a: '10', where: UH, feeds: 'كمبيوتر المكينة — تغذية دائمة', l: 'oem', src: 'engine' },
  { n: '56', name: 'ECM-IGN', a: '15', where: UH, feeds: 'كمبيوتر المكينة — تغذية التشغيل (ومعها كمبيوتر الطرمبة)', l: 'oem', src: 'engine' },
  { n: '5', name: 'ECM/THROT CONT', a: '15', where: UH, feeds: 'كمبيوتر المكينة / الثروتل الإلكتروني', l: 'oem', src: 'engine' },
  { n: '4', name: 'ENG', a: '15', where: UH, feeds: 'حساسات وصمامات المكينة', l: 'oem', src: 'engine' },
  { n: '24', name: 'INJ-A', a: '20', where: UH, feeds: 'البخاخات', l: 'oem', src: 'engine' },
  { n: '13', name: 'INJ-B', a: '20', where: UH, feeds: 'البخاخات (ما عدا 4.3)', l: 'oem', src: 'engine' },
  { n: '18', name: 'O2-A SNSR', a: '10', where: UH, feeds: 'سخّانات حساسات الأكسجين', l: 'oem', src: 'engine' },
  { n: '8', name: 'O2-B SNSR', a: '10', where: UH, feeds: 'سخّانات حساسات الأكسجين', l: 'oem', src: 'engine' },
  { n: '14', name: 'TCM-BATT', a: '15', where: UH, feeds: 'كمبيوتر القير — تغذية دائمة (10A في بعض الطرازات)', l: 'oem', src: 'trans' },
  { n: '19', name: 'TRANS IGN1', a: '15', where: UH, feeds: 'كمبيوتر القير — تغذية التشغيل', l: 'oem', src: 'trans' },
  { n: '43', name: 'MISC IGN', a: '10', where: UH, feeds: 'تغذية تشغيل (القير/الطرمبة وغيرها)', l: 'oem', src: 'trans' },
  { n: '61', name: 'ABS', a: '40', where: UH, feeds: 'كمبيوتر الفرامل EBCM', l: 'oem', src: 'abs' },
  { n: '59', name: 'HEAVY DUTY ABS', a: '60', where: UH, feeds: 'كمبيوتر الفرامل (الأوزان 8600 فما فوق)', l: 'oem', src: 'abs' },
  { n: '45', name: 'AIR BAG BATT', a: '15', where: UH, feeds: 'كمبيوتر الوسائد SDM — تغذية دائمة', l: 'oem', src: 'power' },
  { n: '40', name: 'AIR BAG IGN', a: '10', where: UH, feeds: 'كمبيوتر الوسائد SDM — تغذية التشغيل', l: 'oem', src: 'power' },
  { n: '46', name: 'IPC', a: '10', where: UH, feeds: 'لوحة العدادات', l: 'oem', src: 'charging' },
  { n: '15', name: 'BCM', a: '10', where: IP, feeds: 'كمبيوتر الهيكل', l: 'oem', src: 'bcm' },
  { n: '21', name: 'FSCM', a: '20', where: UH, feeds: 'كمبيوتر طرمبة البنزين FPCM', l: 'oem', src: 'engine' },
  { n: '67', name: 'TREC', a: '30', where: UH, feeds: 'علبة التوزيع (الدبل)', l: 'oem', src: 'trans' },
  { n: '62', name: 'STRTR', a: '40', where: UH, feeds: 'ريليه السلف', l: 'oem', src: 'charging' },
  { n: '57', name: 'FAN-1', a: '40', where: UH, feeds: 'مراوح الرديتر', l: 'oem', src: 'power' },
  { n: '60', name: 'FAN-2', a: '40', where: UH, feeds: 'مراوح الرديتر', l: 'oem', src: 'power' },
  { n: '39', name: 'HVAC BATT', a: '10', where: UH, feeds: 'كمبيوتر المكيف — تغذية دائمة', l: 'oem', src: 'power' },
  { n: '55', name: 'HVAC-IGN', a: '10', where: UH, feeds: 'كمبيوتر المكيف — تغذية التشغيل', l: 'oem', src: 'power' },
  { n: '42', name: 'RDO', a: '15', where: UH, feeds: 'الراديو', l: 'oem', src: 'power' },
];
export const GROUNDS = [
  { g: 'G101', loc: 'أسفل يمين قاعدة الرديتر', on: 'سالب البطارية إلى الهيكل، الأنوار الأمامية', l: 'oem', src: 'charging' },
  { g: 'G102', loc: 'أسفل يسار مقدمة المكينة (ما عدا 4.3)', on: 'كمبيوتر المكينة، الكويلات', l: 'oem', src: 'engine' },
  { g: 'G103', loc: 'مقدمة رأس السلندرات اليمين', on: 'سالب البطارية إلى المكينة، حساسات المكينة، القير، كمبيوتر الهيكل', l: 'oem', src: 'charging' },
  { g: 'G104', loc: 'مقدمة رأس السلندرات اليسار', on: 'أرضي المكينة', l: 'oem', src: 'ground' },
  { g: 'G106', loc: 'يمين خلف المكينة (4.3 فقط)', on: 'أرضي المكينة والقير لمكينة V6', l: 'oem', src: 'trans' },
  { g: 'G107', loc: 'أعلى يسار خلف المكينة (4.3 فقط)', on: 'أرضي المكينة لمكينة V6', l: 'oem', src: 'trans' },
  { g: 'G108', loc: 'يسار الجدار الناري (بين المكينة والكابينة)', on: 'أرضي غرفة المكينة', l: 'oem', src: 'ground' },
  { g: 'G200', loc: 'يمين مقدمة علبة المكيف (خلف الطبلون)', on: 'فيش الفحص طرف 4، كمبيوتر الوسائد', l: 'plat', src: 'data' },
  { g: 'G201', loc: 'أعلى يسار الطبلون', on: 'فيش الفحص طرف 5، كمبيوتر الهيكل، العدادات، الفرامل', l: 'oem', src: 'data' },
  { g: 'G300', loc: 'تحت باب السائق على قاعدة الجسم', on: 'كمبيوتر طرمبة البنزين، الفرامل', l: 'oem', src: 'engine' },
  { g: 'G302', loc: 'أسفل يمين كرسي الراكب', on: 'الوسائد الهوائية', l: 'oem', src: 'srs' },
];
export const DLC_PINS = [
  { p: 1, f: 'شبكة LS-GMLAN البطيئة (سلك واحد)', col: 'DK GRN', ckt: '5060', to: 'كمبيوتر الهيكل، العدادات، الوسائد، المكيف، الراديو…', note: 'محوّل ELM327 لا يقرأ هذا الطرف' },
  { p: 4, f: 'أرضي الهيكل', col: 'BLK', ckt: '1050', to: 'G200' },
  { p: 5, f: 'أرضي الإشارة', col: 'BLK/WHT', ckt: '1851', to: 'G201 (عبر علبة الوصلات اليسار)' },
  { p: 6, f: 'HS-GMLAN + (CAN-H)', col: 'TAN/BLK', ckt: '2500', to: 'شبكة الكمبيوترات السريعة' },
  { p: 14, f: 'HS-GMLAN − (CAN-L)', col: 'TAN', ckt: '2501', to: 'شبكة الكمبيوترات السريعة' },
  { p: 16, f: 'تغذية بطارية +12V دائمة', col: 'RED/WHT', ckt: '640', to: 'فيوز LTR 53 (20A)' },
];
// Modules: where they are, what feeds them, where they are grounded, how they talk.
export const MODULES = [
  { id: 'ECM', ar: 'كمبيوتر المكينة', match: /المكينة|\bECM\b|\bPCM\b/, loc: 'يسار مقدمة غرفة المكينة، قرب غطاء المروحة', net: 'HS', fuses: ['12', '56', '5'], grounds: ['G102'], gv6: ['G106', 'G107'],
    pins: [['X1-28', 'HS-GMLAN +', 'TAN/BLK', '2500'], ['X1-27', 'HS-GMLAN −', 'TAN', '2501'], ['X1-31', 'إيقاظ الشبكة (Accessory wakeup)', 'DK BLU', '5985']],
    note: 'في جهته مقاومة إنهاء الشبكة الأولى (120Ω).', src: 'engine' },
  { id: 'TCM', ar: 'كمبيوتر القير', match: /القير|\bTCM\b/, loc: 'قير 6 سرعات: داخل القير (مدمج مع بلوك الصمامات) — قير 4 سرعات: يسار مقدمة غرفة المكينة قرب غطاء المروحة', net: 'HS', fuses: ['14', '19'], grounds: ['G103'], gv6: ['G106'],
    pins: [['X1-14', 'HS-GMLAN +', 'TAN/BLK', '2500'], ['X1-13', 'HS-GMLAN −', 'TAN', '2501'], ['X1-9', 'إيقاظ الشبكة', 'DK BLU', '5985']], src: 'trans' },
  { id: 'BCM', ar: 'كمبيوتر الهيكل', match: /الهيكل|\bBCM\b/, loc: 'أسفل يسار الطبلون', net: 'HS + LS + LIN', fuses: ['15'], grounds: ['G201', 'G103'],
    pins: [['X3-16', 'HS-GMLAN +', 'TAN/BLK', '2500'], ['X3-17', 'HS-GMLAN −', 'TAN', '2501'], ['X3-19', 'تفعيل الاتصال (Serial data comm enable)', 'LT BLU', '5986'], ['X4-19', 'إيقاظ الشبكة', 'DK BLU', '5985'], ['10', 'LS-GMLAN', 'DK GRN', '5060'], ['X4-6', 'LIN', 'DK GRN', '6134']],
    note: 'يقرأ حساس تيار البطارية (على الكيبل السالب) ويطلب من كمبيوتر المكينة فولت الشحن (نظام RVC). هو البوابة بين الشبكتين.', src: 'bcm' },
  { id: 'EBCM', ar: 'كمبيوتر الفرامل ABS', match: /الفرامل|\bABS\b|EBCM/, loc: 'على الشاصي — الجهة اليسرى', net: 'HS', fuses: ['61', '59'], grounds: [], gtext: 'نقاط الأرضي في مخطط الفرامل: G201 و G300',
    pins: [['X115', 'HS-GMLAN + / − (ضفيرة الشاصي)', 'YEL/BLK · YEL', '2500 · 2501'], ['—', 'تفعيل الاتصال', 'LT BLU', '5986']], pinNote: 'أرقام أطراف الكمبيوتر تختلف بين 1500 و2500', src: 'abs' },
  { id: 'TCCM', ar: 'كمبيوتر علبة التوزيع (الدبل)', match: /الدبل|التوزيع|TCCM/, loc: 'أسفل يسار الطبلون', net: 'HS', fuses: ['67'], grounds: [],
    pins: [['X2-5', 'HS-GMLAN +', 'TAN/BLK', '2500'], ['X2-4', 'HS-GMLAN −', 'TAN', '2501'], ['X2-10', 'إيقاظ الشبكة', 'DK BLU', '5985']], src: 'trans' },
  { id: 'FPCM', ar: 'كمبيوتر طرمبة البنزين', match: /طرمبة|FPCM|FSCM/, loc: 'الشاصي الخلفي قرب تثبيت الاستبنة', net: 'HS', fuses: ['21', '56'], grounds: ['G300'],
    pins: [['—', 'HS-GMLAN + / −', 'TAN/BLK · TAN', '2500 · 2501'], ['17', 'تفعيل الاتصال (من كمبيوتر الهيكل)', 'LT BLU', '5986']],
    note: 'كمبيوتر المكينة يطلب ضغط البنزين منه عبر الشبكة — ما فيه ريليه طرمبة تقليدي.', src: 'engine' },
  { id: 'SDM', ar: 'كمبيوتر الوسائد الهوائية', match: /الوسائد|SDM|airbag/i, loc: 'تحت كرسي السائق', net: 'LS', fuses: ['45', '40'], grounds: ['G302', 'G200'],
    pins: [['2', 'LS-GMLAN', 'DK GRN', '5060']], circuit: 'srs', src: 'srs' },
  { id: 'IPC', ar: 'لوحة العدادات', match: /العدادات|\bIPC\b/, loc: 'الطبلون', net: 'LS', fuses: ['46'], grounds: [],
    pins: [['6', 'LS-GMLAN', 'DK GRN', '5060']], src: 'ipc' },
  { id: 'HVAC', ar: 'كمبيوتر المكيف', match: /المكيف|HVAC/, loc: 'وسط الطبلون', net: 'LS', fuses: ['39', '55'], grounds: [], pins: [['5', 'LS-GMLAN', 'DK GRN', '5060']], src: 'data' },
  { id: 'RADIO', ar: 'الراديو', match: /الراديو|radio/i, loc: 'وسط الطبلون', net: 'LS', fuses: ['42'], grounds: [], pins: [['13', 'LS-GMLAN', 'DK GRN', '5060']], src: 'data' },
  { id: 'TDM', ar: 'وحدة منع السرقة', match: /منع السرقة|TDM|immob/i, loc: 'على سويتش التشغيل', net: 'LS', fuses: [], grounds: [], pins: [['4', 'LS-GMLAN', 'DK GRN', '5060']], src: 'data' },
  { id: 'VCIM', ar: 'وحدة الاتصال OnStar', match: /OnStar|VCIM/i, loc: 'وسط الطبلون', net: 'HS + LS', fuses: [], grounds: [], pins: [['X1-10 · X1-12', 'HS-GMLAN + / −', 'TAN/BLK · TAN', '2500 · 2501'], ['X1-1', 'LS-GMLAN', 'DK GRN', '5060']], src: 'data' },
];
const fuse = n => FUSES.find(f => f.n === n);
const gnd = g => GROUNDS.find(x => x.g === g);
const fuseTxt = n => { const f = fuse(n); return f ? `${f.name} ${f.n} (${f.a}A)` : n; };
const gndTxt = g => { const x = gnd(g); return x ? `${g} — ${x.loc}` : g; };
export function moduleGrounds(m, plat) { return plat?.v6 && m.gv6 ? m.gv6 : m.grounds; }

/* ---------------------------- circuits ---------------------------- */
const W = (i, role, label, expect, measure, o = {}) => ({ i, role, label, expect, measure, conf: 'best', l: 'oem', ...o });
const C = (id, label, sub, x, y, w, h, kind = 'part') => ({ id, label, sub, x, y, w, h, kind });
const ECM = (x = 40, y = 70, h = 260) => C('ecm', 'كمبيوتر المكينة ECM', 'يسار مقدمة غرفة المكينة', x, y, 150, h, 'ecm');
const NOTE_PINS = 'اسم السلك من مخطط المصنّع. رقم الطرف عند فيش الكمبيوتر في صفحة المخطط الأصلي.';
function sensor({ title, comp, sub, pid, wires, notes = [], extra = [], src = 'engine' }) {
  return { title, src, comps: [ECM(), C('c', comp, sub, 590, 110, 170, 40 + wires.filter(w => !w.a).length * 40), ...extra], wires, notes: [...notes, NOTE_PINS], pid };
}
function sixTwoNote(plat) {
  if (plat.eng === '6.2') return ['مخطط 6.2 من المصنّع لمكينة L9H/L92 (فيها صولونويد الكامات VVT وتعطيل السلندرات AFM). لو مكينتك LS3 مركّبة (سواب): ما فيها AFM ولا VVT، وتمديداتها حسب طريقة التركيب.'];
  return [];
}
export function gmCircuits(plat) {
  const v6 = plat.v6;
  const engGnd = v6 ? 'G106 / G107' : 'G102 / G103';
  const mod = id => () => moduleCircuit(MODULES.find(m => m.id === id), plat);
  return {
    dlc: () => ({ title: 'فيش الفحص (DLC): التغذية والأرضي والشبكات', src: 'data', comps: [
      C('bat', 'البطارية', '+12V', 20, 10, 170, 60, 'batt'), C('f', 'فيوز LTR 53 · 20A', 'علبة فيوزات المكينة', 315, 10, 170, 60, 'fuse'),
      C('dlc', 'فيش الفحص', 'تحت يسار الطبلون', 315, 140, 170, 110, 'dlc'), C('ls', 'شبكة LS-GMLAN', 'كمبيوترات الكابينة', 20, 160, 170, 70), C('hs', 'شبكة HS-GMLAN', 'المكينة · القير · الفرامل…', 610, 160, 170, 70),
      C('g201', 'G201', 'أعلى يسار الطبلون', 315, 320, 170, 60), C('g200', 'G200', 'يمين مقدمة علبة المكيف', 610, 320, 170, 60)],
      wires: [
        W(0, 'b+', 'تغذية الفيوز', 'فولت البطارية', 'فولت بين طرفي الفيوز والأرضي', { a: 'bat', b: 'f', conf: 'best', l: 'plat' }),
        W(1, 'b+', 'طرف 16 · RED/WHT 640', 'فولت البطارية دائمًا (حتى والسويتش طافي)', 'فولت بين طرف 16 وطرف 4', { a: 'f', b: 'dlc', vlive: true, pin: 'طرف 16 · RED/WHT · دائرة 640 · من فيوز LTR 53 (20A)', l: 'plat' }),
        W(2, 'gnd', 'طرف 5 · BLK/WHT 1851', 'أقل من 0.1V فرق مع سالب البطارية', 'فرق جهد بين طرف 5 وسالب البطارية', { a: 'dlc', b: 'g201', pin: 'طرف 5 · BLK/WHT · دائرة 1851 · إلى G201 عبر علبة الوصلات اليسار', l: 'plat' }),
        W(3, 'gnd', 'طرف 4 · BLK 1050', 'أقل من 0.1V فرق مع سالب البطارية', 'فرق جهد بين طرف 4 وسالب البطارية', { a: 'dlc', b: 'g200', pin: 'طرف 4 · BLK · دائرة 1050 · إلى G200', l: 'plat' }),
        W(4, 'can', 'طرف 6 / 14', 'مقاومة بين 6 و14 ≈ 60Ω والبطارية مفصولة', 'أوم بين طرف 6 و14', { a: 'dlc', b: 'hs', pin: 'طرف 6 · TAN/BLK · 2500 (+) — طرف 14 · TAN · 2501 (−)', l: 'plat' }),
        W(5, 'can', 'طرف 1 · DK GRN 5060', 'نبضات منخفضة الفولت والسيارة صاحية', 'فولت متوسط بين طرف 1 والأرضي', { a: 'dlc', b: 'ls', pin: 'طرف 1 · DK GRN · دائرة 5060', l: 'plat' }),
      ], notes: ['إذا القطعة ما تشتغل (ما يولّع ضوءها): افحص فيوز LTR 53 أولًا، ثم طرف 16 وطرف 4.', 'وظائف الأطراف (1، 4، 5، 6، 14، 16) معيار SAE ثابت؛ الألوان وأرقام الدوائر من مخطط منصة GMT900.'] }),
    canbus: () => ({ title: 'شبكة HS-GMLAN السريعة (500 kbps) — الكمبيوترات اللي يقرأها التطبيق', src: 'data', comps: [
      C('ecm', 'كمبيوتر المكينة', 'إنهاء 120Ω', 20, 30, 170, 80, 'ecm'), C('tcm', 'كمبيوتر القير', 'TCM', 215, 30, 170, 80), C('bcm', 'كمبيوتر الهيكل', 'BCM · البوابة', 410, 30, 170, 80), C('dlc', 'فيش الفحص', 'طرف 6 / 14', 605, 30, 175, 80, 'dlc'),
      C('dlr', 'مقاومة الإنهاء 2', 'Data Link Resistor 1 · الشاصي', 20, 240, 170, 80, 'relay'), C('fpcm', 'كمبيوتر الطرمبة', 'FPCM · خلف الشاصي', 215, 240, 170, 80), C('ebcm', 'كمبيوتر الفرامل', 'EBCM · يسار الشاصي', 410, 240, 170, 80), C('tccm', 'كمبيوتر الدبل', 'TCCM · أسفل الطبلون', 605, 240, 175, 80)],
      wires: [
        W(0, 'can', 'TAN/BLK · TAN', 'مقاومة 6↔14 ≈ 60Ω', 'افصل البطارية وقِس بين 6 و14 في فيش الفحص', { a: 'ecm', b: 'tcm', mod: 'ECM', pin: 'ECM: X1-28 (+) · X1-27 (−)', l: 'plat' }),
        W(1, 'can', 'TAN/BLK · TAN', '', '', { quiet: true, a: 'tcm', b: 'bcm', mod: 'TCM', pin: 'TCM (قير 6 سرعات): X1-14 (+) · X1-13 (−)', l: 'plat' }),
        W(2, 'can', 'TAN/BLK · TAN', '', '', { quiet: true, a: 'bcm', b: 'dlc', mod: 'BCM', pin: 'BCM: X3-16 (+) · X3-17 (−) — فيش الفحص: 6 (+) · 14 (−)', l: 'plat' }),
        W(3, 'can', 'TAN/BLK · TAN', '', '', { quiet: true, a: 'dlc', b: 'tccm', mod: 'TCCM', pin: 'TCCM: X2-5 (+) · X2-4 (−)', l: 'plat' }),
        W(4, 'can', 'TAN/BLK · TAN', '', '', { quiet: true, a: 'tccm', b: 'ebcm', mod: 'EBCM', pin: 'EBCM: عبر الموصّل X115 (YEL/BLK · YEL في ضفيرة الشاصي)', l: 'plat' }),
        W(5, 'can', 'TAN/BLK · TAN', '', '', { quiet: true, a: 'ebcm', b: 'fpcm', mod: 'FPCM', pin: 'FPCM: زوج 2500/2501', l: 'plat' }),
        W(6, 'can', 'TAN/BLK · TAN', 'مقاومة الإنهاء ≈ 120Ω', 'افصلها وقِس بين طرفيها', { a: 'fpcm', b: 'dlr', pin: 'طرفا المقاومة: TAN/BLK 2500 و TAN 2501', l: 'plat' }),
      ], notes: [
        'القياس الأهم: افصل سالب البطارية وقِس بين طرف 6 وطرف 14 في فيش الفحص: 60Ω تقريبًا سليم · 120Ω مقاومة إنهاء مفصولة أو سلك مقطوع · قريب من صفر تماس بين السلكين.',
        'السلكان دائمًا: TAN/BLK (دائرة 2500) موجب، و TAN (دائرة 2501) سالب.',
        'ترتيب الكمبيوترات في الرسم للتوضيح؛ التوصيل الفعلي يمر بعلب الوصلات (Left I/P junction block) — شوف المخطط الأصلي.',
        'مقاومة الإنهاء الثانية اسمها في المخطط Data Link Resistor 1 (سيارات 2009 وأحدث).',
        'سلك الإيقاظ DK BLU (5985) من كمبيوتر الهيكل يصحّي كمبيوترات الشبكة؛ لو انقطع يسكت الكمبيوتر حتى لو أسلاك الشبكة سليمة.',
      ] }),
    lsgmlan: () => {
      const L = [['bcm', 'كمبيوتر الهيكل', 'BCM · طرف 10'], ['ipc', 'لوحة العدادات', 'IPC · طرف 6'], ['sdm', 'كمبيوتر الوسائد', 'SDM · تحت كرسي السائق'], ['pps', 'حساس راكب الكرسي', 'PPS · تحت كرسي الراكب']];
      const R = [['hvac', 'كمبيوتر المكيف', 'HVAC · طرف 5'], ['rdo', 'الراديو', 'طرف 13'], ['tdm', 'منع السرقة', 'TDM · على سويتش التشغيل'], ['vcim', 'OnStar', 'VCIM · X1-1']];
      const comps = [C('dlc', 'فيش الفحص طرف 1', 'DK GRN · 5060', 315, 170, 170, 80, 'dlc'), ...L.map(([id, l, s], k) => C(id, l, s, 20, 20 + k * 110, 170, 70)), ...R.map(([id, l, s], k) => C(id, l, s, 610, 20 + k * 110, 170, 70))];
      const MID = { bcm: 'BCM', ipc: 'IPC', sdm: 'SDM', hvac: 'HVAC', rdo: 'RADIO', tdm: 'TDM', vcim: 'VCIM' };
      const wires = [...L, ...R].map(([id], k) => W(k, 'can', 'DK GRN 5060', 'نبضات منخفضة الفولت والسيارة صاحية', 'فولت متوسط بين السلك والأرضي', { a: 'dlc', b: id, mod: MID[id], quiet: k > 0, pin: 'سلك واحد DK GRN · دائرة 5060 · يتوزّع من علب الوصلات (splice packs) خلف الطبلون', l: 'plat' }));
      return { title: 'شبكة LS-GMLAN البطيئة (سلك واحد على طرف 1)', src: 'data', comps, wires, notes: [
        'هذي الشبكة ما يوصلها محوّل ELM327 (يحتاج قطعة فيها SW-CAN مثل شريحة STN2120). التطبيق يعرف حالتها فقط من أكواد U اللي تسجّلها الكمبيوترات الثانية.',
        'لو سكتت كل كمبيوترات هذي الشبكة مرة وحدة: ابحث عن تماس السلك الأخضر مع الأرضي أو مع 12V — افصل الكمبيوترات واحد واحد حتى ترجع.',
        'كمبيوتر الهيكل هو البوابة: الأوامر بين الشبكتين تمر عليه.',
      ] };
    },
    charging: () => ({ title: 'دائرة الشحن والبطارية (نظام RVC)', pid: 0x42, src: 'charging', comps: [
      C('ecm', 'كمبيوتر المكينة', 'يتحكم بالدينمو', 20, 40, 170, 120, 'ecm'), C('alt', 'الدينمو', 'B+ · L · F', 610, 40, 170, 110),
      C('ipc', 'العدادات', 'رسالة الشحن', 610, 180, 170, 60), C('bat', 'البطارية', 'ميغا فيوز 175A على القطب +', 315, 300, 170, 70, 'batt'),
      C('bcm', 'كمبيوتر الهيكل', 'أسفل يسار الطبلون', 20, 300, 170, 90), C('cs', 'حساس تيار البطارية', 'على الكيبل السالب', 315, 440, 170, 70),
      C('g103', 'G103', 'مقدمة رأس السلندرات اليمين', 610, 300, 170, 60), C('g101', 'G101', 'أسفل يمين قاعدة الرديتر', 610, 440, 170, 60)],
      wires: [
        W(0, 'b+', 'B+ عبر ميغا فيوز 175A', 'RVC: 12.6–13.1V بدون أحمال، 13.9–14.5V تحت حِمل', 'فولت على أقطاب البطارية والمكينة شغالة', { a: 'alt', b: 'bat', vlive: true, pin: 'كيبل B+ من الدينمو إلى علبة الفيوز على القطب الموجب (Mega fuse 175A)' }),
        W(1, 'ctrl', 'Generator sig (L)', 'إشارة تشغيل الدينمو من الكمبيوتر', 'راسم إشارة على طرف L', { a: 'ecm', b: 'alt', pin: 'اسم الدائرة: Generator sig — طرف L في فيش الدينمو' }),
        W(2, 'sig', 'تغذية ECM · فيوز 12', 'نفس فولت البطارية (فرق أقل من 0.5V)', 'قارن فولت الكمبيوتر مع فولت القطعة', { a: 'bat', b: 'ecm', pid: 0x42, pin: 'ECM-BATT 12 (10A) + ECM-IGN 56 (15A)' }),
        W(3, 'gnd', 'سالب → المكينة G103', 'فرق أقل من 0.3V أثناء التدوير', 'فرق جهد بين سالب البطارية وجسم المكينة أثناء التدوير', { a: 'bat', b: 'g103', pin: 'الكيبل السالب إلى G103 (مقدمة رأس السلندرات اليمين)' + (v6 ? ' — 4.3: راجع G106' : '') }),
        W(4, 'sig', 'Gen FDC (F)', 'نسبة عمل الحقل تزيد مع الحِمل', 'راسم إشارة على طرف F', { a: 'alt', b: 'ecm', pin: 'اسم الدائرة: Gen FDC sig — طرف F في فيش الدينمو' }),
        W(5, 'sig', '5V · إشارة · أرضي', 'الإشارة تتغير مع تيار الشحن/التفريغ', 'فولت الإشارة عند فيش الحساس', { a: 'cs', b: 'bcm', pin: 'ثلاث دوائر: Current sply / Sens sig / Low ref — إلى كمبيوتر الهيكل' }),
        W(6, 'can', 'طلب الشحن', 'كمبيوتر الهيكل يطلب الفولت', '', { a: 'bcm', b: 'ecm', pin: 'رسالة على شبكة HS-GMLAN (2500/2501)' }),
        W(7, 'can', 'رسالة الشحن', '', '', { a: 'ecm', b: 'ipc', pin: 'Charge ind sig عبر الشبكة — فيوز IPC 46 (10A)' }),
        W(8, 'gnd', 'سالب → الهيكل G101', 'فرق أقل من 0.2V', 'فرق جهد بين سالب البطارية وجسم السيارة', { a: 'bat', b: 'g101', pin: 'الكيبل السالب إلى G101 (أسفل يمين قاعدة الرديتر)' }),
      ], notes: [
        'فولت 12.6–13.1V والمكينة شغالة بدون أحمال طبيعي في هذا النظام: الكمبيوتر يخفض الشحن لما البطارية مليانة. شغّل الأنوار العالية والمكيف والمروحة: لازم يرتفع إلى ~13.9–14.5V.',
        'حساس تيار البطارية على الكيبل السالب ويقرأه كمبيوتر الهيكل — المحوّل ما يقدر يقرأه مباشرة.',
        'بعد تبديل البطارية: الحساس لازم يكون على الكيبل السالب بنفس اتجاهه، وأي أرضي إضافي يتركّب بعد الحساس (جهة البطارية) يخرّب قراءته.',
        v6 ? 'مكينة 4.3: الحساس في يمين خلف غرفة المكينة.' : '',
      ].filter(Boolean) }),
    'mod:ECM': mod('ECM'), 'mod:TCM': mod('TCM'), 'mod:BCM': mod('BCM'), 'mod:EBCM': mod('EBCM'), 'mod:TCCM': mod('TCCM'), 'mod:FPCM': mod('FPCM'), 'mod:IPC': mod('IPC'),
    srs: () => ({ title: 'دائرة الوسائد الهوائية: التغذية والأرضي والإطلاق', src: 'srs', safety: true, comps: [
      C('ecm', 'كمبيوتر الوسائد SDM', 'تحت كرسي السائق', 20, 60, 170, 150, 'ecm'), C('f', 'فيوزات AIR BAG', 'BATT 45 (15A) · IGN 40 (10A)', 315, 10, 170, 70, 'fuse'),
      C('cs', 'الساعة الحلزونية / فيش المقعد', 'خلف الطارة · تحت الكراسي', 315, 140, 170, 70), C('c', 'الوسادة (Squib)', 'الطارة · الطبلون · السقف', 610, 140, 170, 70),
      C('g', 'أرضي G302 · G200', 'تحت كرسي الراكب · علبة المكيف', 315, 300, 170, 70), C('ls', 'شبكة LS-GMLAN', 'DK GRN 5060', 610, 10, 170, 60)],
      wires: [
        W(0, 'sig', 'دائرة الإطلاق (+)', 'لا تُقاس بالملتيميتر', '⚠ لا تقِس — خطر إطلاق', { a: 'ecm', b: 'cs', l: 'oem' }),
        W(1, 'sig', 'دائرة الإطلاق (−)', 'لا تُقاس', '⚠', { a: 'cs', b: 'c', l: 'oem' }),
        W(2, 'b+', 'تغذية دائمة + تشغيل', 'فولت البطارية عند الفيوزين', 'افحص الفيوزين بالمِلمس أو فولت طرفي الفيوز (بدون فصل فيش الكمبيوتر)', { a: 'f', b: 'ecm', pin: 'AIR BAG BATT 45 (15A) · AIR BAG IGN 40 (10A)' }),
        W(3, 'gnd', 'أرضي الكمبيوتر', 'نقطة الأرضي نظيفة ومشدودة', 'افحص النقطة بالنظر والشد — لا تقِس على أطراف الكمبيوتر', { a: 'ecm', b: 'g', pin: 'G302 (أسفل يمين كرسي الراكب) و G200 (يمين مقدمة علبة المكيف) حسب المخطط الأصلي' }),
        W(4, 'can', 'LS-GMLAN', '', '', { a: 'ecm', b: 'ls', pin: 'طرف 2 · DK GRN · 5060', l: 'plat' }),
      ], notes: [
        '⚠ لا تستخدم الملتيميتر على دوائر الوسائد — قد يطلقها التيار. استخدم أداة محاكاة (Simulator) فقط.',
        'افصل البطارية وانتظر المدة اللي يحددها المصنّع قبل فصل أي فيش أصفر.',
        'أشهر أسباب لمبة الوسادة في هذي الشاحنات: فيشات تحت الكراسي (حساس الحزام/الراكب) والساعة الحلزونية — كمبيوتر الوسائد على الشبكة البطيئة فالمحوّل ما يقرأ أكواده.',
      ] }),
    fuelpump: () => ({ title: 'نظام طرمبة البنزين (كمبيوتر FPCM)', src: 'engine', comps: [
      C('ecm', 'كمبيوتر المكينة', 'يطلب الضغط', 20, 40, 170, 100, 'ecm'), C('fpcm', 'كمبيوتر الطرمبة FPCM', 'الشاصي الخلفي قرب الاستبنة', 315, 40, 170, 110), C('c', 'طرمبة البنزين', 'داخل الخزان', 610, 40, 170, 90),
      C('ps', 'حساس ضغط خط البنزين', 'تحت يسار السيارة', 20, 240, 170, 70), C('f', 'فيوز FSCM 21 · 20A', 'علبة فيوزات المكينة', 315, 240, 170, 60, 'fuse'), C('g', 'G300', 'تحت باب السائق على قاعدة الجسم', 610, 240, 170, 60)],
      wires: [
        W(0, 'can', 'طلب الضغط (HS-GMLAN)', 'الكمبيوتر يرسل الضغط المطلوب', '', { a: 'ecm', b: 'fpcm', pin: 'زوج 2500/2501 + تفعيل الاتصال LT BLU 5986 (من كمبيوتر الهيكل)', l: 'plat' }),
        W(1, 'b+', 'Pump (+)', 'فولت متغير حسب الطلب (PWM)', 'فولت عند فيش الطرمبة أثناء التشغيل', { a: 'fpcm', b: 'c', pin: 'اسم الدائرة: Pump (+)' }),
        W(2, 'gnd', 'أرضي الطرمبة', 'أقل من 0.2V تحت حِمل', 'فرق جهد بين أرضي الطرمبة وسالب البطارية', { a: 'c', b: 'g', pin: 'إلى G300' }),
        W(3, 'sig', 'Fuel press', 'يتغير مع الضغط', 'فولت الإشارة', { a: 'ps', b: 'fpcm', pin: 'اسم الدائرة: Fuel press · مع 5V ref و Lo ref' }),
        W(4, 'b+', 'تغذية الكمبيوتر', 'فولت البطارية', 'فولت عند طرفي الفيوز', { a: 'f', b: 'fpcm', pin: 'FSCM 21 (20A) + تشغيل من ECM-IGN 56 (15A)' }),
      ], notes: ['ما فيه ريليه طرمبة تقليدي: لو الطرمبة ما تشتغل افحص فيوز FSCM 21، ثم أرضي G300، ثم هل كمبيوتر الطرمبة يرد في «خريطة الشبكة».'] }),
    ect: () => sensor({ title: 'حساس حرارة التبريد ECT', comp: 'حساس حرارة التبريد ECT', sub: 'أعلى المكينة', pid: 0x05, wires: [
      W(0, 'sig', 'ECT sig', 'بارد ≈ 3–4.5V، حار ≈ 0.4–1V', 'فولت بين الإشارة والأرضي والفيش موصول', { pid: 0x05, pin: 'ECT sig' }),
      W(1, 'gnd', 'Low ref', 'أقل من 0.1V', 'فرق الجهد بين السلك وسالب البطارية', { pin: 'Low ref (أرضي مرجعي من الكمبيوتر)' })], notes: ['القراءة −40°C = دائرة مفتوحة، وأعلى من 130°C على مكينة باردة = تماس مع الأرضي'] }),
    iat: () => sensor({ title: 'حساس حرارة الهواء IAT (داخل حساس MAF)', comp: 'حساس MAF/IAT', sub: 'يمين مقدمة غرفة المكينة', pid: 0x0f, wires: [
      W(0, 'sig', 'IAT sig', 'يتغير عكسيًا مع الحرارة', 'فولت الإشارة للأرضي', { pid: 0x0f, pin: 'IAT sig' }), W(1, 'gnd', 'Low ref', 'أقل من 0.1V', 'فرق جهد للسالب', { pin: 'Low ref' })], notes: ['−40°C = دائرة مفتوحة'] }),
    maf: () => sensor({ title: 'حساس تدفق الهواء MAF', comp: 'حساس MAF/IAT', sub: 'يمين مقدمة غرفة المكينة', pid: 0x10, wires: [
      W(0, 'b+', 'تغذية التشغيل (Ig1)', 'فولت البطارية مع السويتش ON', 'فولت للأرضي', { pin: 'Ig1 — من علبة فيوزات المكينة (شوف المخطط الأصلي ص3)', conf: 'est' }),
      W(1, 'sig', 'MAF sig (تردد)', 'يزيد مع الدوران', 'تردد الإشارة', { pid: 0x10, pin: 'MAF sig' }), W(2, 'gnd', 'Gnd', 'أقل من 0.1V', 'فرق جهد للسالب', { pin: 'Gnd' }),
      W(3, 'sig', 'IAT sig', 'يتغير مع حرارة الهواء', 'فولت', { pid: 0x0f, pin: 'IAT sig (نفس الحساس)' })] }),
    map: () => sensor({ title: 'حساس ضغط المنيفولد MAP', comp: 'حساس MAP', sub: 'أعلى المنيفولد', pid: 0x0b, wires: [
      W(0, 'ref5', '5V ref', '4.8–5.2V', 'فولت للأرضي', { pin: '5V ref' }), W(1, 'sig', 'MAP sig', 'خمول ≈ 1–1.5V، سويتش ON بدون تشغيل ≈ 4–4.7V', 'فولت الإشارة', { pid: 0x0b, pin: 'MAP sig' }), W(2, 'gnd', 'Low ref', 'أقل من 0.1V', 'فرق جهد', { pin: 'Low ref' })] }),
    tps: () => sensor({ title: 'الثروتل الإلكتروني (بوابة الهواء)', comp: 'الثروتل Throttle body', sub: 'أعلى مقدمة المكينة', pid: 0x11, wires: [
      W(0, 'ref5', '5V ref', '4.8–5.2V', 'فولت للأرضي والسويتش ON', { pin: '5V ref' }), W(1, 'sig', 'TP sens1 sig', 'يرتفع بسلاسة مع الدعس', 'فولت الإشارة أثناء تحريك الدعسة', { pid: 0x11, pin: 'TP sens1 sig' }),
      W(2, 'gnd', 'Low ref', 'أقل من 0.1V', 'فرق جهد للسالب', { pin: 'Low ref' }), W(3, 'sig', 'TP sens2 sig', 'عكس الحساس الأول (المجموع ثابت تقريبًا)', 'فولت الإشارة', { pin: 'TP sens2 sig' }),
      W(4, 'ctrl', 'Tac mtr ctrl 1', 'نبضات تحكم بالموتور', 'راسم إشارة', { pin: 'Tac mtr ctrl 1' }), W(5, 'ctrl', 'Tac mtr ctrl 2', 'نبضات تحكم بالموتور', 'راسم إشارة', { pin: 'Tac mtr ctrl 2' })],
      notes: ['دعسة البنزين حساس منفصل فوق الدعسة (App1 sig / App2 sig) بمرجعين 5V منفصلين.', 'فيوز ECM/THROT CONT 5 (15A).'] }),
    o2: () => sensor({ title: 'حساسات الأكسجين (4 حساسات)', comp: 'حساس الأكسجين', sub: 'قبل وبعد الدبتين (البنك 1 = اليسار)', pid: 0x14, wires: [
      W(0, 'b+', 'تغذية السخّان', 'فولت البطارية مع السويتش ON', 'فولت للأرضي', { pin: 'O2-A SNSR 18 (10A) · O2-B SNSR 8 (10A)', a: 'f', b: 'c' }),
      W(1, 'ctrl', 'HO2S htr', 'مقاومة السخّان عادة 3–15Ω', 'مقاومة بين طرفي السخّان والفيش مفصول', { pin: 'HO2S htr B1S1 / B2S1 / B1S2 / B2S2' }),
      W(2, 'sig', 'HO2S hi', 'تتذبذب 0.1–0.9V بسرعة والمكينة حارّة', 'فولت الإشارة', { pid: 0x14, pin: 'HO2S hi (إشارة)' }), W(3, 'gnd', 'HO2S lo', 'أقل من 0.1V', 'فرق جهد', { pin: 'HO2S lo (أرضي مرجعي)' })],
      extra: [C('f', 'فيوز O2-A 18 · O2-B 8', '10A · علبة فيوزات المكينة', 360, 10, 180, 50, 'fuse')], notes: ['B1S1 قبل الدبة اليسار · B2S1 قبل الدبة اليمين · B1S2 / B2S2 بعد الدبتين.'] }),
    ckp: () => sensor({ title: 'حساس عمود الكرنك CKP', comp: 'حساس الكرنك', sub: v6 ? 'مكينة 4.3' : 'يمين خلف المكينة', pid: 0x0c, wires: [
      W(0, 'ref5', '5V ref', '4.8–5.2V', 'فولت للأرضي', { pin: '5V ref' }), W(1, 'sig', 'CKP sig', 'نبضات أثناء التدوير', 'تردد أثناء التدوير', { pid: 0x0c, pin: 'CKP sig' }), W(2, 'gnd', 'Low ref', 'أقل من 0.1V', 'فرق جهد', { pin: 'Low ref' })], notes: ['إذا ما ظهر دوران (RPM) أثناء التدوير فالإشارة ما توصل'] }),
    cmp: () => sensor({ title: 'حساس عمود الكامات CMP', comp: 'حساس الكامات', sub: 'مقدمة المكينة فوق بكرة الكرنك', wires: [
      W(0, 'ref5', '5V ref', '4.8–5.2V', 'فولت للأرضي', { pin: '5V ref' }), W(1, 'sig', 'CMP sig', 'نبضات أثناء التشغيل', 'راسم إشارة', { pin: 'CMP sig' }), W(2, 'gnd', 'Low ref', 'أقل من 0.1V', 'فرق جهد', { pin: 'Low ref' })] }),
    knock: () => sensor({ title: 'حساسات الطَّرق (Knock)', comp: 'حساس الطَّرق 1 و 2', sub: '1: أسفل يسار المكينة · 2: أسفل يمين المكينة', wires: [
      W(0, 'sig', 'KS1 sig / KS2 sig', 'فولت متردد صغير أثناء التشغيل', 'راسم إشارة', { pin: 'KS1 sig · KS2 sig' }), W(1, 'gnd', 'Low ref', 'أقل من 0.1V', 'فرق جهد', { pin: 'Low ref' })], notes: ['في مكائن LS الحساسات تحت المنيفولد ويوصلها الماء والتآكل'] }),
    injector: () => sensor({ title: 'دائرة البخاخات', comp: v6 ? 'البخاخات (6)' : 'البخاخات (8)', sub: 'أعلى بنكي السلندرات', wires: [
      W(0, 'b+', 'تغذية 12V', 'فولت البطارية مع السويتش ON', 'فولت للأرضي', { pin: v6 ? 'INJ-A 24 (20A)' : 'INJ-A 24 (20A) · INJ-B 13 (20A)', a: 'f', b: 'c' }),
      W(1, 'ctrl', 'Inj 1–8 ctrl', 'مقاومة البخاخ عادة 11–18Ω', 'مقاومة البخاخ والفيش مفصول / لمبة اختبار نبضات', { pin: 'Inj 1 ctrl … Inj 8 ctrl (سلك لكل بخاخ)' })],
      extra: [C('f', v6 ? 'فيوز INJ-A 24' : 'فيوز INJ-A 24 · INJ-B 13', '20A · علبة فيوزات المكينة', 360, 10, 180, 50, 'fuse')] }),
    coil: () => v6 ? sensor({ title: 'دائرة الإشعال (4.3: موزّع + وحدة ICM)', comp: 'وحدة الإشعال ICM + الكويل', sub: 'مكينة 4.3 بموزّع (Distributor)', wires: [
      W(0, 'b+', 'تغذية 12V', 'فولت البطارية مع السويتش ON', 'فولت للأرضي', { pin: 'Ign' }), W(1, 'gnd', 'أرضي', 'أقل من 0.1V', 'فرق جهد', { pin: 'G106 / G107' }),
      W(2, 'ctrl', 'إشارة التوقيت من الكمبيوتر', 'نبضات أثناء التشغيل', 'راسم إشارة', { pin: 'من ECM إلى ICM' })], notes: ['مكينة 4.3 فيها كويل واحد وموزّع — مو كويل لكل سلندر.'] })
      : sensor({ title: 'دائرة الكويلات (كويل لكل سلندر)', comp: 'الكويلات 1–8', sub: 'أعلى جانبي المكينة', wires: [
        W(0, 'b+', 'تغذية التشغيل', 'فولت البطارية مع السويتش ON', 'فولت للأرضي', { pin: 'Ign (PNK)' }), W(1, 'gnd', 'أرضي قدرة', 'أقل من 0.1V', 'فرق جهد للسالب أثناء التشغيل', { pin: 'إلى G102 (أسفل يسار مقدمة المكينة)' }),
        W(2, 'ctrl', 'IC 1–8 ctrl', 'نبضات أثناء التشغيل', 'راسم إشارة / لمبة LED', { pin: 'IC 1 ctrl … IC 8 ctrl' }), W(3, 'gnd', 'Low ref', 'أقل من 0.1V', 'فرق جهد', { pin: 'Lo ref' })],
        notes: ['أفضل اختبار عملي: بدّل الكويل مع سلندر سليم وراقب انتقال العطل'] }),
    evap: () => sensor({ title: 'صمامات بخار الوقود EVAP', comp: 'صمام التنقية (Purge)', sub: 'على المنيفولد', pid: 0x2e, wires: [
      W(0, 'b+', 'تغذية 12V', 'فولت البطارية', 'فولت للأرضي', { pin: 'Ign' }), W(1, 'ctrl', 'Sol ctrl', 'نسبة التشغيل = قيمة التنقية المطلوبة', 'راسم إشارة', { pid: 0x2e, pin: 'Purge sol ctrl' })],
      notes: ['صمام التهوية (Vent) تحت مؤخرة السيارة، وحساس ضغط الخزان FTP على الخزان.'] }),
    vvt: () => sensor({ title: 'صولونويد الكامات (VVT)', comp: 'صولونويد الكامات', sub: 'مقدمة المكينة (6.2)', wires: [
      W(0, 'ctrl', 'Cam sol ctrl', 'مقاومة عادة 7–12Ω', 'مقاومة الصولونويد', { pin: 'Cam sol ctrl' }), W(1, 'gnd', 'Low ref', 'أقل من 0.1V', 'فرق جهد', { pin: 'Low ref' })], notes: sixTwoNote(plat) }),
  };
}
// A power/ground/network sheet for one computer, built from its data.
function moduleCircuit(m, plat) {
  const fs = m.fuses.slice(0, 3), gs = moduleGrounds(m, plat);
  const net = m.pins.filter(p => /GMLAN/.test(p[1])), wake = m.pins.find(p => /إيقاظ|تفعيل/.test(p[1]));
  const hs = net.filter(p => /HS/.test(p[1]));
  // one row per wire: everything sits in the right column, each wire runs straight to the computer
  const rows = [];
  fs.forEach((n, k) => rows.push({ comp: C('f' + k, `فيوز ${fuse(n)?.name || n} ${n}`, `${fuse(n)?.a || ''}A · ${fuse(n)?.where === IP ? 'علبة فيوزات الطبلون' : 'علبة فيوزات المكينة'}`, 0, 0, 0, 0, 'fuse'),
    wire: W(0, 'b+', `${fuse(n)?.name || n} ${n}`, 'فولت البطارية عند طرفي الفيوز', 'فولت بين طرفي الفيوز والأرضي (الفيوز في مكانه)', { pin: `${fuseTxt(n)} — ${fuse(n)?.feeds || ''}`, l: fuse(n)?.l || 'oem', fuse: n }) }));
  rows.push({ comp: C('net', m.net.includes('HS') ? 'شبكة HS-GMLAN' : 'شبكة LS-GMLAN', m.net.includes('+') ? m.net : (m.net === 'HS' ? 'السريعة · 2500/2501' : 'البطيئة · طرف 1'), 0, 0, 0, 0),
    wire: W(0, 'can', (hs.length ? hs : net).map(p => p[0]).join(' · ') || 'الشبكة', m.net.includes('HS') ? 'مقاومة 6↔14 ≈ 60Ω' : 'نبضات منخفضة الفولت', 'افصل البطارية وقِس بين طرف 6 و14 في فيش الفحص', { pin: net.map(p => `${p[0]}: ${p[1]} · ${p[2]} · ${p[3]}`).join(' — ') + (m.pinNote ? ` (${m.pinNote})` : ''), l: 'plat', mod: m.id }) });
  if (wake) rows.push({ comp: C('wk', wake[1].split(' (')[0], `${wake[2]} · دائرة ${wake[3]}`, 0, 0, 0, 0),
    wire: W(0, 'ctrl', wake[0], 'فولت البطارية والسويتش ON', 'فولت بين السلك والأرضي', { pin: `${wake[0]} · ${wake[1]} · ${wake[2]} · دائرة ${wake[3]}`, l: 'plat' }) });
  rows.push({ comp: C('g', gs.length ? gs.join(' · ') : 'الأرضي', gs.length ? (gnd(gs[0])?.loc || '') : 'من المخطط الأصلي', 0, 0, 0, 0),
    wire: W(0, 'gnd', gs.length ? gs.join(' · ') : 'الأرضي', 'فرق أقل من 0.1V مع سالب البطارية', 'فرق جهد بين أرضي الكمبيوتر وسالب البطارية والسويتش ON', { pin: gs.length ? gs.map(gndTxt).join(' — ') : (m.gtext || 'نقطة الأرضي في صفحة المخطط الأصلي'), l: gs.length ? 'oem' : 'est' }) });
  const P = 84;
  const comps = [C('m', m.ar, m.loc.length > 34 ? m.id : m.loc, 20, 20, 200, rows.length * P - 24, 'ecm'),
    ...rows.map((r, k) => ({ ...r.comp, x: 580, y: 20 + k * P, w: 200, h: 60 }))];
  const wires = rows.map((r, k) => ({ ...r.wire, i: k, a: 'm', b: r.comp.id, y: 20 + k * P + 34 }));
  return { title: `${m.ar}: التغذية والأرضي والشبكة`, src: m.src, mod: m.id, comps, wires, notes: [
    `المكان: ${m.loc}`, m.note || '', gs.length ? '' : (m.gtext || ''),
    'إذا الكمبيوتر ما يرد: افحص بالترتيب الفيوزات (والسويتش ON) ← الأرضي ← سلك الإيقاظ ← سلكي الشبكة عند فيشه.',
  ].filter(Boolean) };
}
export const GM_LIST = plat => ['dlc', 'canbus', 'lsgmlan', 'charging', 'mod:ECM', 'mod:TCM', 'mod:BCM', 'mod:EBCM', 'mod:TCCM', 'mod:FPCM', 'mod:IPC', 'srs', 'fuelpump', 'ect', 'iat', 'maf', 'map', 'tps', 'o2', 'ckp', 'cmp', 'knock', 'injector', 'coil', 'evap', ...(plat.v6 ? [] : ['vvt']), 'ref5', 'lean'];

// Which sheet answers a code on these trucks
const U_MOD = { U0100: 'mod:ECM', U0101: 'mod:TCM', U0121: 'mod:EBCM', U0129: 'mod:EBCM', U0140: 'mod:BCM', U0151: 'srs', U0155: 'mod:IPC', U0164: 'lsgmlan', U0168: 'lsgmlan', U0073: 'canbus', U0001: 'canbus' };
export function gmCircuitFor(code) {
  const n = /^P\d{4}$/.test(code) ? parseInt(code.slice(1), 10) : -1;
  if (U_MOD[code]) return U_MOD[code];
  if (code[0] === 'U') return 'canbus';
  if (code[0] === 'C') return 'mod:EBCM';
  if (code[0] === 'B' && /^B0/.test(code)) return 'srs';
  if ([562, 563, 621, 622, 2500, 2501].includes(n)) return 'charging';
  if ((n >= 700 && n <= 799) || (n >= 1700 && n <= 1799) || (n >= 2700 && n <= 2799)) return 'mod:TCM';
  if ([601, 602, 603, 604, 605, 606].includes(n)) return 'mod:ECM';
  if ([230, 627, 628, 629].includes(n)) return 'fuelpump';
  return circuitFor(code);
}
// Which module (data) a scanned computer is.
export function moduleOf(e) {
  if (!e) return null;
  if (e.std && /7E8|7E0/i.test(String(e.ecu || e.addr || ''))) return MODULES[0];
  if (e.std && /7EA|7E2/i.test(String(e.ecu || e.addr || ''))) return MODULES[1]; // GM: TCM answers 7E2 → 7EA
  if (e.std && /7EB|7E3/i.test(String(e.ecu || e.addr || ''))) return MODULES.find(m => m.id === 'FPCM');
  return MODULES.find(m => m.match.test(e.name || '')) || null;
}

// Where does the chain break? From what answered on the network (and the adapter voltage).
export function gmChecks(id, cir, { ecus = [], volt = null, connected = false, codes = [] } = {}) {
  const r = [];
  const state = mid => {
    const m = MODULES.find(x => x.id === mid); if (!m) return null;
    const hits = ecus.filter(e => moduleOf(e) === m);
    if (hits.some(e => !e.ghost && e.status !== 'unreach' && e.status !== 'noresp')) return 'ok';
    if (hits.some(e => e.ghost)) return 'lost';
    return null;
  };
  if (id === 'dlc' && connected) {
    r.push({ wire: 1, st: volt && volt >= 11.5 ? 'ok' : 'warn', t: `القطعة شغالة: طرف 16 والأرضي سليمين${volt ? ` — الفولت عند الفيش ${volt.toFixed(2)}V` : ''}` });
    r.push({ wire: 4, st: ecus.some(e => e.std) ? 'ok' : 'warn', t: ecus.some(e => e.std) ? 'كمبيوترات الشبكة السريعة ترد على طرف 6/14' : 'ما ردّ أي كمبيوتر بعد على طرف 6/14' });
  }
  if (id === 'canbus' || id === 'lsgmlan' || id.startsWith('mod:')) {
    cir.wires.forEach((w, k) => {
      if (!w.mod) return;
      const s = state(w.mod); const m = MODULES.find(x => x.id === w.mod);
      if (s === 'ok') r.push({ wire: k, st: 'ok', t: `${m.ar}: يرد على الشبكة` });
      else if (s === 'lost') r.push({ wire: k, st: 'bad', t: `${m.ar}: مفقود — كمبيوتر آخر سجّل كود فقد اتصال. ابدأ بفيوزاته وأرضيه${m.fuses.length ? ` (${m.fuses.map(fuseTxt).join('، ')})` : ''}` });
    });
    if (id === 'lsgmlan') {
      const lost = codes.filter(c => ['U0151', 'U0155', 'U0164', 'U0168'].includes(c));
      const MID = { U0151: 'SDM', U0155: 'IPC', U0164: 'HVAC', U0168: 'TDM' };
      for (const c of lost) { const k = cir.wires.findIndex(w => w.mod === MID[c]); if (k >= 0 && !r.some(x => x.wire === k)) r.push({ wire: k, st: 'bad', t: `${MODULES.find(m => m.id === MID[c]).ar}: الكود ${c} (فقد اتصال)` }); }
    }
  }
  return r;
}
