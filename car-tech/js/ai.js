// "اسأل الفني": hybrid — Claude API (user's own key, stored locally) when online,
// otherwise a small built-in rule model + the library of previously saved answers.
import { store, settings } from './store.js';
import { session } from './session.js';
import { describeDtc } from './dtcdb.js';
import { correlate } from './diag.js';
import { uid } from './util.js';
import { chargeRange } from './obd.js';
import { analyze, analysisCtx, analysisText } from './analyst.js';

const SYSTEM = `أنت «فني السيارة»: مختص تشخيص سيارات يجمع ثلاث خبرات: ميكانيكي، وكهربائي سيارات، ومبرمج كمبيوترات سيارات. تتكلم العربية بوضوح وباختصار عملي.
- استخدم بيانات السيارة المرفقة (الأعطال، الجاهزية، القيم الحية، تحليل المحلّل، ودائرة كل عطل من مخطط السيارة) كأدلة، واذكر الدليل اللي اعتمدت عليه.
- لكل عطل: حدّد السبب الجذري ومن أي زاوية هو (كهرباء / ميكانيك / برمجة / تعديل بالسيارة)، واشرح ليش، ورجّح بدل ما تشرح كل كود لحاله.
- استخدم أسماء الأسلاك والفيوزات ونقاط الأرضي الموجودة في «الدائرة» كما هي، ولا تخترع أرقام أطراف أو ألوان غير المذكورة؛ إذا ما تعرف قل ذلك.
- انتبه لتعديلات السيارة (سواب المكينة، التيون، الأنظمة الملغاة، القواطع): كثير من الأكواد بعدها سببها البرمجة أو التعديل وليس قطعة تالفة.
- أعطِ خطوات فحص مرتبة من الأرخص والأسهل، مع نقطة القياس والقيمة المتوقعة ومعنى كل نتيجة.
- نبّه على السلامة (الوسائد الهوائية، الوقود، المراوح، ضغط الزيت المنخفض، الفولت العالي في الهجين).
- مسح لمبة التحذير لا يصلح العطل.`;

export function aiAvailable() {
  const s = settings();
  return { online: navigator.onLine, key: !!s.apiKey, on: s.aiOn, ready: navigator.onLine && !!s.apiKey && s.aiOn };
}
export function buildContext(app) {
  const v = app.vehicle || {};
  const lines = [];
  lines.push(`السيارة: ${[v.make, v.model, v.year].filter(Boolean).join(' ') || 'غير محددة'}${v.vin ? ' — VIN ' + v.vin : ''}${v.engine ? ' — المكينة ' + v.engine : ''}`);
  if (app.demo) lines.push('(تنبيه: البيانات الحالية من الوضع التجريبي وليست من سيارة حقيقية)');
  const d = app.allDtcs();
  lines.push(d.length ? 'الأعطال: ' + d.map(x => `${x.code} (${x.kindLabel}، ${x.module}) — ${describeDtc(x.code).text}`).join('؛ ') : 'الأعطال: لا يوجد (أو لم يُفحص بعد)');
  const r = app.readinessSummary?.();
  if (r) lines.push('الجاهزية: ' + r);
  const live = app.liveSnapshot?.();
  if (live?.length) lines.push('قيم حية: ' + live.map(x => `${x.name}=${x.text}${x.unit}`).join('، '));
  if (app.conn.voltage) lines.push(`فولت البطارية: ${app.conn.voltage.toFixed(2)}V${app.conn.voltSrc === 'ecm' ? ' (من كمبيوتر المكينة — القطعة تعطي رقم ثابت ما يتغير)' : ''}`);
  try { const F = session.findings(); if (F.length) lines.push('ما تقوله القراءات الحية في الجلسة: ' + F.map(f => `${f.t} — ${f.d}`).join(' | ')); } catch {}
  const cr = chargeRange(v);
  if (cr.rvc) lines.push('نظام الشحن: ' + cr.note);
  // the analyst's findings, with each fault's circuit from the car's own wiring
  try { const t = analysisText(analyze(analysisCtx(app))); if (t) lines.push('تحليل المحلّل (ترجيحي):\n' + t); } catch (e) { console.warn(e); }
  return lines.join('\n');
}
export async function askClaude(q, ctx, history = []) {
  const s = settings();
  const messages = [...history.slice(-6).flatMap(h => [{ role: 'user', content: h.q }, { role: 'assistant', content: h.a }]), { role: 'user', content: `بيانات السيارة الحالية:\n${ctx}\n\nالسؤال: ${q}` }];
  // a weak mobile connection must not leave the question waiting forever
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: s.model, max_tokens: 2500, system: SYSTEM, messages }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); msg = j.error?.message || msg; } catch {}
      if (r.status === 401) msg = 'مفتاح API غير صحيح أو موقوف';
      if (r.status === 429) msg = 'تجاوزت حد الاستخدام مؤقتًا';
      if (r.status === 400 && /credit|balance/i.test(msg)) msg = 'رصيد حساب API غير كافٍ';
      throw new Error(msg);
    }
    const j = await r.json();
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (!text) throw new Error('وصل رد فارغ من Claude');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('لم يصل رد من Claude خلال 90 ثانية');
    if (e instanceof TypeError) throw new Error('تعذّر الوصول إلى خادم Claude (الإنترنت أو الشبكة)');
    throw e;
  } finally { clearTimeout(timer); }
}
const norm = s => s.replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[^\p{L}\p{N}\s]/gu, ' ').toLowerCase();
const toks = s => new Set(norm(s).split(/\s+/).filter(w => w.length > 2));
function sim(a, b) { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach(w => B.has(w) && n++); return n / Math.sqrt(A.size * B.size); }

export async function localAnswer(q, app) {
  const codes = [...new Set((q.toUpperCase().match(/[PCBU][0-9][0-9A-F]{3}/g) || []))];
  const parts = [];
  if (codes.length) {
    for (const c of codes) { const d = describeDtc(c); parts.push(`• ${c}: ${d.text} [${d.conf === 'sure' ? 'موثوق' : d.conf === 'best' ? 'أفضل جهد' : 'تقديري'}]`); }
    const cor = correlate({ dtcs: codes.map(code => ({ code })), live: {}, trims: null });
    if (cor[0]) parts.push(`\nالترجيح: ${cor[0].title}\n` + cor[0].causes.map(c => `  - ${c.t} (${Math.round(c.p * 100)}%)`).join('\n') + '\nخطوات:\n' + cor[0].steps.map((s, i) => `  ${i + 1}. ${s.t} — القياس: ${s.m} — المتوقع: ${s.e}`).join('\n'));
  }
  const nq = norm(q);
  if (/جاهزي|فحص دوري|readiness/.test(nq) && app.readinessSummary?.()) parts.push('الجاهزية الحالية: ' + app.readinessSummary());
  if (/بطاري|فولت|شحن|دينمو/.test(nq) && app.conn.voltage) { const cr = chargeRange(app.vehicle); parts.push(`فولت البطارية الآن ${app.conn.voltage.toFixed(2)}V. الطبيعي: طافية 12.4–12.7V، شغالة ${cr.rvc ? cr.note : '13.5–14.8V'}.`); }
  if (/اعطال|عطل|اكواد/.test(nq) && !codes.length) {
    const d = app.allDtcs();
    parts.push(d.length ? 'الأعطال المسجلة: ' + d.map(x => `${x.code} (${describeDtc(x.code).text})`).join('، ') : 'لا توجد أعطال مسجلة من آخر فحص.');
    const cor = correlate({ dtcs: d, live: app.liveValues?.() || {}, trims: app.trims?.(), charge: chargeRange(app.vehicle) });
    if (cor[0]) parts.push('الأرجح: ' + cor[0].title);
  }
  // saved library
  const lib = await store.all('ai');
  let best = null, bs = 0;
  for (const e of lib) { const s = sim(q, e.q); if (s > bs) { bs = s; best = e; } }
  if (best && bs >= 0.35) parts.push(`\nمن مكتبة الأجوبة المحفوظة (سؤال مشابه بتاريخ ${new Date(best.t).toLocaleDateString('ar-SA-u-ca-gregory-nu-latn')}):\n${best.a}`);
  if (!parts.length) parts.push('بدون اتصال بالإنترنت أو مفتاح Claude، أستطيع شرح الأكواد (اكتب الكود مثل P0171)، تلخيص الأعطال والجاهزية والفولت، والبحث في الأجوبة المحفوظة سابقًا. لم أجد شيئًا مطابقًا لسؤالك.');
  return parts.join('\n');
}
export async function saveAnswer(q, a, source, app) {
  const e = { id: uid(), t: Date.now(), q, a, source, vin: app.vehicle?.vin || null, codes: app.allDtcs().map(d => d.code) };
  if (source === 'claude') await store.put('ai', e);
  return e;
}
