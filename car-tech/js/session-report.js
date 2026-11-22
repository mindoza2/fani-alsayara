// The full session report: everything recorded from the first scan until the adapter was
// disconnected — summary, the drive, every code and when it came and went, the analysis of each
// fault, every live value with its range check and chart, charging, every scan with its readiness,
// freeze frames and self-tests, guided-test results, the timeline of everything that happened, the
// adapter's log, and the raw data as a CSV file inside the report.
import { esc, fmtDate } from './util.js';
import { describeDtc } from './dtcdb.js';
import { combineReadiness, readinessStats, m6State, M6_LABEL } from './obd.js';
import { AREA } from './analyst.js';
import { PIDS } from './obd.js';
import { decodeVin } from './core.js';
import { gmPidInfo } from './gm-enhanced.js';
import { computeStats, liveFindings } from './session.js';

const CSS = `body{font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif;background:#0a101a;color:#e6eefb;margin:0;padding:20px;line-height:1.6}
.w{max-width:980px;margin:0 auto}h1{font-size:22px;margin:0}h2{font-size:18px;border-bottom:1px solid #22324d;padding-bottom:6px;margin-top:28px}h3{font-size:15px;margin:12px 0 6px}
.card{background:#111b2c;border:1px solid #22324d;border-radius:14px;padding:12px 14px;margin:10px 0;overflow-x:auto}td{overflow-wrap:anywhere}td.mono{white-space:nowrap;overflow-wrap:normal}.mono{font-family:Consolas,monospace;direction:ltr;unicode-bidi:isolate}
table{width:100%;border-collapse:collapse;font-size:13.5px}td,th{padding:5px 7px;border-bottom:1px solid #1a263b;text-align:start;vertical-align:top}th{color:#8394ad;font-weight:500;position:sticky;top:0;background:#111b2c}
.ok{color:#33e39b}.bad{color:#ff5468}.warn{color:#ffb547}.dim{color:#8394ad;font-size:12.5px}.tag{display:inline-block;font-size:11px;border:1px solid #3a4b68;border-radius:6px;padding:0 6px;margin-inline-start:4px}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}.kpi{background:#0d1626;border:1px solid #22324d;border-radius:12px;padding:8px 10px}.kpi b{display:block;font-size:20px;unicode-bidi:plaintext;text-align:right}
.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}.ch{background:#0d1626;border:1px solid #22324d;border-radius:12px;padding:8px}.ch svg{width:100%;height:auto;display:block}
.bar{display:flex;height:6px;border-radius:9px;overflow:hidden;background:#1a263b;margin:4px 0}.bar i{display:block;height:100%}
.demo{background:#2a1d4a;border:1px solid #6b4fc9;border-radius:10px;padding:8px 12px;margin:10px 0}.part{background:#3a2a10;border:1px solid #a87a20;border-radius:10px;padding:8px 12px;margin:10px 0}
details{margin:6px 0}summary{cursor:pointer;color:#9fd8ff}.log{font-family:Consolas,monospace;font-size:11.5px;direction:ltr;white-space:pre-wrap;max-height:420px;overflow:auto;background:#070c14;border-radius:8px;padding:8px}
a.dl{display:inline-block;background:#2f7bff;color:#fff;border-radius:10px;padding:8px 14px;text-decoration:none;margin:4px 0}
@media print{body{background:#fff;color:#000}.card,.kpi,.ch{background:#fff;border-color:#ccc}th{background:#fff}}`;
const KIND = { stored: 'مخزّن', pending: 'معلّق', perm: 'دائم' };
// What each standard value means (for anyone reading the report)
const DESC = {
  0x03: 'هل الكمبيوتر يتحكم بالخلطة من حساسات الأكسجين (حلقة مغلقة) أو من جداول ثابتة (مفتوحة: تشغيل بارد أو تسارع قوي).',
  0x04: 'نسبة الحِمل على المكينة؛ الخمول عادة 15–30%.', 0x05: 'حرارة ماء التبريد؛ المكينة الحارّة عادة 85–105°C.',
  0x06: 'تصحيح الخلطة اللحظي للبنك 1 (السائق): موجب = يضيف وقود (هواء زيادة)، سالب = ينقص.', 0x07: 'التصحيح المتعلَّم طويل المدى للبنك 1؛ فوق ±10% يدل على مشكلة خلطة.',
  0x08: 'تصحيح الخلطة اللحظي للبنك 2 (الراكب).', 0x09: 'التصحيح المتعلَّم طويل المدى للبنك 2.',
  0x0a: 'ضغط الوقود.', 0x0b: 'ضغط/فاكيوم المنيفولد؛ الخمول عادة 25–45 kPa، والمكينة طافية = الضغط الجوي.',
  0x0c: 'دوران المكينة.', 0x0d: 'سرعة السيارة من الكمبيوتر.', 0x0e: 'تقديم الشرارة قبل النقطة الميتة العليا.',
  0x0f: 'حرارة الهواء الداخل للمكينة.', 0x10: 'كمية الهواء الداخلة (غرام/ثانية)؛ على الخمول تقريبًا 0.6–1.0 × حجم المكينة.',
  0x11: 'فتحة بوابة الهواء.', 0x14: 'حساس الأكسجين قبل الدبة — بنك 1: يتذبذب 0.1–0.9V والمكينة حارّة.', 0x15: 'حساس الأكسجين بعد الدبة — بنك 1: ثابت تقريبًا إذا الدبة سليمة.',
  0x18: 'حساس الأكسجين قبل الدبة — بنك 2.', 0x19: 'حساس الأكسجين بعد الدبة — بنك 2.', 0x1f: 'الوقت منذ تشغيل المكينة.',
  0x21: 'المسافة المقطوعة واللمبة مضاءة.', 0x2e: 'نسبة فتح صمام تنقية بخار الوقود.', 0x2f: 'مستوى الوقود في الخزان.',
  0x30: 'عدد مرات تسخين المكينة منذ آخر مسح للأعطال.', 0x31: 'المسافة منذ آخر مسح للأعطال.', 0x32: 'ضغط بخار الوقود في الخزان.',
  0x33: 'الضغط الجوي (يقل مع الارتفاع).', 0x3c: 'حرارة الدبة المحسوبة — بنك 1.', 0x3d: 'حرارة الدبة المحسوبة — بنك 2.', 0x3e: 'حرارة بعد الدبة — بنك 1.', 0x3f: 'حرارة بعد الدبة — بنك 2.',
  0x42: 'الفولت الواصل لهذا الكمبيوتر من البطارية (يقرا أقل من البطارية بشوي بسبب الأسلاك).', 0x43: 'الحِمل المطلق.', 0x44: 'الخلطة المطلوبة (1.00 = مثالية).', 0x45: 'فتحة الثروتل نسبةً لأقل فتحة متعلَّمة.',
  0x46: 'حرارة الجو.', 0x47: 'حساس الثروتل الثاني.', 0x49: 'دعسة البنزين — الحساس الأول.', 0x4a: 'دعسة البنزين — الحساس الثاني.', 0x4c: 'فتحة الثروتل اللي يطلبها الكمبيوتر من الموتور.',
  0x4d: 'دقائق التشغيل واللمبة مضاءة.', 0x4e: 'دقائق منذ مسح الأعطال.', 0x5c: 'حرارة زيت المكينة.', 0x5e: 'معدل استهلاك الوقود.', 0xa6: 'عدّاد المسافة من الكمبيوتر.',
};
const descOf = s => s.gm ? gmPidInfo(s.pid)?.d || '' : DESC[s.pid] || '';
const rangeOf = s => { const rg = s.range || (s.gm ? gmPidInfo(s.pid)?.rg : PIDS[s.pid]?.[7]); return rg ? `${n2(rg.ok[0])}–${n2(rg.ok[1])}${rg.when === 'warm' ? ' (حارّة)' : rg.when === 'running' ? ' (شغالة)' : ''}` : '—'; };
const n2 = v => v == null || Number.isNaN(v) ? '—' : Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
const dur = ms => { const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} س ${m} د` : `${m} د ${s % 60} ث`; };
const clock = t => new Date(t).toLocaleTimeString('ar-SA-u-ca-gregory-nu-latn', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const rel = (t, t0) => { const s = Math.max(0, Math.round((t - t0) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const COLORS = ['#3de0ff', '#ffb547', '#a57bff', '#33e39b', '#ff5468', '#9fd8ff', '#ffd166', '#ff8fb1'];

// A line chart of one series over the session (min/max per bucket so short peaks stay visible).
function chart(pts, t0, t1, col, unit) {
  const P = pts.filter(p => typeof p[1] === 'number'); if (P.length < 2) return '';
  const W = 600, H = 130, B = Math.min(400, P.length);
  const span = Math.max(1, t1 - t0);
  const buckets = Array.from({ length: B }, () => null);
  for (const [t, v] of P) { const k = Math.min(B - 1, Math.floor((t - t0) / span * B)); const b = buckets[k] ||= { mn: v, mx: v, t }; b.mn = Math.min(b.mn, v); b.mx = Math.max(b.mx, v); }
  const vals = P.map(p => p[1]); const mn = Math.min(...vals), mx = Math.max(...vals), sp = mx - mn || 1;
  const y = v => (H - 18 - (v - mn) / sp * (H - 30)).toFixed(1), x = k => (k / (B - 1) * W).toFixed(1);
  const line = []; buckets.forEach((b, k) => { if (!b) return; line.push(`${x(k)},${y(b.mx)}`); if (b.mn !== b.mx) line.push(`${x(k)},${y(b.mn)}`); });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => `<text x="${(f * W).toFixed(0)}" y="${H - 2}" fill="#5f6f88" font-size="10" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${rel(t0 + f * span, t0)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="direction:ltr"><line x1="0" y1="${y(mx)}" x2="${W}" y2="${y(mx)}" stroke="#1d2a40"/><line x1="0" y1="${y(mn)}" x2="${W}" y2="${y(mn)}" stroke="#1d2a40"/>
    <polyline points="${line.join(' ')}" fill="none" stroke="${col}" stroke-width="1.6"/><text x="${W}" y="11" fill="#8394ad" font-size="10" text-anchor="end">${esc(n2(mx))} ${esc(unit || '')}</text><text x="${W}" y="${H - 22}" fill="#8394ad" font-size="10" text-anchor="end">${esc(n2(mn))}</text>${ticks}</svg>`;
}

// Catalyst codes: how the rear oxygen sensor behaved in the recording next to the front one, plus
// the catalyst self-test result (a healthy converter keeps the rear sensor nearly flat).
function catEvidence(r, codes) {
  const out = [];
  for (const bank of [1, 2]) {
    if (!codes.some(c => (bank === 1 ? /^P042[0-4]$/ : /^P043[0-4]$/).test(c))) continue;
    const ser = pid => Object.values(r.series || {}).find(x => x.pid === pid && x.ecu === '7E8' && !x.text && x.pts.length > 5);
    const f = ser(bank === 1 ? 0x14 : 0x18), b = ser(bank === 1 ? 0x15 : 0x19), o = ser(bank === 1 ? 0x19 : 0x15);
    const span = x => { const v = x.pts.map(p => p[1]); return Math.max(...v) - Math.min(...v); };
    const flips = x => { let n = 0; for (let i = 1; i < x.pts.length; i++) if ((x.pts[i - 1][1] - 0.45) * (x.pts[i][1] - 0.45) < 0) n++; return n; };
    if (b) out.push(`في التسجيل: الحساس الخلفي للبنك ${bank} تحرّك ${n2(span(b))}V وعبر منتصف 0.45V ${flips(b)} مرة${f ? ` (الأمامي ${flips(f)} مرة)` : ''}${o ? ` — الخلفي للبنك الثاني تحرّك ${n2(span(o))}V فقط` : ''}${span(b) > 0.5 ? ' — الخلفي يقلّد الأمامي: الدبة ما تخزّن أكسجين' : ''}`);
    const m6 = ((r.final?.mode06 || (r.scans || []).at(-1)?.mode06) || []).flatMap(x => x.rows || []).filter(x => x.mid === (bank === 1 ? 0x21 : 0x22));
    for (const x of m6) out.push(m6State(x) === 'notrun' ? `اختبار الدبة الذاتي (Mode 6) للبنك ${bank}: ما اشتغل بعد (الأكواد ممسوحة قريب)` : `اختبار الدبة الذاتي (Mode 6) للبنك ${bank}: ${n2(x.value)} والحد ${n2(x.min)}–${n2(x.max)} ← ${M6_LABEL[m6State(x)][1]}`);
  }
  return out;
}

export function sessionReportHtml(r) {
  const t0 = r.t, t1 = r.tEnd || Date.now();
  const v = r.vehicle || {}, m = r.analysis?.mods || v.mods || {};
  const vd = v.vin ? decodeVin(v.vin) : null;
  // the numbers are worked out again from the recording, so an older report gets every later fix
  let S = r.stats || {}; try { if (r.series) S = computeStats(r); } catch (e) { console.warn(e); }
  const cyl = (r.cyl ?? (!m.swap ? vd?.engine?.cyl : null)) || null;
  const cylOk = x => { const c = +(String(x.name || '').match(/سلندر (\d+)/) || [])[1]; return !c || !cyl || c <= cyl; };
  S = { ...S, series: (S.series || []).filter(cylOk) };
  let F = r.findings || []; try { if (r.series) F = liveFindings({ ...r, cyl }, S); } catch (e) { console.warn(e); }
  const title = 'تقرير جلسة السيارة';
  let h = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="w">`;
  h += `<h1>${title}</h1><div class="dim">«فني السيارة» — من ${fmtDate(t0)} إلى ${fmtDate(t1)} (${dur(t1 - t0)})</div>`;
  if (r.demo) h += '<div class="demo">⚠ هذا التقرير من الوضع التجريبي ببيانات نموذجية وليس من سيارة حقيقية.</div>';
  if (r.partial) h += `<div class="part">⚠ ${esc(r.endedBy)}. المعروض هو كل ما انحفظ قبلها.</div>`;
  const mods = [m.swap && 'مكينة مركّبة (سواب)', m.tune && 'برمجة معدّلة', (m.afmOff || m.noAFM) && 'بدون AFM', m.rearO2Off && 'حساسات/دبات خلفية ملغاة', m.absKill && 'قاطع ABS'].filter(Boolean);
  h += `<div class="card"><b>${esc([v.make, v.model, v.year].filter(Boolean).join(' ') || 'سيارة غير محددة')}</b>${v.vin ? ` — VIN <span class="mono">${esc(v.vin)}</span>` : ''}${v.engine ? ` — ${esc(v.engine)}` : ''}${v.displacement ? ` — ${esc(v.displacement)}L` : ''}
    ${vd?.valid ? `<div class="dim">رقم الهيكل: الصانع (WMI) <span class="mono">${esc(vd.wmi)}</span>${vd.make ? ` = ${esc(vd.make)}` : ''} · سنة الموديل ${vd.year || '?'} · رقم التحقق ${vd.checkOk ? 'صحيح' : 'لا يطابق'} · التسلسل <span class="mono">${esc(vd.serial)}</span>${vd.engine ? ` · المكينة حسب رقم الهيكل: ${esc(vd.engine.name)}${m.swap ? ' (الأصلية — السيارة عليها سواب)' : ''}` : ''}</div>` : ''}
    ${mods.length || m.notes ? `<div class="dim">التعديلات: ${esc(mods.join('، '))}${m.notes ? ' — ' + esc(m.notes) : ''}</div>` : ''}
    <div class="dim">القطعة: ${esc(r.adapter?.name || '—')} ${esc(r.adapter?.version || '')} · البروتوكول: ${esc(r.adapter?.protocol || '—')}${r.analysis?.plat ? ` · المخطط: ${esc(r.analysis.plat)}` : ''} · انتهى: ${esc(r.endedBy || '')}</div></div>`;

  // ---------- 1. summary ----------
  const codes = Object.values(r.codes || {});
  const ecuNames = Object.fromEntries(((r.final?.ecus || (r.scans || []).at(-1)?.ecus) || []).filter(e => /^std:/.test(e.key || '')).map(e => [e.key.slice(4), e.name]));
  const who = ecu => ecuNames[ecu] || ({ '7E8': 'كمبيوتر المكينة', '7EA': 'كمبيوتر القير', '7EB': 'كمبيوتر طرمبة البنزين' }[ecu]) || ecu;
  const nameOf = s => s.pid === 0x42 ? 'فولت الكمبيوتر' : s.name;
  const label = s => `${nameOf(s)} — ${who(s.ecu)}`;
  const rvcCar = /GM|Chevrolet|GMC/.test(v.group || v.make || '') && (+v.year || 0) >= 2007;
  const hasWarm = F.some(f => /حرارة المكينة/.test(f.t)), hasCharge = !!S.ecmV;
  const flags = [];
  if (codes.length) flags.push(['bad', `${codes.length} كود عطل ظهر خلال الجلسة${codes.filter(c => c.present).length !== codes.length ? ` (${codes.filter(c => !c.present).length} اختفى قبل النهاية)` : ''}`]);
  if (S.maxEct > 108) flags.push(['bad', `حرارة المكينة وصلت ${n2(S.maxEct)}°C${S.hotSec ? ` (فوق 108°C لمدة ${dur(S.hotSec * 1000)})` : ''}`]);
  const vLow = (rvcCar ? 12.1 : 12.4) - (S.vFrom === 'ecm' ? 0.2 : 0);
  if (!hasCharge && S.vRunMin != null && S.vRunMin < vLow) flags.push(['bad', `فولت الشحن نزل إلى ${n2(S.vRunMin)}V والمكينة شغالة`]);
  if (S.vRunMax != null && S.vRunMax > 15.2) flags.push(['bad', `فولت الشحن ارتفع إلى ${n2(S.vRunMax)}V`]);
  if (S.vOffMin != null && S.vOffMin < 11.9) flags.push(['warn', `فولت البطارية والمكينة طافية نزل إلى ${n2(S.vOffMin)}V`]);
  const skip = x => (x.pid === 0x42 && hasCharge) || (x.pid === 0x05 && hasWarm);
  for (const x of S.series || []) if (!x.text && !skip(x) && x.judged >= 5 && x.bad / x.judged > 0.1) flags.push(['warn', `${label(x)}: ${Math.round(x.bad / x.judged * 100)}% من الوقت خارج الحد (${n2(x.min)}–${n2(x.max)} ${x.unit})`]);
  if (S.hardA + S.hardB) flags.push(['warn', `تسارع قوي ${S.hardA} مرة · فرملة قوية ${S.hardB} مرة`]);
  for (const x of S.series || []) if (!x.text && !skip(x) && x.judged >= 5 && x.bad / x.judged <= 0.1 && x.warn / x.judged > 0.5) flags.push(['warn', `${label(x)}: أغلب الوقت قرب حدّه (${n2(x.min)}–${n2(x.max)} ${x.unit})`]);
  const errLog = Object.entries(r.logErr || {}).filter(([k]) => !/NO DATA/.test(k)).reduce((a, [, n]) => a + n, 0);
  if (errLog > 10) flags.push(['warn', `القطعة أعطت ${errLog} رد خطأ (تفاصيل في سجل القطعة)`]);
  h += '<h2>الخلاصة</h2><div class="kpis">' + [
    ['مدة الجلسة', dur(t1 - t0)], ['المسافة', `${n2(S.dist || 0)} km`], ['أعلى سرعة', `${n2(S.maxSpd || 0)} km/h`], ['أعلى دوران', `${n2(S.maxRpm || 0)}`],
    ['تشغيل المكينة', dur((S.run || 0) * 1000)], ['خمول', dur((S.idle || 0) * 1000)], ...(S.gapTotal > 15000 ? [['بدون قراءة', dur(S.gapTotal)]] : []), ['أكواد', `${codes.length}`], ['قيم مسجّلة', `${(S.series || []).length}`],
  ].map(([k, x]) => `<div class="kpi"><span class="dim">${k}</span><b>${esc(x)}</b></div>`).join('') + '</div>';
  if (S.rtLast != null) h += `<div class="dim">المكينة كانت شغالة ${dur(S.rtFirst * 1000)} قبل أول قراءة، وآخر قراءة لعدّاد التشغيل في الكمبيوتر ${dur(S.rtLast * 1000)}${S.runGap ? ` — وقت التشغيل يشمل ${dur(S.runGap * 1000)} ما انقرت فيها القيم لكن عدّاد الكمبيوتر يثبت إن المكينة كانت شغالة` : ''}.</div>`;
  const FK = { bad: 'bad', warn: 'warn', info: '' };
  h += `<div class="card">${F.length ? `<h3>ما تقوله القراءات</h3><ul>${F.map(f => `<li class="${FK[f.kind] || ''}"><b>${esc(f.t)}</b>${AREA[f.area] ? ` <span class="tag">${esc(AREA[f.area][0])}</span>` : ''}<div class="dim">${esc(f.d)}</div></li>`).join('')}</ul>` : ''}
    ${flags.length ? `<h3>ملاحظات</h3><ul>${flags.map(([c, t]) => `<li class="${c}">${esc(t)}</li>`).join('')}</ul>` : !F.some(f => f.kind !== 'info') ? '<div class="ok">ما ظهرت ملاحظات خطيرة في القراءات المسجّلة.</div>' : ''}
    ${r.analysis?.items?.length ? `<h3>أهم ما توصل له المحلّل</h3><ol>${r.analysis.items.slice(0, 4).map(it => `<li><b>${esc(it.title)}</b> <span class="mono dim">${esc(it.codes.join(' '))}</span><div class="dim">الأرجح: ${esc(AREA[it.causes[0]?.area]?.[0] || '')} — ${esc(it.causes[0]?.t || '')} (${Math.round((it.causes[0]?.p || 0) * 100)}%)</div></li>`).join('')}</ol>` : ''}</div>`;

  // ---------- 2. the drive ----------
  const ser = pid => (r.series ? Object.values(r.series).filter(s => s.pid === pid && !s.text).sort((a, b) => (b.ecu === '7E8') - (a.ecu === '7E8') || b.pts.length - a.pts.length)[0] : null);
  h += '<h2>المشوار</h2><div class="card">';
  h += `<div>المسافة ${n2(S.dist || 0)} km · وقت الحركة ${dur((S.moving || 0) * 1000)} · متوسط السرعة أثناء الحركة ${n2(S.avgSpd || 0)} km/h · وقت الخمول ${dur((S.idle || 0) * 1000)} · تسارع قوي ${S.hardA || 0} · فرملة قوية ${S.hardB || 0}</div><div class="dim">المسافة محسوبة من السرعة المسجّلة (تقريبية).</div>`;
  h += '<div class="charts" style="margin-top:8px">' + [[0x0d, 'السرعة'], [0x0c, 'دوران المكينة'], [0x04, 'الحِمل'], [0x05, 'حرارة التبريد']].map(([p, n], k) => { const s = ser(p); return s ? `<div class="ch"><div class="dim">${n}</div>${chart(s.pts, t0, t1, COLORS[k], s.unit)}</div>` : ''; }).join('') + '</div></div>';

  // ---------- identity of the computers ----------
  const m9 = (r.final?.mode09?.length ? r.final.mode09 : (r.scans || []).at(-1)?.mode09) || [];
  if ((r.idents || []).length || m9.length) {
    h += '<h2>هوية الكمبيوترات وبرمجتها</h2>';
    const clean = f => f.filter(([, val]) => !/^(FF ?)+$|^(00 ?)+$/i.test(String(val))).map(([k, val]) => [k, /رقم برنامج|رقم القطعة/.test(k) && /^([0-9A-F]{2} ){3}[0-9A-F]{2}$/i.test(String(val)) ? String(parseInt(String(val).replace(/ /g, ''), 16)) : val]);
    // "computer at 0x243" already names its address: only where it answers from is added
    const addrOf = x => { const a = String(x.ecu || ''), first = a.split(/\s/)[0]; return first && String(x.name).includes(first) ? (a.includes('→') ? 'يرد من ' + a.split('→')[1].trim() : '') : a; };
    for (const x0 of r.idents || []) { const x = { ...x0, fields: clean(x0.fields || []) }; h += `<div class="card"><b>${esc(x.name)}</b> <span class="mono dim">${esc(addrOf(x))}</span>${x.fields.length ? `<table>${x.fields.map(([k, val]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(val)}</td></tr>`).join('')}</table>` : '<div class="dim">ما رد على طلبات الهوية.</div>'}</div>`; }
    for (const x of m9) {
      const rows = [x.vin && ['رقم الهيكل (Mode 9)', x.vin], x.ecuName && ['اسم الكمبيوتر', x.ecuName], x.calid?.length && ['أرقام المعايرة (CALID)', x.calid.join(' · ')], x.cvn?.length && ['أرقام التحقق من البرمجة (CVN)', x.cvn.join(' · ')], x.esn && ['الرقم التسلسلي', x.esn]].filter(Boolean);
      h += `<div class="card"><b>معلومات Mode 9</b> <span class="mono dim">${esc(x.ecu)}</span><table>${rows.map(([k, val]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(val)}</td></tr>`).join('')}</table>${x.ipt?.length ? `<details><summary>عدّادات أداء الاختبارات (IPT)</summary><table>${x.ipt.map(i => `<tr><td class="mono">${esc(i.k)}</td><td class="mono">${i.v}</td></tr>`).join('')}</table></details>` : ''}</div>`;
    }
    h += '<div class="dim">أرقام المعايرة والتحقق تتغير مع كل برمجة/تيون — تفيد لو تبي تعرف هل الكمبيوتر مبرمج من جديد.</div>';
  }

  // ---------- 3. codes ----------
  h += '<h2>الأعطال خلال الجلسة</h2>';
  h += codes.length ? `<div class="card"><table><tr><th>الكود</th><th>الشرح</th><th>الحالة</th><th>الظهور</th><th>ملاحظة</th></tr>${codes.sort((a, b) => a.first - b.first).map(c => `<tr><td class="mono">${esc(c.code)}</td><td>${esc(c.text)}<div class="dim">${esc(c.modules.join('، '))}</div></td><td>${esc(c.kinds.map(k => KIND[k] || k).join('، '))}</td><td class="mono">${rel(c.first, t0)}<br>${rel(c.last, t0)}</td><td>${c.present ? '<span class="bad">موجود عند النهاية</span>' : '<span class="ok">اختفى</span>'}${c.gone.length > 1 || (c.gone.length && c.present) ? ` <span class="warn">رجع بعد المسح</span>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="card ok">ما ظهر أي كود عطل خلال الجلسة.</div>';

  // ---------- 4. analysis ----------
  if (r.analysis?.items?.length) {
    h += '<h2>تحليل الأعطال (ميكانيك · كهرباء · برمجة)</h2>';
    for (const sc of r.analysis.shared || []) h += `<div class="card warn">سبب مشترك محتمل: <b>${esc(sc.t)}</b> — ${esc(sc.why)}</div>`;
    for (const it of r.analysis.items) {
      const tot = Object.values(it.areas || {}).reduce((a, b) => a + b, 0) || 1;
      h += `<div class="card"><b>${esc(it.title)}</b> <span class="mono dim">${esc(it.codes.join(' '))}</span>${it.safety ? ' <span class="tag bad">سلامة</span>' : ''}
        <div class="bar">${Object.entries(it.areas || {}).filter(([, x]) => x > 0.01).map(([a, x]) => `<i style="width:${Math.round(x / tot * 100)}%;background:${AREA[a][1]}"></i>`).join('')}</div>
        <table><tr><th>السبب</th><th>الزاوية</th><th>الترجيح</th></tr>${it.causes.map(c => `<tr><td>${esc(c.t)}${c.why ? `<div class="dim">${esc(c.why)}</div>` : ''}</td><td>${esc(AREA[c.area]?.[0] || '')}</td><td>${Math.round(c.p * 100)}%</td></tr>`).join('')}</table>
        ${(() => { const ev = [...(it.evidence || []), ...catEvidence(r, it.codes)]; return ev.length ? `<div class="dim" style="margin-top:6px">الأدلة: ${esc(ev.join(' · '))}</div>` : ''; })()}
        ${it.path?.length ? `<div class="dim">الدائرة${it.loc ? ` (${esc(it.loc)})` : ''}: ${esc(it.path.map(p => p.pin && p.pin !== p.label ? `${p.label} = ${p.pin}` : p.label).join(' · '))}</div>` : ''}</div>`;
    }
    h += '<div class="dim">النسب ترجيحية؛ الحكم النهائي من الفحص على السيارة («ابدأ الفحص على السيارة» في محلّل الأعطال).</div>';
  }
  if (r.verdicts?.length) {
    h += '<h2>نتائج الفحص الموجّه على السيارة</h2>';
    for (const d of r.verdicts) h += `<div class="card"><b>${esc(d.title)}</b> <span class="dim">${rel(d.t, t0)}</span><div>النتيجة (${esc(AREA[d.area]?.[0] || '')}): <b>${esc(d.verdict)}</b></div><div class="dim">الإصلاح: ${esc(d.fix || '')}</div>${d.steps?.length ? `<ol class="dim">${d.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}</div>`;
  }

  // ---------- 5. every value ----------
  const all = (S.series || []);
  h += `<h2>كل القراءات الحية (${all.length})</h2><div class="dim">${all.filter(x => x.gm).length ? `منها ${all.filter(x => x.gm).length} قراءة خاصة بجنرال موتورز (مكتوب جنبها «GM»: «موثّقة» = مؤكدة من أكثر من مصدر، «تقديرية» = مقياسها من مصدر واحد). ` : ''}«الطبيعي» = الحد المرجعي العام، والحكم يُحسب فقط وقت تحقق شرطه (المكينة شغالة/حارّة).</div><div class="card"><table><tr><th>القيمة</th><th>أدنى–أعلى</th><th>متوسط</th><th>آخر</th><th>الطبيعي</th><th>الحكم</th></tr>`;
  for (const s of all) {
    if (s.text) { h += `<tr><td>${esc(nameOf(s))}<div class="dim">${esc(who(s.ecu))} · ${s.n} عينة</div>${descOf(s) ? `<div class="dim">${esc(descOf(s))}</div>` : ''}</td><td colspan="4">${esc(s.values.join(' ← '))}</td><td class="dim">حالات</td></tr>`; continue; }
    const j = !s.range ? '<span class="dim">بدون حد مرجعي</span>' : !s.judged ? '<span class="dim">ما توفّر الشرط</span>' : s.bad ? `<span class="bad">${Math.round(s.bad / s.judged * 100)}% خارج الحد</span>` : s.warn ? `<span class="warn">${Math.round(s.warn / s.judged * 100)}% قرب الحد</span>` : '<span class="ok">ضمن الطبيعي</span>';
    h += `<tr><td>${esc(nameOf(s))} <span class="dim">${esc(s.unit)}</span>${s.gm ? ` <span class="tag">GM · ${s.conf === 'best' ? 'موثّقة' : 'تقديرية'}</span>` : ''}<div class="dim">${esc(who(s.ecu))} · ${s.n} عينة${descOf(s) ? ' — ' + esc(descOf(s)) : ''}${s.pid === 0x42 && s.range?.rvc ? ' — نظام الشحن RVC: 12.6–13.1V على البطارية بدون أحمال طبيعي' : ''}</div></td><td class="mono">${n2(s.min)}–${n2(s.max)}</td><td class="mono">${n2(s.avg)}</td><td class="mono">${n2(s.last)}</td><td class="mono">${rangeOf(s)}</td><td>${j}</td></tr>`;
  }
  h += '</table></div>';
  const order = new Map((S.series || []).map((x, k) => [x.k, k]));
  const numeric = Object.entries(r.series || {}).filter(([k, s]) => !s.text && s.pts.length > 1 && order.has(k)).sort((a, b) => order.get(a[0]) - order.get(b[0])).map(([, s]) => s);
  const moving = numeric.filter(s => s.pts.some(p => p[1] !== s.pts[0][1])), still = numeric.filter(s => !moving.includes(s));
  if (moving.length) h += `<h2>الرسوم — كل قيمة على مدى الجلسة</h2><div class="charts">${moving.map((s, k) => `<div class="ch"><div class="dim">${esc(label(s))}</div>${chart(s.pts, t0, t1, COLORS[k % COLORS.length], s.unit)}</div>`).join('')}</div>`;
  if (still.length) h += `<div class="card dim">قيم ما تغيّرت طول الجلسة: ${still.map(s => `${esc(nameOf(s))}${s.ecu !== '7E8' ? ` (${esc(who(s.ecu))})` : ''} = <span class="mono">${n2(s.pts[0][1])} ${esc(s.unit)}</span>`).join(' · ')}</div>`;

  // ---------- time table of the key values ----------
  const cols = [[0x0c, 'الدوران'], [0x0d, 'السرعة'], [0x05, 'الحرارة'], [0x04, 'الحِمل'], [0x07, 'خلطة ب1'], [0x09, 'خلطة ب2'], [0x10, 'MAF'], [0x0e, 'الشرارة'], ['221470', 'ضغط الزيت'], ['221940', 'حرارة القير'], ['22199A', 'الغيار']]
    .map(([p, n]) => [Object.values(r.series || {}).filter(x => x.pid === p && !x.text).sort((a, b) => (b.ecu === '7E8') - (a.ecu === '7E8') || b.pts.length - a.pts.length)[0], n]).filter(([x]) => x);
  if (cols.length && t1 - t0 > 20000) {
    const step = t1 - t0 > 3 * 3600e3 ? 60000 : t1 - t0 > 3600e3 ? 30000 : 15000;
    const valAt = (x, t) => { let best = null; for (const p of x.pts) { if (p[0] > t) break; best = p; } return best && t - best[0] <= Math.max(15000, step) ? best[1] : null; };
    // the voltage column: the engine computer's own reading when the adapter's is frozen, never a stale number
    const ecmV = Object.values(r.series || {}).find(x => x.pid === 0x42 && x.ecu === '7E8' && !x.text);
    const vv = S.vFrom === 'ecm' && ecmV ? ecmV.pts : (r.volt || []);
    const vAt = t => { let b = null; for (const p of vv) { if (p[0] > t) break; b = p; } return b && t - b[0] <= Math.max(15000, step) ? b[1] : null; };
    h += `<h2>جدول زمني للقراءات الأساسية (كل ${step / 1000} ثانية)</h2><div class="card"><table><tr><th>الوقت</th>${cols.map(([, n]) => `<th>${n}</th>`).join('')}<th>${S.vFrom === 'ecm' ? 'فولت الكمبيوتر' : 'الفولت'}</th></tr>`;
    const tFirst = Math.min(...cols.map(([x]) => x.pts[0]?.[0] || t1));
    let empty = null;
    const flush = () => {
      if (!empty) return;
      h += empty[1] > empty[0] ? `<tr><td class="mono">${rel(empty[0], t0)}</td><td colspan="${cols.length + 1}" class="warn">— ما فيه قراءة من ${rel(empty[0], t0)} إلى ${rel(empty[1], t0)} (${dur(empty[1] - empty[0] + step)}) —</td></tr>`
        : `<tr><td class="mono">${rel(empty[0], t0)}</td>${cols.map(() => '<td class="mono">—</td>').join('')}<td class="mono">—</td></tr>`;
      empty = null;
    };
    for (let t = t0 + Math.max(0, Math.floor((tFirst - t0) / step)) * step; t <= t1; t += step) {
      const vals = cols.map(([x]) => valAt(x, t)), vt = vAt(t);
      if (vals.every(x => x == null) && vt == null) { if (empty) empty[1] = t; else empty = [t, t]; continue; }
      flush();
      h += `<tr><td class="mono">${rel(t, t0)}</td>${vals.map(x => `<td class="mono">${n2(x)}</td>`).join('')}<td class="mono">${n2(vt)}</td></tr>`;
    }
    flush();
    h += '</table></div>';
  }

  // ---------- 6. charging ----------
  h += '<h2>البطارية والشحن</h2><div class="card">';
  if (S.atrvFlat != null) h += `<div class="warn">فولت القطعة ثابت على ${n2(S.atrvFlat)}V طول الجلسة — القطعة ما تقيس الفولت فعليًا، فالأرقام هنا من كمبيوتر المكينة.</div>`;
  h += `<div>والمكينة شغالة: ${S.vRunMin != null ? `${n2(S.vRunMin)}–${n2(S.vRunMax)}V${S.vRunAvg != null ? ` (متوسط ${n2(S.vRunAvg)}V)` : ''}` : '—'} · والمكينة طافية: ${S.vOffMin != null ? `${n2(S.vOffMin)}–${n2(S.vOffMax)}V` : '—'} <span class="dim">(${S.vFrom === 'ecm' ? 'من كمبيوتر المكينة' : 'من القطعة'})</span></div>`;
  if (S.ecmV) h += `<div class="dim">كمبيوتر المكينة والمكينة شغالة: ${n2(S.ecmV.min)}–${n2(S.ecmV.max)}V · أول الجلسة ${n2(S.ecmV.firstAvg)}V · آخرها ${n2(S.ecmV.lastAvg)}V${S.ecmV.slope10 != null ? ` · الاتجاه ${S.ecmV.slope10 >= 0 ? '+' : ''}${n2(S.ecmV.slope10)}V كل 10 دقائق` : ''}</div>`;
  if (rvcCar) h += '<div class="dim">جنرال موتورز (RVC): 12.6–13.1V على البطارية بدون أحمال طبيعي (والكمبيوتر يقرا أقل بشوي)، وتحت الحِمل يرتفع ~13.9–14.5V.</div>';
  const vChart = S.vFrom === 'ecm' ? Object.values(r.series || {}).find(x => x.pid === 0x42 && x.ecu === '7E8' && !x.text)?.pts : r.volt;
  if (vChart?.length > 1) h += `<div class="ch" style="margin-top:6px"><div class="dim">${S.vFrom === 'ecm' ? 'فولت كمبيوتر المكينة' : 'فولت البطارية من القطعة'}</div>${chart(vChart, t0, t1, '#ffb547', 'V')}</div>`;
  const pc = x => x == null ? 'ما توفّر' : n2(x) + '%';
  if (r.trims) h += `<div class="dim" style="margin-top:6px">تعديل الوقود الكلي (قصير+طويل): خمول بنك1 ${pc(r.trims.idle1)} · سير بنك1 ${pc(r.trims.cruise1)}${r.trims.hasBank2 ? ` · خمول بنك2 ${pc(r.trims.idle2)} · سير بنك2 ${pc(r.trims.cruise2)}` : ''}${r.trims.pattern === 'vacuum' ? ' — النمط يشبه تسريب هواء (فقير على الخمول ويتحسن مع الدوران)' : r.trims.pattern === 'delivery' ? ' — النمط يشبه ضعف وقود/MAF (يزيد الفقر مع الحِمل)' : ''}</div>`;
  h += '</div>';

  // ---------- 7. scans ----------
  const scans = r.scans || [];
  h += `<h2>الفحوصات (${scans.length})</h2>`;
  const lastScan = scans[scans.length - 1] || r.final;
  for (const s of scans) h += `<div class="card"><b>فحص ${rel(s.t, t0)}</b> — ${s.dtcs.length} عطل${s.dtcs.length ? `: <span class="mono">${esc(s.dtcs.map(d => d.code).join(' '))}</span>` : ''} · فولت ${s.voltage ? n2(s.voltage) + 'V' : '—'}</div>`;
  if (lastScan) {
    h += `<h3>الكمبيوترات (آخر حالة)</h3><div class="card"><table><tr><th>الكمبيوتر</th><th>العنوان</th><th>الحالة</th><th>الأكواد</th></tr>${(lastScan.ecus || []).map(e => { const cs = [...['stored', 'pending', 'perm'].flatMap(k => (e.dtcs?.[k] || [])), ...(e.dtcs?.mfr || []).map(d => d.code)]; return `<tr><td>${esc(e.name)}</td><td class="mono">${esc(e.addr || '')}</td><td>${esc({ ok: 'سليم', fault: 'فيه عطل', noresp: 'لا يرد', unreach: 'خارج الوصول', partial: 'قراءة محدودة' }[e.status] || e.status || '')}</td><td class="mono">${esc([...new Set(cs)].join(' '))}</td></tr>`; }).join('')}</table></div>`;
    const rd = (lastScan.readiness || []).filter(x => x && Array.isArray(x.mons));
    if (rd.length) {
      const a = combineReadiness(rd.map(x => [x.ecu, x])), st = readinessStats(a);
      h += `<h3>الجاهزية (اختبارات الانبعاثات)</h3><div class="card">لمبة المكينة: ${a.mil ? '<span class="bad">مضاءة</span>' : '<span class="ok">مطفأة</span>'}${a.dtcCount != null ? ` · عدد الأكواد حسب الكمبيوتر: ${a.dtcCount}` : ''} · المكتمل ${st.ready}/${st.total}${st.notReady.length ? ` · غير جاهز: ${esc(st.notReady.map(x => x.name).join('، '))}` : ''}</div>`;
      for (const x of rd) h += `<div class="card"><b>${esc(x.ecu)}</b>${x.mil != null ? ` — اللمبة ${x.mil ? '<span class="bad">مضاءة</span>' : '<span class="ok">مطفأة</span>'}` : ''}<table>${x.mons.map(mo => `<tr><td>${esc(mo.name)}</td><td>${!mo.sup ? '<span class="dim">غير موجود</span>' : mo.ready ? '<span class="ok">مكتمل</span>' : '<span class="warn">غير مكتمل</span>'}</td></tr>`).join('')}</table></div>`;
    }
    const ff = (lastScan.freeze || []).filter(f => f.items?.length);
    if (ff.length) h += `<h3>لقطة اللحظة (Freeze Frame)</h3>${ff.map(f => `<div class="card"><b>${esc(f.dtc || 'بدون كود محدد')}</b> <span class="mono dim">${esc(f.ecu)}</span><table>${f.items.map(i => `<tr><td>${esc(i.name)}</td><td class="mono">${esc(i.text)} ${esc(i.unit || '')}</td></tr>`).join('')}</table></div>`).join('')}`;
    const m6 = (lastScan.mode06 || []).flatMap(x => (x.rows || []).map(row => ({ ...row, ecu: x.ecu })));
    if (m6.length) {
      // a test that has not run since the codes were cleared reads all zeros — that is not a pass
      const row = x => { const st = m6State(x), [c, t] = M6_LABEL[st]; return `<tr><td>${esc(x.midName || '')} ${esc(x.tidName || '')}</td><td class="mono">${st === 'notrun' ? '—' : `${n2(x.value)} ${esc(x.unit || '')}`}</td><td class="mono">${st === 'notrun' ? '—' : `${n2(x.min)}–${n2(x.max)}`}</td><td><span class="${c}">${t}</span></td></tr>`; };
      const real = m6.filter(x => ['pass', 'fail'].includes(m6State(x))), rest = m6.filter(x => !real.includes(x));
      const nf = real.filter(x => m6State(x) === 'fail').length, nr = rest.filter(x => m6State(x) === 'notrun').length;
      h += `<h3>نتائج الاختبارات الذاتية (Mode 6)</h3><div class="card"><div>${real.length} اختبار اشتغل: ${nf ? `<span class="bad">${nf} راسب</span>` : '<span class="ok">كلها ناجحة</span>'}${nr ? ` · <span class="warn">${nr} ما اشتغل بعد</span> (الكمبيوتر ما أعاد الاختبار من آخر مسح للأكواد)` : ''}</div>`;
      if (real.length) h += `<table><tr><th>الاختبار</th><th>القيمة</th><th>الحد</th><th>النتيجة</th></tr>${real.map(row).join('')}</table>`;
      if (rest.length) h += `<details><summary>${rest.length} سطر ما اشتغل بعد أو قيمة معايرة ثابتة</summary><table><tr><th>الاختبار</th><th>القيمة</th><th>الحد</th><th>الحالة</th></tr>${rest.map(row).join('')}</table></details>`;
      h += '</div>';
    }
  }

  // ---------- 8. timeline ----------
  h += `<h2>سجل الأحداث (${(r.events || []).length})</h2><div class="card" style="max-height:600px;overflow:auto"><table><tr><th>الوقت</th><th></th><th>الحدث</th></tr>${(r.events || []).map(e => `<tr><td class="mono">${clock(e.t)}</td><td class="mono dim">${rel(e.t, t0)}</td><td class="${e.kind || ''}">${esc(e.text)}</td></tr>`).join('')}</table></div>`;

  // ---------- 9. adapter log ----------
  h += `<h2>سجل القطعة</h2><div class="card">إجمالي سطور الاتصال: ${r.logCount || 0}${Object.keys(r.logErr || {}).length ? ` · ردود: ${esc(Object.entries(r.logErr).map(([k, n]) => `${k}×${n}`).join('، '))}<div class="dim">«NO DATA» أثناء مسح العناوين عادي: معناه ما فيه كمبيوتر على العنوان اللي انسأل.</div>` : ' · بدون ردود خطأ'}
    ${(() => { const fmt = L => esc(L.map(([t, l]) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}  ${l}`; }).join('\n'));
      const head = r.logHead || [], tail = r.log || [], skipped = (r.logCount || 0) - head.length - tail.length;
      return (head.length ? `<details><summary>أول ${head.length} سطر (الاتصال والفحص)</summary><div class="log">${fmt(head)}</div></details>` : '')
        + (tail.length ? `<details><summary>${head.length ? `آخر ${tail.length} سطر${skipped > 0 ? ` (بينهم ${skipped} سطر قراءة متكررة ما انحفظت)` : ''}` : `آخر ${tail.length} سطر`}</summary><div class="log">${fmt(tail)}</div></details>` : ''); })()}</div>`;

  // ---------- what could not be read ----------
  h += `<h2>حدود القراءة</h2><div class="card"><ul>
    <li>كمبيوترات الشبكة البطيئة (طرف 1 في فيش الفحص) — في شاحنات جنرال موتورز: الوسائد الهوائية، العدادات، المكيف، الراديو، منع السرقة — ما يوصلها محوّل ELM327، فأكوادها وقراءاتها غير موجودة هنا (يحتاج قطعة فيها SW-CAN).</li>
    <li>حساس تيار البطارية على الكيبل السالب يقراه كمبيوتر الهيكل فقط ولا يطلع على الفيش.</li>
    <li>القراءات تُسجّل بالتناوب: الأساسية تقريبًا كل ثانية والباقي كل عدة ثوانٍ، وتُحفظ القيمة عند تغيّرها أو كل 5 ثوانٍ.</li>
    ${r.gmCount != null ? `<li>قراءات جنرال موتورز الخاصة اللي ردّت عليها السيارة: ${r.gmCount}. اللي ما ردّت عليه السيارة ما يظهر.</li>` : ''}
    <li>إذا انقفلت الشاشة أو انقطع البلوتوث يتوقف التسجيل وقتها (يظهر في سجل الأحداث).</li></ul></div>`;

  // ---------- 10. raw data ----------
  const rows = ['time_iso,elapsed_s,ecu,pid,name,value,unit'];
  for (const s of Object.values(r.series || {})) for (const [t, x] of s.pts) rows.push(`${new Date(t).toISOString()},${((t - t0) / 1000).toFixed(1)},${s.ecu},${typeof s.pid === 'number' ? '0x' + s.pid.toString(16).padStart(2, '0') : s.pid},"${String(s.name).replace(/"/g, '""')}",${typeof x === 'number' ? x : `"${String(x).replace(/"/g, '""')}"`},${s.unit || ''}`);
  for (const [t, x] of r.volt || []) rows.push(`${new Date(t).toISOString()},${((t - t0) / 1000).toFixed(1)},adapter,volt,"فولت البطارية",${x},V`);
  const csv = '﻿' + rows.join('\n');
  let b64 = ''; try { b64 = btoa(unescape(encodeURIComponent(csv))); } catch {}
  h += `<h2>البيانات الخام</h2><div class="card">${rows.length - 1} قراءة مسجّلة.${b64 ? ` <a class="dl" download="session-data-${new Date(t0).toISOString().slice(0, 10)}.csv" href="data:text/csv;charset=utf-8;base64,${b64}">تنزيل كل البيانات CSV</a>` : ''}<div class="dim">يفتح في Excel أو Google Sheets.</div></div>`;
  return h + `<div class="dim" style="margin:24px 0">أُنشئ بواسطة «فني السيارة» — ${fmtDate(Date.now())}</div></div></body></html>`;
}

// Show a report inside the app (an in-app viewer works in every browser, including Bluefy).
export function openReport(html, onShare) {
  const old = document.getElementById('repViewer'); old?.remove();
  const d = document.createElement('div');
  d.id = 'repViewer'; d.className = 'rep-viewer';
  d.innerHTML = `<div class="rep-bar"><b>التقرير</b><span class="sp" style="flex:1"></span>${onShare ? '<button class="btn sm primary" data-share>مشاركة / حفظ</button>' : ''}<button class="btn sm" data-close>إغلاق</button></div><iframe title="التقرير"></iframe>`;
  document.body.appendChild(d);
  d.querySelector('iframe').srcdoc = html;
  // closes with its button, Escape, or when the person moves to another page
  const close = () => { d.remove(); removeEventListener('hashchange', close); removeEventListener('keydown', esc1); };
  const esc1 = e => { if (e.key === 'Escape') close(); };
  addEventListener('hashchange', close); addEventListener('keydown', esc1);
  d.querySelector('[data-close]').onclick = close;
  d.querySelector('[data-share]')?.addEventListener('click', onShare);
}
