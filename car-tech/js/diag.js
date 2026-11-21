// Guided diagnosis: correlates codes + live data into ranked root causes with evidence,
// guided steps and measurement points. Plus the circuit-diagram library (extensible).
import { describeDtc } from './dtcdb.js';

const has = (codes, re) => codes.filter(c => re.test(c));
const list = a => a.join('، ');

// Fuel-trim analysis from samples [{rpm, stft1, ltft1, stft2, ltft2, maf, load}]
export function trimAnalysis(samples) {
  const ok = samples.filter(s => s.rpm > 400 && s.ltft1 != null);
  if (ok.length < 5) return null;
  const tot = (s, b) => (s['stft' + b] || 0) + (s['ltft' + b] || 0);
  const idle = ok.filter(s => s.rpm < 1000), cruise = ok.filter(s => s.rpm > 1700);
  const avg = (arr, b) => arr.length ? arr.reduce((a, s) => a + tot(s, b), 0) / arr.length : null;
  const r = { n: ok.length, idle1: avg(idle, 1), idle2: avg(idle, 2), cruise1: avg(cruise, 1), cruise2: avg(cruise, 2), all1: avg(ok, 1), all2: avg(ok, 2) };
  r.hasBank2 = ok.some(s => s.ltft2 != null && s.ltft2 !== 0);
  if (r.idle1 != null && r.cruise1 != null) {
    const d = r.idle1 - r.cruise1;
    r.pattern = d > 5 ? 'vacuum' : d < -5 ? 'delivery' : 'flat';
  }
  return r;
}

// ctx: {dtcs:[{code, module, kind}], live:{pid:value}, volt, running, trims, mode06:[rows], displacement}
export function correlate(ctx) {
  const codes = [...new Set(ctx.dtcs.map(d => d.code))];
  const out = [];
  const add = (o) => out.push({ conf: 'est', steps: [], evidence: [], ...o });
  const lean = has(codes, /^P017[14]$/), rich = has(codes, /^P017[25]$/), mis = has(codes, /^P03(0\d|1[0-2])$/);
  const t = ctx.trims;

  if (lean.length) {
    const both = lean.length === 2;
    const ev = [`أكواد: ${list(lean)}`];
    let pVac = 0.45, pMaf = 0.25, pFuel = 0.2, pEx = 0.1;
    if (t?.pattern === 'vacuum') { pVac += 0.25; pMaf -= 0.1; pFuel -= 0.1; ev.push(`الخلطة فقيرة على الخمول (${t.idle1.toFixed(1)}%) وتتحسن على الدوران العالي (${t.cruise1.toFixed(1)}%) — بصمة تسريب هواء`); }
    if (t?.pattern === 'delivery') { pFuel += 0.2; pMaf += 0.1; pVac -= 0.25; ev.push(`الخلطة تزداد فقرًا مع الحِمل (${t.cruise1.toFixed(1)}%) — بصمة ضعف وقود أو MAF`); }
    if (has(codes, /^P010[0-4]$/).length) { pMaf += 0.3; ev.push('يوجد كود لحساس MAF'); }
    if (mis.length) ev.push('يوجد احتراق ناقص — الخلطة الفقيرة قد تسبّبه');
    if (ctx.live?.[0x10] != null && ctx.running && ctx.live[0x0c] < 1000 && ctx.displacement) {
      const exp = ctx.displacement * 0.85;
      if (ctx.live[0x10] < exp * 0.7) { pMaf += 0.15; ev.push(`قراءة MAF على الخمول ${ctx.live[0x10].toFixed(1)} g/s أقل من المتوقع (~${exp.toFixed(1)}) — تقديري`); }
    }
    const n = pVac + pMaf + pFuel + pEx;
    add({
      title: both ? 'خلطة فقيرة في البنكين — سبب مشترك' : `خلطة فقيرة في ${lean[0] === 'P0171' ? 'بنك1' : 'بنك2'} فقط — سبب في جهة واحدة`,
      codes: lean.concat(mis), circuit: 'lean', score: 0.9,
      causes: both ? [
        { t: 'تسريب هواء بعد حساس MAF (خراطيم، PCV، جوان المنيفولد، بوستر الفرامل)', p: pVac / n },
        { t: 'حساس MAF متّسخ أو يقرأ أقل من الواقع', p: pMaf / n },
        { t: 'ضغط وقود ضعيف (طرمبة/فلتر/منظّم)', p: pFuel / n },
        { t: 'تسريب عادم قبل حساس الأكسجين', p: pEx / n },
      ] : [
        { t: 'تسريب هواء في جهة البنك المتأثر (جوان المنيفولد لتلك الجهة)', p: 0.55 },
        { t: 'بخاخ ضعيف/مسدود في ذلك البنك', p: 0.25 },
        { t: 'حساس الأكسجين الأمامي لذلك البنك يقرأ خطأ', p: 0.2 },
      ],
      evidence: ev,
      steps: [
        { t: 'سجّل البيانات الحية على الخمول ثم على 2500 دورة لمدة دقيقة (من «مسجّل المشوار → اختبار خلطة الوقود»)', m: 'تعديل الوقود قصير+طويل لكل بنك', e: 'المجموع بين −10% و +10%' },
        { t: 'افحص التسريب: رشّ ماء/منظّف حول المنيفولد والخراطيم والمكينة شغالة', m: 'تعديل الوقود القصير', e: 'إذا نزل فجأة عند نقطة معيّنة فهنا التسريب' },
        { t: 'قارن قراءة MAF على الخمول مع حجم المكينة', m: 'MAF (g/s)', e: 'تقريبًا 0.7–1.0 × حجم المكينة باللتر (تقديري)' },
        { t: 'قِس ضغط الوقود بساعة ضغط على سكة الوقود', m: 'ضغط الوقود', e: 'حسب مواصفة المصنّع (غالبًا 380–420 kPa لأنظمة الحقن المنفذي — تقديري)' },
      ],
    });
  }
  if (rich.length) add({
    title: 'خلطة غنية (وقود زائد)', codes: rich, circuit: 'lean', score: 0.85,
    causes: [{ t: 'بخاخ يسرّب', p: 0.3 }, { t: 'ضغط وقود مرتفع (منظّم)', p: 0.25 }, { t: 'صمام تنقية EVAP عالق مفتوح', p: 0.2 }, { t: 'حساس MAF يقرأ أعلى من الواقع', p: 0.25 }],
    evidence: [`أكواد: ${list(rich)}`].concat(has(codes, /^P0496$/).length ? ['P0496 موجود: تنقية EVAP بدون طلب — يرجّح صمام التنقية'] : []),
    steps: [{ t: 'افصل خرطوم التنقية EVAP وراقب التعديل القصير', m: 'STFT', e: 'إذا رجع للطبيعي فالصمام هو السبب' }, { t: 'قِس ضغط الوقود وثباته بعد الإطفاء', m: 'ضغط الوقود', e: 'لا ينزل بسرعة بعد الإطفاء' }],
  });
  if (mis.length) {
    const cyl = mis.filter(c => c !== 'P0300').map(c => +c.slice(3));
    const m06 = (ctx.mode06 || []).filter(r => r.mid >= 0xa2 && r.mid <= 0xad && r.tid === 0x0c && r.value > 0);
    const ev = [`أكواد: ${list(mis)}`];
    if (m06.length) ev.push('عدّادات الاحتراق الناقص (Mode 6): ' + m06.map(r => `س${r.mid - 0xa1}=${r.value}`).join('، '));
    const worst = m06.sort((a, b) => b.value - a.value).slice(0, 2).map(r => r.mid - 0xa1);
    add({
      title: cyl.length === 1 ? `احتراق ناقص في سلندر ${cyl[0]}` : 'احتراق ناقص في أكثر من سلندر',
      codes: mis, circuit: 'coil', score: 0.8, evidence: ev,
      causes: cyl.length === 1 || (worst.length && m06.length <= 2) ? [{ t: `الكويل أو البوجي في سلندر ${cyl[0] || worst[0]}`, p: 0.55 }, { t: 'البخاخ لنفس السلندر', p: 0.25 }, { t: 'ضغط السلندر (بلوف/جوان)', p: 0.2 }]
        : [{ t: lean.length ? 'الخلطة الفقيرة (راجع بند الخلطة الفقيرة)' : 'سبب مشترك: وقود أو إشعال عام', p: lean.length ? 0.55 : 0.4 }, { t: 'بوجيات/كويلات متعددة', p: 0.3 }, { t: 'مشكلة ميكانيكية (توقيت/ضغط)', p: 0.15 }],
      steps: [
        { t: 'بدّل الكويل بين السلندر المتأثر وسلندر سليم، امسح، وسوق', m: 'عدّاد الاحتراق الناقص (Mode 6) لكل سلندر', e: 'إذا انتقل العطل مع الكويل فهو السبب' },
        { t: 'افحص البوجي (لون، مسافة، تشقّق)', m: 'مسافة البوجي', e: 'حسب مواصفة المصنّع' },
        { t: 'اختبار ضغط السلندر', m: 'ضغط', e: 'الفرق بين السلندرات أقل من 10–15% (قاعدة عامة)' },
      ],
    });
  }
  const ucodes = has(codes, /^U0[0-3]/);
  if (ucodes.length) add({
    title: ucodes.length > 1 ? 'مشاكل اتصال بين عدة كمبيوترات' : 'فقد اتصال بكمبيوتر', codes: ucodes, circuit: 'canbus', score: 0.75,
    causes: ucodes.length > 1 ? [{ t: 'خلل في أسلاك شبكة CAN أو مقاومة الإنهاء', p: 0.4 }, { t: 'ضعف البطارية/التغذية أثناء التشغيل', p: 0.35 }, { t: 'كمبيوتر واحد يشوّش الشبكة', p: 0.25 }] : [{ t: 'تغذية أو أرضي الكمبيوتر المفقود', p: 0.5 }, { t: 'سلك/فيش الشبكة لذلك الكمبيوتر', p: 0.3 }, { t: 'الكمبيوتر نفسه', p: 0.2 }],
    evidence: [`أكواد: ${list(ucodes)}`].concat(ctx.volt && ctx.volt < 12.2 ? [`فولت البطارية منخفض الآن (${ctx.volt.toFixed(1)}V)`] : []),
    steps: [
      { t: 'والسويتش مطفأ والبطارية مفصولة: قِس المقاومة بين طرفي فيش الفحص 6 و14', m: 'مقاومة CAN', e: '≈ 60Ω (مقاومتان 120Ω على التوازي). 120Ω = إنهاء مفقود، أقل من 50Ω = تماس' },
      { t: 'قِس فولت CAN مع السويتش ON', m: 'طرف 6 (CAN-H) وطرف 14 (CAN-L) للأرضي', e: '≈ 2.5–3.5V و 1.5–2.5V' },
      { t: 'افحص التغذية والأرضي للكمبيوتر المفقود', m: 'فولت التغذية تحت حِمل', e: 'نفس فولت البطارية تقريبًا (فرق أقل من 0.3V)' },
    ],
  });
  const lowV = has(codes, /^P056[02]$|^P062[0-2]$/);
  const vNow = ctx.volt;
  // charging target depends on the car: GM RVC keeps it at 12.6–13.1V on purpose with a charged battery
  const cr = ctx.charge || { ok: [13.5, 14.8], rvc: false };
  const lowRun = cr.rvc ? cr.ok[0] : 13.2;
  if (lowV.length || (vNow && ((ctx.running && vNow < lowRun) || (!ctx.running && vNow < 12.2)))) add({
    title: 'نظام الشحن أو البطارية', codes: lowV, circuit: 'charging', score: 0.7,
    causes: [{ t: ctx.running ? 'الدينمو لا يشحن كفاية' : 'بطارية ضعيفة', p: 0.5 }, { t: 'أطراف/أرضي متأكسد أو مرتخي', p: 0.3 }, { t: 'سحب كهربائي أثناء الإطفاء', p: 0.2 }],
    evidence: lowV.map(c => `كود ${c}`).concat(vNow ? [`الفولت الآن ${vNow.toFixed(2)}V (${ctx.running ? 'المكينة شغالة' : 'المكينة طافية'})`] : []).concat(cr.rvc ? [cr.note] : []),
    steps: [{ t: 'نفّذ «اختبار التشغيل Cranking» و«اختبار الشحن» من مسجّل المشوار', m: 'فولت البطارية', e: `طافية 12.4–12.7V، أقل فولت أثناء التدوير > 9.6V، شغالة ${cr.ok[0]}–${cr.ok[1]}V${cr.rvc ? ' (ومع الأحمال يرتفع ~13.9–14.5V)' : ''}` }, { t: 'قِس فرق الجهد بين سالب البطارية وجسم المكينة أثناء التدوير', m: 'فرق جهد الأرضي', e: 'أقل من 0.3V' }],
  });
  const ref5 = has(codes, /^P0641|^P0651|^P0697|^P06A6/);
  // sensors fed by a 5V reference (thermistors like ECT/IAT are not: their "low" is a short to ground)
  const lowIn = has(codes, /^P0(107|122|222|452|462|522|532|192|342|337)$/);
  if (ref5.length || lowIn.length >= 2) add({
    title: 'عدة حساسات تشترك في مرجع 5 فولت', codes: ref5.concat(lowIn), circuit: 'ref5', score: 0.8,
    causes: [{ t: 'تماس في سلك 5V المرجعي في أحد الحساسات المشتركة', p: 0.6 }, { t: 'حساس واحد تالف يسحب المرجع', p: 0.3 }, { t: 'الكمبيوتر', p: 0.1 }],
    evidence: [`أكواد مرتبطة: ${list(ref5.concat(lowIn))}`, 'عدة أكواد «دخل منخفض» معًا نادرًا ما تكون حساسات متعددة تالفة'],
    steps: [{ t: 'قِس 5V المرجعي في فيش أي حساس من المجموعة', m: 'سلك 5V المرجعي للأرضي', e: '4.8–5.2V' }, { t: 'افصل الحساسات واحدًا واحدًا وراقب رجوع الـ5V', m: '5V المرجعي', e: 'الحساس الذي يُرجع الفولت عند فصله هو المتسبّب' }],
  });
  const cat = has(codes, /^P04[23][0-9]$/);
  if (cat.length) {
    const others = codes.filter(c => /^P0(1[3-6]|17|30|31)/.test(c));
    add({
      title: 'كفاءة الحفاز (الدبّة)', codes: cat, circuit: 'o2', score: others.length ? 0.5 : 0.65,
      causes: others.length ? [{ t: 'أعطال أخرى (خلطة/احتراق/حساس O2) تؤثر على الحفاز — أصلحها أولًا', p: 0.6 }, { t: 'الحفاز نفسه', p: 0.4 }] : [{ t: 'الحفاز ضعيف', p: 0.55 }, { t: 'حساس الأكسجين الخلفي', p: 0.25 }, { t: 'تسريب عادم', p: 0.2 }],
      evidence: [`أكواد: ${list(cat)}`].concat(others.length ? [`أكواد مسبّبة محتملة: ${list(others)}`] : []).concat((ctx.mode06 || []).filter(r => r.mid >= 0x21 && r.mid <= 0x24).map(r => { const f = v => (v == null ? '—' : Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0)); return `اختبار الدبة الذاتي (Mode 6) ${r.midName}: ${f(r.value)} والحد ${f(r.min)}–${f(r.max)} ← ${r.pass ? 'ناجح' : 'راسب'}`; })),
      steps: [{ t: 'راقب الحساس الخلفي والمكينة حارّة', m: 'فولت O2 بعد الحفاز', e: 'ثابت تقريبًا (0.5–0.8V). إذا يتذبذب مثل الأمامي فالحفاز ضعيف' }],
    });
  }
  if (has(codes, /^P0128$/).length) add({
    title: 'الثرموستات عالق مفتوح غالبًا', codes: ['P0128'], circuit: 'ect', score: 0.8,
    causes: [{ t: 'ثرموستات عالق مفتوح', p: 0.7 }, { t: 'حساس حرارة التبريد', p: 0.2 }, { t: 'مروحة تعمل باستمرار', p: 0.1 }],
    evidence: ['P0128'].concat(ctx.live?.[0x05] != null ? [`حرارة التبريد الآن ${ctx.live[0x05].toFixed(0)}°C`] : []),
    steps: [{ t: 'راقب حرارة التبريد من تشغيل بارد', m: 'ECT', e: 'تصل 85–100°C خلال 10–15 دقيقة قيادة' }],
  });
  const evap = has(codes, /^P04(4[0-9]|5[0-9])$/);
  if (evap.length) add({
    title: 'نظام بخار الوقود EVAP', codes: evap, circuit: 'evap', score: 0.6,
    causes: [{ t: 'غطاء خزان الوقود غير محكم/تالف', p: has(codes, /^P04(55|57)$/).length ? 0.45 : 0.3 }, { t: 'صمام التهوية (Vent)', p: 0.3 }, { t: 'صمام التنقية (Purge)', p: 0.2 }, { t: 'تسريب في الخراطيم/علبة الفحم', p: 0.2 }],
    evidence: [`أكواد: ${list(evap)}`],
    steps: [{ t: 'افحص غطاء الخزان وجوانه', m: 'نظري', e: 'جوان سليم ويقفل بصوت طقطقة' }, { t: 'اختبار دخان لنظام EVAP', m: 'دخان', e: 'لا يخرج دخان' }],
  });
  const srs = has(codes, /^B00/);
  if (srs.length) add({
    title: 'نظام الوسائد الهوائية (SRS)', codes: srs, circuit: 'srs', score: 0.7, safety: true,
    causes: [{ t: 'فيش/سلك تحت المقاعد أو في دائرة الإطلاق', p: 0.45 }, { t: 'الساعة الحلزونية (Clock Spring) في الدركسون', p: 0.3 }, { t: 'حساس/وسادة/كمبيوتر SRS', p: 0.25 }],
    evidence: [`أكواد: ${list(srs)}`],
    steps: [{ t: 'افصل البطارية وانتظر المدة التي يحددها المصنّع قبل لمس أي فيش SRS', m: '—', e: 'لا تقِس مقاومة الوسادة بالملتيميتر أبدًا' }, { t: 'افحص الفيشات تحت المقاعد (مقعد مرتخٍ أو مسحوب)', m: 'نظري', e: 'مثبّتة وغير متأكسدة' }],
  });
  const tm = has(codes, /^P0016|^P0017|^P0018|^P0019|^P001[0-4]|^P002[0-4]/);
  if (tm.length) add({
    title: 'توقيت/تنظيم عمود الكامات', codes: tm, circuit: 'vvt', score: 0.7,
    causes: [{ t: 'مستوى/نوع/لزوجة الزيت', p: 0.3 }, { t: 'صولونويد التحكم بالكامات', p: 0.3 }, { t: 'تمدد سلسلة التوقيت أو تلف المنظّم', p: 0.4 }],
    evidence: [`أكواد: ${list(tm)}`], steps: [{ t: 'افحص مستوى الزيت وحالته أولًا', m: 'عصا الزيت', e: 'ضمن الحد ونظيف' }],
  });
  // Cylinder deactivation (SAE P3400–P3496: AFM / DOD / MDS…). Solenoids worked by engine oil
  // pressure and switched by the engine computer; the computer only tests them if its calibration
  // says the engine has them.
  const cyl = has(codes, /^P34(0\d|[1-8]\d|9[0-6])$/);
  if (cyl.length) add({
    title: 'نظام إيقاف السلندرات لتوفير الوقود (AFM/DOD)', codes: cyl, score: 0.6,
    causes: [
      { t: 'فيش أو سلك مفتوح/متآكل في دائرة صولونويد إيقاف السلندر', p: 0.35 },
      { t: 'برمجة الكمبيوتر ما زالت تتوقع النظام بعد إزالته أو بعد تبديل المكينة بمكينة لا تحتويه', p: 0.25 },
      { t: 'الصولونويد نفسه', p: 0.2 },
      { t: 'مستوى أو ضغط الزيت (النظام يشتغل بضغط الزيت)', p: 0.2 },
    ],
    evidence: [`أكواد: ${list(cyl)}`].concat(cyl.length > 1 ? ['أكثر من سلندر معًا: يرجّح سببًا مشتركًا (التغذية/الفيش/البرمجة) أكثر من صولونويد واحد'] : []),
    steps: [
      { t: 'تأكد هل المكينة الحالية فيها نظام إيقاف السلندرات أصلًا', m: 'مواصفات المكينة / وجود مجموعة الصولونويدات', e: 'إذا غير موجود: لازم يكون النظام مطفأ في برمجة الكمبيوتر' },
      { t: 'افحص فيش مجموعة الصولونويدات والأسلاك', m: 'تغذية 12V مع السويتش ON + سلك التحكم لكل صولونويد', e: 'التغذية = فولت البطارية، وسلك التحكم متصل بدون قطع' },
      { t: 'افحص مستوى الزيت وضغطه', m: 'عصا الزيت / حساس الضغط', e: 'ضمن الحد' },
    ],
  });
  // Any code left uncovered → individual entry
  const covered = new Set(out.flatMap(o => o.codes));
  for (const c of codes.filter(c => !covered.has(c))) {
    const d = describeDtc(c);
    add({ title: `${c}: ${d.text}`, codes: [c], circuit: circuitFor(c), score: 0.4, conf: 'est', causes: [{ t: 'الفيش أو الأسلاك', p: 0.5 }, { t: 'القطعة نفسها', p: 0.35 }, { t: 'الكمبيوتر أو برمجته', p: 0.15 }], evidence: [`كود منفرد بدون ارتباط بأكواد أخرى`], steps: [{ t: 'افحص الفيش والأسلاك للقطعة المذكورة', m: 'تغذية/أرضي/إشارة', e: 'حسب المخطط' }] });
  }
  // A permanent-only code was confirmed in the past and is waiting for a passing re-test — say so
  const kinds = {}; for (const d of ctx.dtcs) if (d.kind) (kinds[d.code] ||= new Set()).add(d.kind);
  const permOnly = codes.filter(c => kinds[c] && [...kinds[c]].every(k => k === 'perm'));
  if (permOnly.length) for (const o of out) { const p = o.codes.filter(c => permOnly.includes(c)); if (p.length) o.evidence.push(`${list(p)} «دائم» فقط: تأكّد سابقًا ثم مُسح أو انطفأت لمبته، والكمبيوتر لم يُعِد اختباره بنجاح بعد — ليس بالضرورة عطلًا نشطًا الآن`); }
  // Trims abnormal without codes
  if (t && !lean.length && !rich.length && (Math.abs(t.all1) > 12 || (t.hasBank2 && Math.abs(t.all2) > 12))) add({
    title: 'تعديل الوقود خارج الطبيعي (بدون كود بعد)', codes: [], circuit: 'lean', score: 0.55, early: true,
    causes: [{ t: t.all1 > 0 ? 'بداية خلطة فقيرة' : 'بداية خلطة غنية', p: 1 }],
    evidence: [`متوسط التعديل الكلي بنك1 ${t.all1.toFixed(1)}%${t.hasBank2 ? `، بنك2 ${t.all2.toFixed(1)}%` : ''}`],
    steps: [{ t: 'راقب الاتجاه في «المتابعة التنبّؤية»', m: 'LTFT', e: 'ضمن ±8%' }],
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ===================== circuit diagram library ===================== */
export function circuitFor(code) {
  const n = /^P\d{4}$/.test(code) ? parseInt(code.slice(1), 10) : -1;
  if (code[0] === 'U') return 'canbus';
  if (/^B00/.test(code)) return 'srs';
  if (n >= 100 && n <= 104) return 'maf';
  if (n >= 105 && n <= 109) return 'map';
  if (n >= 110 && n <= 114) return 'iat';
  if ((n >= 115 && n <= 119) || n === 125 || n === 128) return 'ect';
  if ((n >= 120 && n <= 124) || (n >= 220 && n <= 224) || n === 2135) return 'tps';
  if ((n >= 130 && n <= 167) || (n >= 30 && n <= 44) || (n >= 50 && n <= 64)) return 'o2'; // P0045–P0049 are turbo boost, not O2
  if (n >= 170 && n <= 175) return 'lean';
  if (n >= 201 && n <= 212) return 'injector';
  if (n >= 300 && n <= 312) return 'coil';
  if (n >= 351 && n <= 362) return 'coil';
  if (n >= 325 && n <= 334) return 'knock';
  if (n >= 335 && n <= 339) return 'ckp';
  if (n >= 340 && n <= 349) return 'cmp';
  if ((n >= 440 && n <= 459) || n === 496) return 'evap';
  if ((n >= 560 && n <= 563) || (n >= 620 && n <= 622)) return 'charging';
  if ([641, 651, 697].includes(n)) return 'ref5';
  if ([230, 627, 87].includes(n)) return 'fuelpump';
  if ((n >= 10 && n <= 25)) return 'vvt';
  return null;
}
// Component and wire primitives. conf: 'sure' | 'best' | 'est'
const ECM = (x = 40, y = 70, h = 260, label = 'كمبيوتر المكينة ECM') => ({ id: 'ecm', label, x, y, w: 150, h, kind: 'ecm' });
function sensorTpl({ title, comp, pid, wires, notes = [], extra = [] }) {
  return { title, comps: [ECM(), { id: 'c', label: comp, x: 590, y: 110, w: 170, h: 40 + wires.length * 40, kind: 'part' }, ...extra], wires, notes, pid };
}
const W = (i, role, label, expect, measure, opts = {}) => ({ i, role, label, expect, measure, conf: 'best', ...opts });

export const CIRCUITS = {
  ect: () => sensorTpl({ title: 'دائرة حساس حرارة التبريد (ثرمستور)', comp: 'حساس حرارة التبريد ECT', pid: 0x05, wires: [
    W(0, 'sig', 'إشارة الحرارة', 'بارد ≈ 3–4.5V، حار ≈ 0.4–1V (تقديري، تتغير حسب الحساس)', 'فولت بين الإشارة والأرضي والفيش موصول', { pid: 0x05 }),
    W(1, 'gnd', 'أرضي مرجعي من الكمبيوتر', 'أقل من 0.1V', 'فرق الجهد بين السلك وسالب البطارية'),
  ], notes: ['القراءة −40°C تعني دائرة مفتوحة (فيش مفصول/سلك مقطوع)', 'القراءة أعلى من 130°C على مكينة باردة تعني تماس مع الأرضي'] }),
  iat: () => sensorTpl({ title: 'دائرة حساس حرارة الهواء (ثرمستور)', comp: 'حساس حرارة الهواء IAT', pid: 0x0f, wires: [
    W(0, 'sig', 'إشارة الحرارة', 'يتغير عكسيًا مع الحرارة', 'فولت الإشارة للأرضي', { pid: 0x0f }), W(1, 'gnd', 'أرضي مرجعي', 'أقل من 0.1V', 'فرق جهد للسالب')], notes: ['−40°C = دائرة مفتوحة'] }),
  tps: () => sensorTpl({ title: 'دائرة حساس موضع الثروتل (3 أسلاك)', comp: 'حساس الثروتل TPS', pid: 0x11, wires: [
    W(0, 'ref5', 'مرجع 5V', '4.8–5.2V', 'فولت للأرضي والسويتش ON'), W(1, 'sig', 'إشارة الموضع', 'يرتفع بسلاسة مع الدعس بلا قفزات', 'فولت الإشارة أثناء تحريك الدعسة', { pid: 0x11 }), W(2, 'gnd', 'أرضي مرجعي', 'أقل من 0.1V', 'فرق جهد للسالب')] }),
  map: () => sensorTpl({ title: 'دائرة حساس ضغط المنيفولد MAP', comp: 'حساس MAP', pid: 0x0b, wires: [
    W(0, 'ref5', 'مرجع 5V', '4.8–5.2V', 'فولت للأرضي'), W(1, 'sig', 'إشارة الضغط', 'خمول ≈ 1–1.5V، سويتش ON بدون تشغيل ≈ 4–4.7V (تقديري)', 'فولت الإشارة', { pid: 0x0b }), W(2, 'gnd', 'أرضي مرجعي', 'أقل من 0.1V', 'فرق جهد')] }),
  maf: () => sensorTpl({ title: 'دائرة حساس تدفق الهواء MAF', comp: 'حساس MAF', pid: 0x10, wires: [
    W(0, 'b+', 'تغذية 12V (من فيوز التشغيل)', 'فولت البطارية', 'فولت للأرضي والسويتش ON'), W(1, 'sig', 'إشارة التدفق (تردد أو فولت حسب النوع)', 'تزيد مع الدوران', 'تردد/فولت', { pid: 0x10 }), W(2, 'gnd', 'أرضي', 'أقل من 0.1V', 'فرق جهد للسالب')],
    extra: [{ id: 'f', label: 'فيوز التشغيل', x: 360, y: 20, w: 120, h: 34, kind: 'fuse' }], notes: ['عدد الأسلاك يختلف حسب الطراز (3 إلى 6 مع حساس حرارة مدمج) — المخطط مبسّط وتقديري'] }),
  o2: () => sensorTpl({ title: 'دائرة حساس الأكسجين المسخَّن (4 أسلاك)', comp: 'حساس الأكسجين', pid: 0x14, wires: [
    W(0, 'b+', 'تغذية السخّان 12V', 'فولت البطارية', 'فولت للأرضي والسويتش ON'), W(1, 'ctrl', 'تحكم السخّان (أرضي من الكمبيوتر)', 'مقاومة السخّان عادة 3–15Ω (تقديري)', 'مقاومة بين طرفي السخّان والفيش مفصول'),
    W(2, 'sig', 'إشارة الأكسجين', 'تتذبذب 0.1–0.9V بسرعة والمكينة حارّة', 'فولت الإشارة', { pid: 0x14 }), W(3, 'gnd', 'أرضي مرجعي', 'أقل من 0.1V', 'فرق جهد')],
    extra: [{ id: 'f', label: 'فيوز', x: 360, y: 20, w: 100, h: 34, kind: 'fuse' }] }),
  ckp: () => sensorTpl({ title: 'دائرة حساس عمود الكرنك CKP', comp: 'حساس الكرنك', pid: 0x0c, wires: [
    W(0, 'ref5', 'تغذية (5V أو 12V حسب النوع)', 'حسب النوع', 'فولت للأرضي'), W(1, 'sig', 'إشارة النبضات', 'نبضات أثناء التدوير (راسم إشارة)', 'تردد أثناء التدوير', { pid: 0x0c }), W(2, 'gnd', 'أرضي مرجعي', 'أقل من 0.1V', 'فرق جهد')], notes: ['إذا لم يظهر دوران أثناء التدوير فالإشارة لا تصل'] }),
  cmp: () => sensorTpl({ title: 'دائرة حساس عمود الكامات CMP', comp: 'حساس الكامات', wires: [
    W(0, 'ref5', 'تغذية', 'حسب النوع', 'فولت للأرضي'), W(1, 'sig', 'إشارة', 'نبضات أثناء التشغيل', 'راسم إشارة'), W(2, 'gnd', 'أرضي مرجعي', 'أقل من 0.1V', 'فرق جهد')] }),
  knock: () => sensorTpl({ title: 'دائرة حساس الطَّرق (Knock)', comp: 'حساس الطَّرق', wires: [
    W(0, 'sig', 'إشارة', 'فولت متردد صغير أثناء التشغيل', 'راسم إشارة'), W(1, 'gnd', 'أرضي مرجعي', 'أقل من 0.1V', 'فرق جهد')], notes: ['في بعض مكائن V8 الحساسات تحت المنيفولد ويصلها الماء/التآكل — تقديري'] }),
  injector: () => sensorTpl({ title: 'دائرة البخاخ', comp: 'البخاخ', wires: [
    W(0, 'b+', 'تغذية 12V (فيوز/ريليه)', 'فولت البطارية مع السويتش ON', 'فولت للأرضي'), W(1, 'ctrl', 'تحكم (الكمبيوتر يؤرّض)', 'مقاومة البخاخ عادة 11–18Ω (تقديري)', 'مقاومة البخاخ والفيش مفصول / لمبة اختبار نبضات')],
    extra: [{ id: 'f', label: 'فيوز البخاخات', x: 360, y: 20, w: 130, h: 34, kind: 'fuse' }] }),
  coil: () => sensorTpl({ title: 'دائرة الكويل (نوع بمشغّل مدمج — 4 أسلاك)', comp: 'الكويل', wires: [
    W(0, 'b+', 'تغذية 12V', 'فولت البطارية مع السويتش ON', 'فولت للأرضي'), W(1, 'gnd', 'أرضي قدرة', 'أقل من 0.1V', 'فرق جهد للسالب أثناء التشغيل'),
    W(2, 'ctrl', 'إشارة الإشعال من الكمبيوتر', 'نبضات أثناء التشغيل', 'راسم إشارة / لمبة LED'), W(3, 'gnd', 'أرضي مرجعي', 'أقل من 0.1V', 'فرق جهد')], notes: ['بعض الكويلات 2 أو 3 أسلاك — المخطط تقديري', 'أفضل اختبار عملي: بدّل الكويل مع سلندر سليم وراقب انتقال العطل'] }),
  evap: () => sensorTpl({ title: 'دائرة صمام تنقية بخار الوقود EVAP', comp: 'صمام التنقية', pid: 0x2e, wires: [
    W(0, 'b+', 'تغذية 12V', 'فولت البطارية', 'فولت للأرضي'), W(1, 'ctrl', 'تحكم PWM من الكمبيوتر', 'نسبة التشغيل = قيمة التنقية المطلوبة', 'راسم إشارة', { pid: 0x2e })] }),
  vvt: () => sensorTpl({ title: 'دائرة صولونويد التحكم بالكامات', comp: 'صولونويد الكامات', wires: [
    W(0, 'ctrl', 'تحكم PWM من الكمبيوتر', 'مقاومة عادة 7–12Ω (تقديري)', 'مقاومة الصولونويد'), W(1, 'gnd', 'راجع/أرضي', 'أقل من 0.1V', 'فرق جهد')] }),
  fuelpump: () => ({ title: 'دائرة طرمبة البنزين', comps: [ECM(), { id: 'r', label: 'ريليه الطرمبة', x: 330, y: 90, w: 140, h: 120, kind: 'relay' }, { id: 'c', label: 'طرمبة البنزين', x: 590, y: 110, w: 170, h: 120, kind: 'part' }, { id: 'b', label: 'البطارية + فيوز', x: 330, y: 260, w: 140, h: 40, kind: 'batt' }],
    wires: [W(0, 'ctrl', 'تحكم ملف الريليه من الكمبيوتر', 'يؤرّض ثانيتين عند فتح السويتش', 'لمبة اختبار', { a: 'ecm', b: 'r' }), W(1, 'b+', 'خرج الريليه للطرمبة', 'فولت البطارية أثناء التشغيل', 'فولت عند فيش الطرمبة', { a: 'r', b: 'c' }), W(2, 'gnd', 'أرضي الطرمبة', 'أقل من 0.2V تحت حِمل', 'فرق جهد', { a: 'c', b: 'b' })], notes: ['بعض الطرازات تستخدم كمبيوتر تحكم خاص بالطرمبة — تقديري'] }),
  charging: () => ({ title: 'دائرة الشحن والبطارية', pid: 0x42, comps: [ECM(), { id: 'alt', label: 'الدينمو', x: 590, y: 90, w: 170, h: 130, kind: 'part' }, { id: 'bat', label: 'البطارية', x: 330, y: 250, w: 150, h: 60, kind: 'batt' }],
    wires: [W(0, 'b+', 'خرج الدينمو B+ للبطارية', '13.5–14.8V والمكينة شغالة', 'فولت عند أقطاب البطارية', { a: 'alt', b: 'bat', vlive: true }), W(1, 'ctrl', 'تحكم/طلب الشحن من الكمبيوتر', 'إشارة تحكم (نوعها يختلف)', 'راسم إشارة', { a: 'ecm', b: 'alt' }), W(2, 'sig', 'تغذية الكمبيوتر', 'نفس فولت البطارية (فرق < 0.5V)', 'قارن فولت الكمبيوتر مع فولت القطعة', { a: 'bat', b: 'ecm', pid: 0x42 }), W(3, 'gnd', 'أرضي المكينة/الجسم', 'فرق أقل من 0.3V أثناء التدوير', 'فرق جهد بين السالب وجسم المكينة', { a: 'bat', b: 'alt' })] }),
  canbus: () => ({ title: 'شبكة CAN عالية السرعة وفيش الفحص', comps: [{ id: 'dlc', label: 'فيش الفحص OBD', x: 330, y: 20, w: 150, h: 60, kind: 'dlc' }, ECM(40, 130, 120, 'كمبيوتر المكينة (إنهاء 120Ω)'), { id: 'm2', label: 'كمبيوتر آخر', x: 330, y: 200, w: 150, h: 90, kind: 'part' }, { id: 'c', label: 'كمبيوتر طرفي (إنهاء 120Ω)', x: 590, y: 130, w: 170, h: 120, kind: 'part' }],
    wires: [W(0, 'can', 'CAN-H (طرف 6)', '≈ 2.5–3.5V', 'فولت للأرضي والسويتش ON', { a: 'dlc', b: 'ecm' }), W(1, 'can', 'CAN-L (طرف 14)', '≈ 1.5–2.5V', 'فولت للأرضي', { a: 'dlc', b: 'c' }), W(2, 'can', 'ناقل CAN للكمبيوترات', 'مقاومة 6↔14 ≈ 60Ω والبطارية مفصولة', 'مقاومة بين الطرفين', { a: 'ecm', b: 'm2' }), W(3, 'can', 'ناقل CAN', '', '', { a: 'm2', b: 'c' })],
    notes: ['طرفا 4 و5 في فيش الفحص أرضي، وطرف 16 تغذية 12V (معيار SAE J1962 — موثوق)'] }),
  ref5: () => ({ title: 'مرجع 5V المشترك بين الحساسات', comps: [ECM(40, 60, 300), { id: 's1', label: 'حساس الثروتل', x: 590, y: 40, w: 170, h: 60, kind: 'part' }, { id: 's2', label: 'حساس MAP', x: 590, y: 130, w: 170, h: 60, kind: 'part' }, { id: 's3', label: 'حساس ضغط EVAP/الزيت', x: 590, y: 220, w: 170, h: 60, kind: 'part' }],
    wires: [W(0, 'ref5', 'مرجع 5V', '4.8–5.2V في كل حساس', 'فولت للأرضي', { a: 'ecm', b: 's1' }), W(1, 'ref5', 'مرجع 5V (نفس الدائرة)', '4.8–5.2V', 'افصل الحساسات واحدًا واحدًا', { a: 'ecm', b: 's2' }), W(2, 'ref5', 'مرجع 5V (نفس الدائرة)', '4.8–5.2V', '', { a: 'ecm', b: 's3' })], notes: ['أي الحساسات تشترك فعلًا في نفس المرجع يختلف حسب السيارة — تقديري'] }),
  srs: () => ({ title: 'دائرة الوسادة الهوائية (مبسّطة)', comps: [ECM(40, 90, 160, 'كمبيوتر الوسائد SDM'), { id: 'cs', label: 'الساعة الحلزونية / فيش المقعد', x: 330, y: 100, w: 150, h: 70, kind: 'part' }, { id: 'c', label: 'الوسادة (Squib)', x: 590, y: 100, w: 170, h: 90, kind: 'part' }],
    wires: [W(0, 'sig', 'دائرة الإطلاق (+)', 'لا تُقاس بالملتيميتر', '⚠ لا تقِس — خطر إطلاق', { a: 'ecm', b: 'cs' }), W(1, 'sig', 'دائرة الإطلاق (−)', 'لا تُقاس', '⚠', { a: 'cs', b: 'c' })], notes: ['⚠ لا تستخدم الملتيميتر على دوائر الوسائد — قد يطلقها التيار. استخدم أداة محاكاة (Simulator) فقط', 'افصل البطارية وانتظر المدة المحددة من المصنّع قبل العمل'], safety: true }),
  lean: () => ({ title: 'مسار الهواء والوقود (لتشخيص الخلطة)', pid: 0x07, comps: [{ id: 'maf', label: 'حساس MAF', x: 10, y: 60, w: 120, h: 56, kind: 'part' }, { id: 'tb', label: 'الثروتل', x: 205, y: 60, w: 110, h: 56, kind: 'part' }, { id: 'im', label: 'المنيفولد (تسريبات)', x: 390, y: 50, w: 160, h: 76, kind: 'part' }, { id: 'inj', label: 'البخاخات + ضغط الوقود', x: 390, y: 270, w: 160, h: 60, kind: 'part' }, { id: 'o2', label: 'حساسات الأكسجين', x: 630, y: 60, w: 160, h: 56, kind: 'part' }, { id: 'ecm', label: 'الكمبيوتر (تعديل الوقود)', x: 630, y: 260, w: 160, h: 80, kind: 'ecm' }],
    wires: [W(0, 'air', 'هواء مقاس', 'MAF يزيد مع الدوران', '', { a: 'maf', b: 'tb', pid: 0x10 }), W(1, 'air', 'هواء', '', '', { a: 'tb', b: 'im', pid: 0x11 }), W(2, 'air', 'هواء + وقود → عادم', '', '', { a: 'im', b: 'o2' }), W(3, 'sig', 'قراءة الأكسجين', 'تتذبذب', '', { a: 'o2', b: 'ecm', pid: 0x14 }), W(4, 'ctrl', 'تعديل كمية الوقود', 'التعديل الكلي ±10%', '', { a: 'ecm', b: 'inj', pid: 0x07 }), W(5, 'fuel', 'وقود', '', '', { a: 'inj', b: 'im' })], notes: ['الخلطة الفقيرة على الخمول التي تتحسن على الدوران العالي = تسريب هواء غالبًا'] }),
};
let USER_CIRCUITS = {};
// Circuits from imported library files: only well-formed ones, with numbers forced to numbers and
// text forced to text (a file must not be able to break the page or inject markup into the drawing).
const num = (v, d = 0) => (v !== '' && v != null && Number.isFinite(+v) ? +v : d);
const str = v => (v == null ? undefined : String(v));
function cleanCircuit(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.comps) || !Array.isArray(c.wires) || !c.comps.length) return null;
  const comps = c.comps.filter(x => x && x.id != null).map(x => ({ id: String(x.id), label: String(x.label ?? x.id), sub: str(x.sub), kind: String(x.kind || 'part'), x: num(x.x), y: num(x.y), w: num(x.w, 150), h: num(x.h, 60) }));
  const wires = c.wires.filter(w => w && typeof w === 'object').map((w, i) => ({
    i: num(w.i, i), role: String(w.role || 'sig'), label: String(w.label || ''), expect: String(w.expect ?? ''), measure: String(w.measure ?? ''),
    conf: ['sure', 'best', 'est'].includes(w.conf) ? w.conf : 'best', pid: w.pid != null && Number.isFinite(+w.pid) ? +w.pid : undefined,
    a: str(w.a), b: str(w.b), pin: str(w.pin), vlive: !!w.vlive, quiet: !!w.quiet, y: w.y != null && Number.isFinite(+w.y) ? +w.y : undefined,
  }));
  return { title: String(c.title || 'مخطط من المكتبة'), comps, wires, notes: Array.isArray(c.notes) ? c.notes.map(String) : [] };
}
// Called with the circuits of all libraries currently installed (replaces the previous set, so a
// deleted library's circuits disappear immediately).
export function addLibraryCircuits(obj) { const o = {}; for (const [k, v] of Object.entries(obj || {})) { const c = cleanCircuit(v); if (c) o[k] = c; } USER_CIRCUITS = o; }
export function getCircuit(id) {
  if (USER_CIRCUITS[id]) return { ...USER_CIRCUITS[id], fromLibrary: true };
  return CIRCUITS[id] ? CIRCUITS[id]() : null;
}
export const CIRCUIT_LIST = () => [...new Set([...Object.keys(CIRCUITS), ...Object.keys(USER_CIRCUITS)])];

// Evaluate live readings on a circuit: where does the chain break? (estimated)
export function chainCheck(id, live, volt, charge = { ok: [13.5, 14.8], rvc: false }) {
  const r = [];
  const v = p => live?.[p];
  if (id === 'ect' && v(0x05) != null) {
    if (v(0x05) <= -39) r.push({ wire: 0, st: 'bad', t: 'القراءة −40°C: الدائرة مفتوحة بين الحساس والكمبيوتر (فيش/سلك/حساس)' });
    else if (v(0x05) >= 135) r.push({ wire: 0, st: 'bad', t: 'قراءة عالية جدًا: تماس الإشارة مع الأرضي' });
    else r.push({ wire: 0, st: 'ok', t: `الكمبيوتر يقرأ ${v(0x05).toFixed(0)}°C — السلسلة متصلة` });
  }
  if (id === 'iat' && v(0x0f) != null) r.push(v(0x0f) <= -39 ? { wire: 0, st: 'bad', t: 'دائرة مفتوحة (−40°C)' } : { wire: 0, st: 'ok', t: `يقرأ ${v(0x0f).toFixed(0)}°C` });
  if (id === 'tps' && v(0x11) != null) r.push(v(0x11) < 1 ? { wire: 1, st: 'bad', t: 'الإشارة صفر: مرجع 5V مقطوع أو الإشارة متماسة مع الأرضي' } : v(0x11) > 98 ? { wire: 1, st: 'bad', t: 'الإشارة قصوى: تماس مع 5V أو أرضي مرجعي مقطوع' } : { wire: 1, st: 'ok', t: `يقرأ ${v(0x11).toFixed(0)}%` });
  if (id === 'map' && v(0x0b) != null) r.push(v(0x0b) < 5 ? { wire: 1, st: 'bad', t: 'قراءة شبه صفرية: مرجع/إشارة' } : { wire: 1, st: 'ok', t: `يقرأ ${v(0x0b)} kPa` });
  if (id === 'maf' && v(0x10) != null) r.push(v(0x10) < 0.5 && live?.running ? { wire: 1, st: 'bad', t: 'لا إشارة تدفق والمكينة شغالة' } : { wire: 1, st: 'ok', t: `يقرأ ${v(0x10).toFixed(1)} g/s` });
  if (id === 'o2' && v(0x14) != null) r.push(Math.abs(v(0x14) - 0.45) < 0.03 ? { wire: 2, st: 'warn', t: 'الفولت ثابت قرب 0.45V: الحساس غير نشط (بارد أو سخّان معطّل)' } : { wire: 2, st: 'ok', t: `يقرأ ${v(0x14).toFixed(2)}V` });
  if (id === 'charging' && (volt || v(0x42))) {
    if (volt) r.push({ wire: 0, st: live?.running ? (volt >= charge.ok[0] && volt <= charge.ok[1] ? 'ok' : 'bad') : volt >= 12.4 ? 'ok' : 'warn', t: `فولت القطعة (البطارية) ${volt.toFixed(2)}V${live?.running && charge.rvc && volt < 13.4 ? ' — طبيعي لنظام RVC والبطارية مشحونة؛ تحقق تحت حِمل' : ''}` });
    if (volt && v(0x42)) { const d = Math.abs(volt - v(0x42)); r.push({ wire: 2, st: d > 0.5 ? 'warn' : 'ok', t: `فرق بين فولت البطارية وفولت الكمبيوتر ${d.toFixed(2)}V${d > 0.5 ? ' — هبوط جهد في التغذية/الأرضي' : ''}` }); }
  }
  if (id === 'lean' && v(0x07) != null) r.push({ wire: 4, st: Math.abs(v(0x07)) > 15 ? 'bad' : Math.abs(v(0x07)) > 8 ? 'warn' : 'ok', t: `تعديل طويل بنك1 ${v(0x07).toFixed(1)}%` });
  return r;
}
