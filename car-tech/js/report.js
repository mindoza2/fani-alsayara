// Standalone HTML reports (open anywhere, no internet needed).
import { esc, fmtDate, fmtTime } from './util.js';
import { describeDtc } from './dtcdb.js';

const CSS = `body{font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif;background:#0a101a;color:#e6eefb;margin:0;padding:24px;line-height:1.6}
.w{max-width:900px;margin:0 auto}h1{font-size:22px;margin:0}h2{font-size:17px;border-bottom:1px solid #22324d;padding-bottom:6px;margin-top:26px}
.card{background:#111b2c;border:1px solid #22324d;border-radius:14px;padding:14px 16px;margin:10px 0}.mono{font-family:Consolas,monospace;direction:ltr;display:inline-block}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 8px;border-bottom:1px solid #1a263b;text-align:start;vertical-align:top}th{color:#8394ad;font-weight:500}
.ok{color:#33e39b}.bad{color:#ff5468}.warn{color:#ffb547}.dim{color:#8394ad;font-size:13px}.tag{display:inline-block;font-size:11px;border:1px solid #3a4b68;border-radius:6px;padding:0 6px;margin-inline-start:6px}
.demo{background:#2a1d4a;border:1px solid #6b4fc9;border-radius:10px;padding:8px 12px;margin:10px 0}
@media print{body{background:#fff;color:#000}.card{background:#fff;border-color:#ccc}}`;
const CONF = { sure: 'موثوق', best: 'أفضل جهد', est: 'تقديري' };
const head = (title, demo) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="w">
<h1>${esc(title)}</h1><div class="dim">أُنشئ بواسطة «فني السيارة» — ${fmtDate(Date.now())}</div>${demo ? '<div class="demo">⚠ هذا التقرير من الوضع التجريبي ببيانات نموذجية وليس من سيارة حقيقية.</div>' : ''}`;
const vehicle = v => `<div class="card"><b>${esc([v?.make, v?.model, v?.year].filter(Boolean).join(' ') || 'سيارة غير محددة')}</b>${v?.vin ? ` — VIN <span class="mono">${esc(v.vin)}</span>` : ''}${v?.engine ? ` — ${esc(v.engine)}` : ''}</div>`;

export function scanReportHtml(s, diag = []) {
  const K = { stored: 'مخزّن', pending: 'معلّق', perm: 'دائم', history: 'سابق' };
  let h = head('تقرير فحص السيارة', s.demo) + vehicle(s.vehicle);
  h += `<div class="card">تاريخ الفحص: ${fmtDate(s.t)} · البروتوكول: ${esc(s.protocol || '—')} · فولت البطارية: ${s.voltage ? s.voltage.toFixed(2) + 'V' : '—'}</div>`;
  h += `<h2>ملخّص</h2><div class="card">إجمالي الأعطال: <b class="${s.dtcs.length ? 'bad' : 'ok'}">${s.dtcs.length}</b> · الكمبيوترات التي ترد: ${s.ecus.filter(e => !['noresp', 'unreach'].includes(e.status)).length}</div>`;
  h += '<h2>الكمبيوترات والأعطال</h2>';
  for (const e of s.ecus) {
    const codes = [...['stored', 'pending', 'perm'].flatMap(k => (e.dtcs?.[k] || []).map(c => ({ c, k }))), ...(e.dtcs?.mfr || []).map(d => ({ c: d.code, k: d.kind, mfr: true }))];
    const st = { ok: '<span class="ok">سليم</span>', fault: '<span class="bad">فيه عطل</span>', noresp: '<span class="dim">لا يرد</span>', unreach: '<span class="dim">خارج الوصول</span>', partial: '<span class="warn">يرد — قراءة محدودة</span>' }[e.status] || '';
    h += `<div class="card"><b>${esc(e.name)}</b> <span class="mono dim">${esc(e.addr || '')}</span> — ${st} <span class="tag">${CONF[e.conf] || ''}</span>`;
    if (codes.length) h += `<table><tr><th>الكود</th><th>الحالة</th><th>الشرح</th></tr>${codes.map(x => { const d = describeDtc(x.c); return `<tr><td class="mono">${esc(x.c)}</td><td>${K[x.k] || x.k}${x.mfr ? ' (المصنّع)' : ''}</td><td>${esc(d.text)} <span class="tag">${CONF[d.conf]}</span></td></tr>`; }).join('')}</table>`;
    if (e.note) h += `<div class="dim">${esc(e.note)}</div>`;
    if (e.readError) h += `<div class="warn">${esc(e.readError)}</div>`;
    h += '</div>';
  }
  if (s.readiness?.length) {
    h += '<h2>الجاهزية</h2>';
    for (const r of s.readiness) h += `<div class="card">لمبة المكينة: ${r.mil ? '<span class="bad">مضاءة</span>' : '<span class="ok">مطفأة</span>'}<table>${r.mons.map(m => `<tr><td>${esc(m.name)}</td><td>${!m.sup ? '<span class="dim">غير مدعوم</span>' : m.ready ? '<span class="ok">جاهز</span>' : '<span class="warn">غير جاهز</span>'}</td></tr>`).join('')}</table></div>`;
  }
  if (s.freeze?.some(f => f.items?.length)) {
    h += '<h2>لقطة الحظة</h2>';
    for (const f of s.freeze.filter(f => f.items?.length)) h += `<div class="card">الكود: <span class="mono">${esc(f.dtc || '?')}</span><table>${f.items.map(i => `<tr><td>${esc(i.name)}</td><td class="mono">${esc(i.text)} ${esc(i.unit || '')}</td></tr>`).join('')}</table></div>`;
  }
  if (diag.length) {
    h += '<h2>التشخيص الموجّه (ترجيح)</h2>';
    for (const d of diag.slice(0, 5)) h += `<div class="card"><b>${esc(d.title)}</b> <span class="tag">تقديري</span><div class="dim">${d.evidence.map(esc).join(' · ')}</div><ul>${d.causes.map(c => `<li>${esc(c.t)} — ${Math.round(c.p * 100)}%</li>`).join('')}</ul><ol>${d.steps.map(x => `<li>${esc(x.t)}<div class="dim">القياس: ${esc(x.m)} · المتوقع: ${esc(x.e)}</div></li>`).join('')}</ol></div>`;
  }
  if (s.photos?.length) h += '<h2>صور موثّقة</h2>' + s.photos.map(p => `<div class="card"><img src="${p.data}" style="max-width:100%;border-radius:10px"><div>${esc(p.note || '')}</div></div>`).join('');
  h += `<p class="dim">مستويات الثقة: «موثوق» = قراءة حية أو معيار OBD، «أفضل جهد» = مكتبة مرجعية/بروتوكول المصنّع، «تقديري» = ترجيح ذكي يحتاج تأكيد. مسح الأعطال لا يصلحها.</p></div></body></html>`;
  return h;
}
export function tripReportHtml(t) {
  let h = head('تقرير ' + (t.name || 'المشوار'), t.demo) + vehicle(t.vehicle);
  h += `<div class="card">التاريخ: ${fmtDate(t.t)} · المدة: ${fmtTime(t.dur || 0)} · عدد العينات: ${t.samples?.length || 0}</div>`;
  if (t.verdict) h += `<h2>النتيجة</h2><div class="card"><b class="${t.verdict.ok ? 'ok' : 'warn'}">${t.verdict.ok ? 'سليم' : 'يحتاج انتباه'}</b><ul>${t.verdict.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul><div class="dim">مبنية على القراءات المسجّلة (أفضل جهد)</div></div>`;
  h += `<h2>الخط الزمني</h2><div class="card"><table>${(t.events || []).map(e => `<tr><td class="mono">${fmtTime(e.t - t.t)}</td><td class="${e.kind === 'bad' ? 'bad' : e.kind === 'warn' ? 'warn' : ''}">${esc(e.text)}</td></tr>`).join('')}</table></div>`;
  const sm = t.samples || [];
  if (sm.length > 2) {
    const series = [['rpm', 'الدوران', '#3de0ff'], ['volt', 'الفولت', '#ffb547'], ['ltft1', 'خلطة طويلة ب1', '#a57bff']].filter(([k]) => sm.some(s => s[k] != null));
    h += '<h2>الرسوم</h2>';
    for (const [k, n, col] of series) {
      const v = sm.map(s => s[k]).filter(x => x != null); const mn = Math.min(...v), mx = Math.max(...v), sp = mx - mn || 1;
      const pts = sm.filter(s => s[k] != null).map((s, i, a) => `${(i / (a.length - 1) * 860).toFixed(1)},${(150 - (s[k] - mn) / sp * 140).toFixed(1)}`).join(' ');
      h += `<div class="card"><div>${n} <span class="dim">(${mn.toFixed(1)} – ${mx.toFixed(1)})</span></div><svg viewBox="0 0 860 155" style="width:100%"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"/></svg></div>`;
    }
  }
  return h + '</div></body></html>';
}
