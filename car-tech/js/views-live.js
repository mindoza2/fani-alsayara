// Live data, trip recorder / guided tests, predictive trends, phone sensors.
import { $, $$, esc, bus, toast, conf, fmtDate, fmtTime, uid, sleep, linreg, download, shareFile, confirmAction } from './util.js';
import { app, startLive, stopLive, requireConn } from './core.js';
import { PIDS, pidName, rangeStatus, VOLT_RANGES } from './obd.js';
import { pidGauge, updatePidGauge, drawChart, sparkline } from './widgets.js';
import { trimAnalysis } from './diag.js';
import { store, settings, saveSettings } from './store.js';
import { speak } from './nav.js';
import { tripReportHtml } from './report.js';

const COLORS = ['#3de0ff', '#ffb547', '#a57bff', '#33e39b', '#ff5468'];
const connected = () => app.conn.ready;
const notConn = c => { c.innerHTML = `<div class="card"><div class="empty"><div class="big">◔</div>اتصل بالسيارة أولًا (أو شغّل الوضع التجريبي) لعرض القيم.<div class="btn-row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="#/connect">الاتصال</a></div></div></div>`; };

/* =========================== Live data =========================== */
export function liveView(c) {
  if (!connected()) { notConn(c); const off = bus.on('conn', ({ state }) => state === 'on' && liveView(c)); return off; }
  const ecus = [...app.pidSupport.keys()];
  let ecu = app.primaryEcu();
  let gaugePids = [], chartPids = [], recording = null;
  const offs = [];
  const gs = {};
  const draw = () => {
    const sup = [...(app.pidSupport.get(ecu) || [])].filter(p => p % 0x20 !== 0 && p !== 0x01 && p !== 0x41 && p !== 0x02).sort((a, b) => a - b);
    gaugePids = settings().gauges.filter(p => sup.includes(p));
    if (!gaugePids.length) gaugePids = sup.filter(p => PIDS[p]?.[4] != null).slice(0, 6);
    if (!chartPids.length) chartPids = [0x0c, 0x07, 0x09].filter(p => sup.includes(p)).slice(0, 2);
    c.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row wrap">
      <label class="small muted">الكمبيوتر:</label><select id="lEcu" style="width:auto">${ecus.map(e => `<option value="${e}" ${e === ecu ? 'selected' : ''}>${esc(app.ecus.get('std:' + e)?.name || e)} (${app.pidSupport.get(e).size} قيمة)</option>`).join('')}</select>
      <span class="sp" style="flex:1"></span><span class="small dim">${sup.length} قيمة مكتشفة من الكمبيوتر ${conf('sure')}</span>
      <select id="lAdd" style="width:auto"><option value="">+ إضافة عدّاد</option>${sup.filter(p => !gaugePids.includes(p) && PIDS[p]?.[3]).map(p => `<option value="${p}">${esc(pidName(p))}</option>`).join('')}</select>
      <button class="btn ${recording ? 'danger' : ''}" id="lRec">${recording ? '■ إيقاف التسجيل' : '● تسجيل'}</button></div></div>
    <div class="gauges" id="lG"></div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>الرسم البياني</h2><span class="sp"></span><select id="lChart" style="width:auto"><option value="">+ قيمة للرسم</option>${sup.filter(p => PIDS[p]?.[3]).map(p => `<option value="${p}">${esc(pidName(p))}</option>`).join('')}</select></div>
        <div class="row wrap" id="lChips" style="gap:6px;margin-bottom:6px">${chartPids.map((p, i) => `<span class="badge" style="color:${COLORS[i]};border-color:${COLORS[i]}">${esc(pidName(p))} <a href="#" data-rm="${p}" style="color:inherit">✕</a></span>`).join('')}</div>
        <div class="chart-box"><canvas id="lCv"></canvas></div></div>
      <div class="card"><h2>خلطة الوقود (Fuel Trims)</h2><div id="lTrims"></div><h3 style="margin-top:14px">الشحن والفولت</h3><div id="lVolt"></div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>كل القيم التي يكشفها الكمبيوتر</h2><span class="sp"></span><span class="small dim">تُحدَّث دوريًا · مقارنة بالنطاق الطبيعي</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>القيمة</th><th>الآن</th><th>النطاق الطبيعي</th><th>الحالة</th></tr></thead><tbody id="lT">${sup.map(p => `<tr data-p="${p}"><td>${esc(pidName(p))} <span class="mono dim small">0x${p.toString(16).toUpperCase().padStart(2, '0')}</span>${PIDS[p] ? '' : ' ' + conf('est')}</td><td class="num v">--</td><td class="small">${PIDS[p]?.[7] ? `${PIDS[p][7].ok[0]} – ${PIDS[p][7].ok[1]} ${esc(PIDS[p][1])}` : '<span class="dim">—</span>'}</td><td class="s"></td></tr>`).join('')}</tbody></table></div></div>`;
    const gBox = $('#lG', c);
    for (const k in gs) delete gs[k];
    gaugePids.forEach(p => { const g = pidGauge(p, true); gs[p] = g; g.querySelector('.rm').onclick = () => { saveSettings({ gauges: settings().gauges.filter(x => x !== p).concat(settings().gauges.includes(p) ? [] : []) }); gaugePids = gaugePids.filter(x => x !== p); saveSettings({ gauges: gaugePids }); draw(); }; gBox.appendChild(g); });
    $('#lEcu', c).onchange = e => { ecu = e.target.value; chartPids = []; draw(); };
    $('#lAdd', c).onchange = e => { const p = +e.target.value; if (!p) return; saveSettings({ gauges: [...gaugePids, p] }); draw(); };
    $('#lChart', c).onchange = e => { const p = +e.target.value; if (p && !chartPids.includes(p)) chartPids = [...chartPids, p].slice(-3); draw(); };
    $$('[data-rm]', c).forEach(a => a.onclick = ev => { ev.preventDefault(); chartPids = chartPids.filter(x => x !== +a.dataset.rm); draw(); });
    $('#lRec', c).onclick = () => {
      if (recording) {
        const rows = recording; recording = null;
        const cols = [...new Set(rows.flatMap(r => Object.keys(r.v)))].map(Number);
        const csv = ['time,' + cols.map(p => `"${pidName(p)} (${PIDS[p]?.[1] || ''})"`).join(',') + ',battery_V', ...rows.map(r => [new Date(r.t).toISOString(), ...cols.map(p => r.v[p] ?? ''), r.volt ?? ''].join(','))].join('\n');
        download(`live-${Date.now()}.csv`, '﻿' + csv, 'text/csv');
        toast(`تم حفظ ${rows.length} قراءة كملف CSV`, 'ok');
      } else { recording = []; toast('بدأ التسجيل', 'ok'); }
      $('#lRec', c).textContent = recording ? '■ إيقاف التسجيل' : '● تسجيل'; $('#lRec', c).classList.toggle('danger', !!recording);
    };
    startLive({ fast: [...new Set([...gaugePids, ...chartPids, 0x06, 0x07, 0x08, 0x09, 0x0c].filter(p => sup.includes(p)))], slow: sup, rateMs: 250 });
  };
  const tick = () => {
    const lv = {}; for (const v of app.live.values()) if (v.ecu === ecu) lv[v.pid] = v;
    const vals = Object.fromEntries(Object.entries(lv).map(([k, v]) => [k, v.value]));
    const ctx = app.ctx();
    for (const [p, g] of Object.entries(gs)) updatePidGauge(g, +p, vals[p], ctx);
    $$('#lT tr', c).forEach(tr => {
      const p = +tr.dataset.p, v = lv[p]; if (!v) return;
      tr.querySelector('.v').textContent = `${v.text} ${v.unit || ''}`;
      const st = rangeStatus(p, v.value, ctx);
      tr.querySelector('.s').innerHTML = st.st === 'ok' ? '<span class="badge ok">طبيعي</span>' : st.st === 'warn' ? '<span class="badge warn">قرب الحد</span>' : st.st === 'bad' ? '<span class="badge err">خارج الطبيعي</span>' : `<span class="dim small">${esc(st.note || '')}</span>`;
    });
    const cv = $('#lCv', c);
    if (cv) drawChart(cv, chartPids.map((p, i) => ({ name: pidName(p), color: COLORS[i], data: app.hist.get(`${ecu}:${p}`) || [] })), { tspan: 60000, band: chartPids.length === 1 ? PIDS[chartPids[0]]?.[7]?.ok : null });
    const tr = $('#lTrims', c);
    if (tr) {
      const bar = (lab, v) => v == null ? '' : `<div class="row small" style="margin:6px 0"><span style="width:150px">${lab}</span><div class="range-bar" style="flex:1"><div class="ok" style="left:30%;right:30%"></div><div class="mk" style="left:${Math.max(0, Math.min(100, (v + 25) * 2))}%"></div></div><span class="num" style="width:60px;text-align:left">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span></div>`;
      const t1 = vals[6] != null && vals[7] != null ? vals[6] + vals[7] : null, t2 = vals[8] != null && vals[9] != null ? vals[8] + vals[9] : null;
      tr.innerHTML = bar('قصير بنك1', vals[6]) + bar('طويل بنك1', vals[7]) + bar('قصير بنك2', vals[8]) + bar('طويل بنك2', vals[9]) +
        (t1 != null ? `<div class="small" style="margin-top:6px">التعديل الكلي: بنك1 <b class="num">${t1.toFixed(1)}%</b>${t2 != null ? ` · بنك2 <b class="num">${t2.toFixed(1)}%</b>` : ''} — ${Math.abs(t1) <= 10 && (t2 == null || Math.abs(t2) <= 10) ? '<span style="color:var(--gr)">طبيعي (±10%)</span>' : t1 > 10 ? '<span style="color:var(--am)">الكمبيوتر يضيف وقود: خلطة فقيرة</span>' : '<span style="color:var(--am)">الكمبيوتر ينقص وقود: خلطة غنية</span>'}</div>` : '<div class="dim small">الكمبيوتر لا يعلن عن قيم خلطة الوقود</div>');
    }
    const vb = $('#lVolt', c);
    if (vb) {
      const run = ctx.running, V = app.conn.voltage, r = run ? VOLT_RANGES.running : VOLT_RANGES.off;
      vb.innerHTML = `<dl class="kv"><dt>فولت البطارية (من القطعة)</dt><dd class="num">${V ? V.toFixed(2) + ' V' : '—'} ${V ? (V >= r.ok[0] && V <= r.ok[1] ? '<span class="badge ok">طبيعي</span>' : '<span class="badge warn">خارج المعتاد</span>') : ''}</dd>
        ${vals[0x42] != null ? `<dt>فولت كمبيوتر المكينة</dt><dd class="num">${vals[0x42].toFixed(2)} V ${V ? `<span class="small dim">(الفرق ${Math.abs(V - vals[0x42]).toFixed(2)}V)</span>` : ''}</dd>` : ''}
        <dt>المتوقع الآن</dt><dd>${run ? 'شغالة: 13.5–14.8V' : 'طافية: 12.4–12.7V'}</dd></dl><a class="btn sm" href="#/trip?test=crank" style="margin-top:6px">اختبار التدوير (Cranking)</a> <a class="btn sm" href="#/trip?test=charge" style="margin-top:6px">اختبار الشحن</a>`;
    }
    if (recording) recording.push({ t: Date.now(), v: vals, volt: app.conn.voltage });
  };
  offs.push(bus.on('live', tick));
  offs.push(bus.on('conn', ({ state }) => { if (state === 'off') notConn(c); }));
  draw();
  return () => { offs.forEach(f => f()); stopLive(); };
}

/* =========================== Trip recorder & guided tests =========================== */
const TESTS = {
  charge: {
    name: 'اختبار الشحن', icon: '⚡', engine: 'any', desc: 'يقيس فولت البطارية طافية، ثم على الخمول، ثم على 2000 دورة، ثم مع تشغيل الأحمال.',
    steps: [
      { t: 'أطفئ المكينة (السويتش ON أو OFF) وانتظر 30 ثانية', need: 'off', sample: 'rest', demo: d => d.setEngine('off') },
      { t: 'شغّل المكينة واتركها على الخمول', need: 'running', sample: 'idle', demo: d => { d.setEngine('idle'); d.setRpm(700); } },
      { t: 'ارفع الدوران إلى حوالي 2000 دورة وثبّته', need: 'running', sample: 'rpm2000', demo: d => d.setRpm(2000) },
      { t: 'شغّل الأنوار العالية والمكيف على أعلى مروحة ومزيل الضباب، مع 2000 دورة', need: 'running', sample: 'load', demo: d => d.setRpm(2000) },
    ],
    verdict(s) {
      const out = []; let ok = true;
      if (s.rest != null) { const g = s.rest >= 12.4; ok &&= g; out.push(`البطارية طافية ${s.rest.toFixed(2)}V — ${s.rest >= 12.6 ? 'مشحونة' : s.rest >= 12.4 ? 'مقبولة' : 'ضعيفة/غير مشحونة'}`); }
      if (s.idle != null) { const g = s.idle >= 13.4 && s.idle <= 14.9; ok &&= g; out.push(`على الخمول ${s.idle.toFixed(2)}V — ${g ? 'الدينمو يشحن' : 'خارج المعتاد'}`); }
      if (s.rpm2000 != null) { const g = s.rpm2000 >= 13.5 && s.rpm2000 <= 14.9; ok &&= g; out.push(`على 2000 دورة ${s.rpm2000.toFixed(2)}V — ${g ? 'طبيعي' : s.rpm2000 > 14.9 ? 'شحن زائد (منظّم)' : 'شحن ضعيف'}`); }
      if (s.load != null) { const g = s.load >= 13.2; ok &&= g; out.push(`مع الأحمال ${s.load.toFixed(2)}V — ${g ? 'الدينمو يتحمل الأحمال' : 'ينهار تحت الحِمل (دينمو/سير/أطراف)'}`); }
      return { ok, lines: out };
    },
  },
  crank: {
    name: 'اختبار التدوير (Cranking)', icon: '🔑', engine: 'off', desc: 'يسجّل فولت البطارية بأسرع معدّل ممكن أثناء تدوير السلف لمعرفة قوة البطارية والسلف والأطراف.',
    steps: [{ t: 'تأكد أن المكينة طافية والقير على P/N. اضغط «ابدأ التسجيل» ثم دوّر المكينة (شغّلها) خلال 8 ثوانٍ', need: 'off', crank: true }],
    verdict(s) {
      if (s.min == null) return { ok: false, lines: ['لم تُسجَّل قراءات كافية'] };
      const lines = [`أقل فولت أثناء التدوير ${s.min.toFixed(2)}V`, `الفولت قبل التدوير ${s.before?.toFixed(2) ?? '—'}V`, s.after ? `بعد التشغيل ${s.after.toFixed(2)}V` : ''];
      const ok = s.min >= 9.6;
      lines.push(ok ? 'البطارية والسلف ضمن الطبيعي (الحد الأدنى المعتاد 9.6V)' : 'هبوط كبير: بطارية ضعيفة أو سلف يسحب زيادة أو أطراف/أرضي سيئة');
      if (app.conn.elm?.info?.caps?.voltage === false) lines.push('ملاحظة: القطعة لا تدعم قراءة الفولت');
      lines.push('دقة الاختبار محدودة بسرعة القطعة (عادة 5–20 قراءة/ثانية) — قد تفوت أدنى قمة لحظية ' + '');
      return { ok, lines: lines.filter(Boolean) };
    },
  },
  trims: {
    name: 'اختبار خلطة الوقود', icon: '⛽', engine: 'running', desc: 'يقارن تعديل الوقود على الخمول وعلى 2500 دورة ليفرّق بين تسريب الهواء وضعف الوقود/MAF.',
    steps: [
      { t: 'المكينة حارّة على الخمول — انتظر 45 ثانية', need: 'running', record: 45, demo: d => d.setRpm(700) },
      { t: 'ثبّت الدوران على 2500 دورة لمدة 45 ثانية', need: 'running', record: 45, demo: d => d.setRpm(2500) },
    ],
    verdict(s) {
      const t = trimAnalysis(s.samples || []);
      if (!t || t.idle1 == null || t.cruise1 == null) return { ok: false, lines: ['لا توجد عينات كافية على الخمول وعلى الدوران العالي'] };
      const lines = [`التعديل الكلي بنك1: خمول ${t.idle1.toFixed(1)}% · 2500 دورة ${t.cruise1.toFixed(1)}%`];
      if (t.hasBank2 && t.idle2 != null) lines.push(`بنك2: خمول ${t.idle2.toFixed(1)}% · 2500 دورة ${(t.cruise2 ?? 0).toFixed(1)}%`);
      const ok = Math.abs(t.idle1) <= 10 && Math.abs(t.cruise1) <= 10;
      if (ok) lines.push('الخلطة ضمن الطبيعي (±10%)');
      else if (t.pattern === 'vacuum') lines.push('فقيرة على الخمول وتتحسن على الدوران العالي → بصمة تسريب هواء (فاكيوم) ' + '[تقديري]');
      else if (t.pattern === 'delivery') lines.push('تزداد فقرًا مع الدوران/الحِمل → ضعف ضغط الوقود أو MAF يقرأ أقل [تقديري]');
      else lines.push('الانحراف ثابت تقريبًا على كل الدورانات → MAF أو ضغط الوقود أو تسريب عادم [تقديري]');
      return { ok, lines };
    },
  },
  o2: {
    name: 'اختبار حساسات الأكسجين', icon: '〰', engine: 'running', desc: 'يعدّ مرات تبديل الحساس الأمامي ويتأكد من ثبات الخلفي (يحتاج مكينة حارّة).',
    steps: [{ t: 'المكينة حارّة؛ ثبّت الدوران على حوالي 1500–2000 دورة لمدة 20 ثانية', need: 'running', record: 20, fast: [0x14, 0x15, 0x18, 0x19], demo: d => d.setRpm(1800) }],
    verdict(s) {
      const sm = s.samples || []; const lines = []; let ok = true;
      for (const [p, n] of [[0x14, 'بنك1 حساس1'], [0x18, 'بنك2 حساس1']]) {
        const v = sm.map(x => x.o2?.[p]).filter(x => x != null); if (v.length < 10) continue;
        let sw = 0; for (let i = 1; i < v.length; i++) if ((v[i - 1] - 0.45) * (v[i] - 0.45) < 0) sw++;
        const dur = (sm.at(-1).t - sm[0].t) / 1000; const hz = sw / 2 / dur;
        const g = hz >= 0.5 && Math.max(...v) > 0.75 && Math.min(...v) < 0.25;
        ok &&= g; lines.push(`${n}: ${sw} تبديل خلال ${dur.toFixed(0)} ث (≈${hz.toFixed(2)} Hz)، مدى ${Math.min(...v).toFixed(2)}–${Math.max(...v).toFixed(2)}V — ${g ? 'نشط' : 'بطيء/محدود'}`);
      }
      for (const [p, n] of [[0x15, 'بنك1 حساس2'], [0x19, 'بنك2 حساس2']]) {
        const v = sm.map(x => x.o2?.[p]).filter(x => x != null); if (v.length < 10) continue;
        const sp = Math.max(...v) - Math.min(...v);
        lines.push(`${n} (بعد الحفاز): تذبذب ${sp.toFixed(2)}V — ${sp < 0.3 ? 'ثابت (الحفاز يعمل)' : 'يتذبذب: الحفاز قد يكون ضعيفًا'}`);
      }
      if (!lines.length) lines.push('الكمبيوتر لا يعلن عن حساسات أكسجين ضيقة النطاق (قد تكون واسعة النطاق)');
      lines.push('معدّل القراءة عبر البلوتوث محدود؛ النتيجة تقريبية [أفضل جهد]');
      return { ok, lines };
    },
  },
  road: {
    name: 'اختبار تحت الحِمل (قيادة)', icon: '🛣', engine: 'running', desc: 'تسجيل أثناء القيادة الفعلية مع تسارع كامل آمن؛ يراقب الخلطة والتقديم والفولت والحرارة. أوقف الاختبار عند الانتهاء — التطبيق لا يتطلب لمس الجهاز أثناء القيادة.',
    steps: [{ t: 'قُد بأمان، ونفّذ تسارعًا قويًا مرة واحدة من 40 إلى 100 كم/س إن كان الطريق مناسبًا. اضغط «إنهاء» عند التوقف', need: 'running', record: 600, allowMoving: true, demo: d => { d.driving = true; d.setRpm(2600); } }],
    verdict(s) {
      const sm = s.samples || []; if (sm.length < 10) return { ok: false, lines: ['عينات قليلة'] };
      const lines = []; let ok = true;
      const maxL = Math.max(...sm.map(x => x.load || 0)), maxR = Math.max(...sm.map(x => x.rpm || 0));
      lines.push(`أقصى حِمل ${maxL.toFixed(0)}% · أقصى دوران ${maxR.toFixed(0)}`);
      const hi = sm.filter(x => (x.load || 0) > 60); if (hi.length) { const t = hi.reduce((a, x) => a + (x.stft1 || 0) + (x.ltft1 || 0), 0) / hi.length; lines.push(`الخلطة تحت الحِمل العالي ${t.toFixed(1)}%`); if (t > 10) { ok = false; lines.push('فقيرة تحت الحِمل → ضغط الوقود/الطرمبة/الفلتر [تقديري]'); } }
      const ectMax = Math.max(...sm.map(x => x.ect || 0)); lines.push(`أعلى حرارة تبريد ${ectMax.toFixed(0)}°C`); if (ectMax > 108) { ok = false; lines.push('حرارة مرتفعة'); }
      const vs = sm.map(x => x.volt).filter(Boolean); if (vs.length) { lines.push(`الفولت أثناء القيادة ${Math.min(...vs).toFixed(2)}–${Math.max(...vs).toFixed(2)}V`); if (Math.min(...vs) < 13.2) ok = false; }
      return { ok, lines };
    },
  },
};
export function tripView(c) {
  if (!connected()) { notConn(c); return; }
  const prm = new URLSearchParams(location.hash.split('?')[1] || '');
  const offs = []; let run = null;
  const list = async () => {
    const trips = await store.all('trips');
    c.innerHTML = `<div class="grid g2">
      <div class="card glow"><div class="card-head"><h2>مسجّل المشوار</h2></div><p class="muted">يسجّل القيم المهمة أثناء القيادة مع خط زمني للأحداث (خروج قيمة عن الطبيعي، ظهور عطل معلّق، تغيّر الفولت)، ثم يعطي نتيجة مدعومة بالأدلة.</p>
        <button class="btn primary lg" id="tFree">● ابدأ تسجيل مشوار</button></div>
      <div class="card"><h2>اختبارات موجّهة خطوة بخطوة</h2><div class="list">${Object.entries(TESTS).map(([k, t]) => `<button class="btn" style="justify-content:flex-start" data-test="${k}"><span style="font-size:18px">${t.icon}</span> ${t.name}</button>`).join('')}</div></div>
      <div class="card spanall"><h2>المشاوير والاختبارات المحفوظة</h2>${trips.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>التاريخ</th><th>النوع</th><th>المدة</th><th>النتيجة</th><th></th></tr></thead><tbody>${trips.slice(0, 30).map(t => `<tr><td>${fmtDate(t.t)}${t.demo ? ' <span class="badge vi">تجريبي</span>' : ''}</td><td>${esc(t.name)}</td><td class="num">${fmtTime(t.dur || 0)}</td><td>${t.verdict ? (t.verdict.ok ? '<span class="badge ok">سليم</span>' : '<span class="badge warn">يحتاج انتباه</span>') : '—'}</td><td><button class="btn sm" data-share="${t.id}">مشاركة التقرير</button> <button class="btn sm ghost" data-del="${t.id}">حذف</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">لا توجد تسجيلات بعد</div>'}</div></div>`;
    $('#tFree', c).onclick = () => startTest(null);
    $$('[data-test]', c).forEach(b => b.onclick = () => startTest(b.dataset.test));
    $$('[data-share]', c).forEach(b => b.onclick = async () => { const t = await store.get('trips', b.dataset.share); await shareFile(`trip-${new Date(t.t).toISOString().slice(0, 10)}.html`, tripReportHtml(t)); });
    $$('[data-del]', c).forEach(b => b.onclick = async () => { await store.del('trips', b.dataset.del); list(); });
  };
  const sup = () => app.pidSupport.get(app.primaryEcu()) || new Set();
  const startTest = async key => {
    const T = key ? TESTS[key] : { name: 'مشوار حر', steps: [{ t: 'سجّل أثناء القيادة. اضغط «إنهاء» عند الوصول', record: 3600, allowMoving: true }], desc: 'تسجيل حر', verdict: s => freeVerdict(s) };
    const ok = await confirmAction({ title: T.name, what: esc(T.desc), extra: `<ul class="small"><li>لا تتعامل مع الجهاز أثناء القيادة؛ اجعل شخصًا آخر يتابع أو ثبّته في حامل.</li>${T.engine === 'off' ? '<li>يجب أن تكون المكينة طافية والسيارة متوقفة.</li>' : ''}${T.steps.some(s => !s.allowMoving) ? '<li>هذا الاختبار يُنفّذ والسيارة واقفة (السرعة 0) — يتوقف تلقائيًا إن تحركت.</li>' : ''}</ul>`, reversible: 'الاختبار للقراءة فقط ولا يغيّر أي شيء في السيارة' });
    if (!ok) return;
    run = { key, T, step: 0, t0: Date.now(), events: [], samples: [], res: {}, o2: {} };
    const pids = [0x0c, 0x0d, 0x05, 0x04, 0x06, 0x07, 0x08, 0x09, 0x10, 0x0b, 0x0e, 0x11, 0x42].filter(p => sup().has(p));
    const ev = (t, kind = '') => { run.events.push({ t: Date.now(), text: t, kind }); renderRun(); };
    run.ev = ev; ev('بدء: ' + T.name);
    const states = {};
    const extra = T.steps.flatMap(s => s.fast || []).filter(p => sup().has(p));
    startLive({
      fast: extra.length ? [0x0c, ...extra].filter(p => sup().has(p)) : pids.slice(0, 6), slow: pids, rateMs: extra.length ? 0 : 300,
      onTick: () => {
        const v = app.liveValues(); const now = Date.now();
        const s = { t: now, rpm: v[0x0c], speed: v[0x0d], ect: v[0x05], load: v[0x04], stft1: v[0x06], ltft1: v[0x07], stft2: v[0x08], ltft2: v[0x09], maf: v[0x10], timing: v[0x0e], volt: app.conn.voltage, o2: { 0x14: v[0x14], 0x15: v[0x15], 0x18: v[0x18], 0x19: v[0x19] } };
        if (run.recording !== false) run.samples.push(s);
        const ctx = app.ctx();
        for (const p of pids) { const st = rangeStatus(p, v[p], ctx).st; if (st === 'bad' && states[p] !== 'bad') ev(`${pidName(p)} خارج الطبيعي: ${v[p]?.toFixed?.(1)} ${PIDS[p]?.[1] || ''}`, 'bad'); if (st === 'ok' && states[p] === 'bad') ev(`${pidName(p)} عاد للطبيعي`); states[p] = st; }
        const moving = (v[0x0d] || 0) > 3;
        if (moving && !run.moving) ev('بدأت السيارة بالتحرك', ''); if (!moving && run.moving) ev('توقفت السيارة', '');
        run.moving = moving;
        const stp = run.T.steps[run.step];
        if (moving && stp && !stp.allowMoving && !run.abort) { run.abort = true; ev('أُوقف الاختبار: السيارة تحركت (شرط السلامة)', 'bad'); finish(); }
        renderLive();
      },
    });
    // pending DTC watch for free/road trips
    run.dtcTimer = setInterval(async () => {
      if (!run || run.done) return;
      try { const r = await app.obd.readDtcs('07'); const codes = [...r.map.values()].flat(); const nw = codes.filter(x => !(run.seen || []).includes(x)); if (nw.length) ev('ظهر عطل معلّق: ' + nw.join('، '), 'bad'); run.seen = codes; } catch {}
    }, 60000);
    renderRun();
  };
  const renderRun = () => {
    if (!run) return;
    const T = run.T, stp = T.steps[run.step];
    c.innerHTML = `<div class="grid g2">
      <div class="card glow"><div class="card-head"><h2>${esc(T.name)}</h2><span class="sp"></span><span class="num" id="rT">00:00</span></div>
        ${run.done ? '' : `<div class="small dim">الخطوة ${run.step + 1} من ${T.steps.length}</div><div style="font-size:17px;margin:8px 0">${esc(stp.t)}</div>
        ${app.demo ? '<div class="hint small">في الوضع التجريبي يحاكي البرنامج تغيّر حالة المكينة عند الضغط على «تم».</div>' : ''}
        <div id="rPre" class="small" style="margin:8px 0"></div>
        <div class="btn-row">${stp.crank ? `<button class="btn primary" id="rCrank" ${run.waiting ? 'disabled' : ''}>ابدأ التسجيل ثم دوّر المكينة</button>` : stp.record ? `<button class="btn primary" id="rNext" ${run.waiting ? 'disabled' : ''}>${stp.record > 100 ? 'إنهاء' : 'ابدأ هذه الخطوة'}</button>` : `<button class="btn primary" id="rNext" ${run.waiting ? 'disabled' : ''}>تم — سجّل القراءة</button>`}<button class="btn ghost" id="rStop">إلغاء</button></div>
        <div class="progress ${run.waiting ? '' : 'hidden'}" id="rProg" style="margin-top:10px"><i style="width:0"></i></div>`}
        <div id="rVerdict"></div>
      </div>
      <div class="card"><h2>قراءات الآن</h2><div id="rLive" class="kv"></div><div class="chart-box" style="height:150px;margin-top:10px"><canvas id="rCv"></canvas></div></div>
      <div class="card spanall"><h2>الخط الزمني للأحداث</h2><div class="tl">${run.events.map(e => `<div class="tl-item ${e.kind}"><span class="t">${fmtTime(e.t - run.t0)}</span> ${esc(e.text)}</div>`).join('')}</div></div></div>`;
    $('#rStop', c)?.addEventListener('click', () => { cleanupRun(); list(); });
    $('#rNext', c)?.addEventListener('click', nextStep);
    $('#rCrank', c)?.addEventListener('click', crankTest);
    if (run.done) showVerdict();
    renderLive();
  };
  const renderLive = () => {
    if (!run) return;
    const v = app.liveValues(); const el = $('#rLive', c); if (!el) return;
    const T = $('#rT', c); if (T) T.textContent = fmtTime(Date.now() - run.t0);
    el.innerHTML = [[0x0c, 'الدوران'], [0x0d, 'السرعة'], [0x05, 'الحرارة'], [0x07, 'خلطة طويلة ب1'], [0x04, 'الحِمل']].filter(([p]) => v[p] != null).map(([p, n]) => `<dt>${n}</dt><dd class="num">${v[p].toFixed(p === 0x07 ? 1 : 0)} ${PIDS[p][1]}</dd>`).join('') + (app.conn.voltage ? `<dt>الفولت</dt><dd class="num">${app.conn.voltage.toFixed(2)} V</dd>` : '');
    const pre = $('#rPre', c), stp = run.T.steps[run.step];
    if (pre && stp) {
      const running = app.running();
      const okE = !stp.need || (stp.need === 'running' ? running : !running);
      const okS = stp.allowMoving || (v[0x0d] ?? 0) < 1;
      pre.innerHTML = `${okE ? '✓' : '✕'} حالة المكينة: ${stp.need === 'running' ? 'يجب أن تكون شغالة' : stp.need === 'off' ? 'يجب أن تكون طافية' : 'أي حالة'} ${!okE ? '<span style="color:var(--am)">(غير مستوفى)</span>' : ''} · ${okS ? '✓' : '✕'} السيارة ${stp.allowMoving ? 'يُسمح بالحركة' : 'متوقفة'}`;
      const nb = $('#rNext', c); if (nb && !run.waiting) nb.disabled = !(okS && (okE || app.demo));
    }
    const cv = $('#rCv', c); if (cv) drawChart(cv, [{ name: 'الدوران', color: '#3de0ff', data: run.samples.map(s => [s.t, s.rpm]) }], { tspan: 120000, events: run.events.filter(e => e.kind) });
  };
  const nextStep = async () => {
    const me = run; if (!me || me.done || me.busy) return;
    me.busy = true;
    try { await doStep(me); } finally { me.busy = false; me.waiting = false; }
    if (run !== me || me.done) return;
    me.step++;
    if (me.step >= me.T.steps.length) finish(); else renderRun();
  };
  const doStep = async me => {
    const stp = me.T.steps[me.step]; const d = app.conn.transport;
    if (app.demo && stp.demo) stp.demo(d);
    if (stp.record) {
      if (stp.record > 100) { finish(); return; }
      me.waiting = true; $('#rNext', c).disabled = true; $('#rProg', c).classList.remove('hidden');
      const t0 = Date.now(); me.ev(`تسجيل ${stp.record} ثانية: ${stp.t}`);
      while (Date.now() - t0 < stp.record * 1000 && run === me && !me.done) { const i = c.querySelector('#rProg i'); if (i) i.style.width = ((Date.now() - t0) / stp.record / 10) + '%'; await sleep(300); }
    } else {
      me.waiting = true; renderRun();
      await sleep(app.demo ? 1500 : 3000);
      if (run !== me) return;
      const vs = []; for (let i = 0; i < 5; i++) { const v = await app.conn.elm.voltage(); if (v) vs.push(v); await sleep(200); }
      const avg = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
      me.res[stp.sample] = avg; if (run === me) me.ev(`${stp.t}: ${avg ? avg.toFixed(2) + 'V' : 'لا قراءة'}`);
    }
  };
  const crankTest = async () => {
    if (app.demo) { app.conn.transport.setEngine('off'); await sleep(300); }
    else if (app.running()) { toast('المكينة شغالة — أطفئها أولًا', 'warn'); return; }
    stopLive(); // maximise voltage sampling rate
    run.waiting = true;
    const vs = []; const t0 = Date.now(); run.ev('بدأ تسجيل الفولت السريع — دوّر المكينة الآن');
    if (app.demo) setTimeout(() => app.conn.transport.crank(), 1500);
    const me = run;
    while (Date.now() - t0 < 8000 && run === me) { const v = await app.conn.elm.voltage(); if (v) vs.push([Date.now(), v]); const i = c.querySelector('#rProg i'); if (i) i.style.width = ((Date.now() - t0) / 80) + '%'; }
    if (run !== me) return;
    if (!vs.length) { run.res = { min: null }; finish(); return; }
    const min = Math.min(...vs.map(x => x[1]));
    run.res = { min: vs.length ? min : null, before: vs[0]?.[1], after: vs.at(-1)?.[1], series: vs };
    run.samples = vs.map(([t, v]) => ({ t, volt: v, rpm: 0 }));
    run.ev(`أقل فولت ${min.toFixed(2)}V من ${vs.length} قراءة (${(vs.length / 8).toFixed(1)} قراءة/ث)`, min < 9.6 ? 'bad' : '');
    finish();
  };
  const finish = async () => {
    if (!run || run.done) return;
    run.done = true; clearInterval(run.dtcTimer); stopLive();
    if (app.demo) { const d = app.conn.transport; d.driving = false; d.setRpm(700); if (d.engine === 'off') d.setEngine('idle'); }
    const res = { ...run.res, samples: run.samples };
    run.verdict = run.abort ? { ok: false, lines: ['أُوقف الاختبار تلقائيًا لأن السيارة تحركت (شرط سلامة لهذا الاختبار). أعد المحاولة والسيارة واقفة.'] } : run.T.verdict(res);
    run.ev('انتهى — ' + (run.verdict.ok ? 'النتيجة سليمة' : 'يحتاج انتباه'), run.verdict.ok ? '' : 'warn');
    const rec = { id: uid(), t: run.t0, dur: Date.now() - run.t0, name: run.T.name, test: run.key, demo: app.demo, vehicle: { ...app.vehicle, vinInfo: undefined }, events: run.events, verdict: run.verdict, res: { ...run.res, series: undefined }, samples: run.samples.filter((_, i, a) => a.length < 1500 || i % Math.ceil(a.length / 1500) === 0), trims: trimAnalysis(run.samples) };
    const r = run; r.rec = rec;
    await store.put('trips', rec);
    if (run !== r) return; // the person left this page; the result is saved in the list
    speak((r.verdict.ok ? 'النتيجة سليمة. ' : 'النتيجة تحتاج انتباه. ') + r.verdict.lines.slice(0, 2).join('. '));
    renderRun();
  };
  const showVerdict = () => {
    const v = run.verdict; const b = $('#rVerdict', c); if (!b) return;
    b.innerHTML = `<div class="${v.ok ? 'ok-box' : 'warn'}" style="margin-top:10px"><b>${v.ok ? '✓ النتيجة: سليم' : '⚠ النتيجة: يحتاج انتباه'}</b><ul>${v.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>
      <div class="small dim" style="margin:6px 0">النتيجة مبنية على القراءات المسجّلة أعلاه (${run.samples.length} عينة) ${conf('best')}</div>
      <div class="btn-row"><button class="btn primary" id="rShare">مشاركة/حفظ التقرير</button><button class="btn" id="rBack">رجوع</button></div>`;
    $('#rShare', c).onclick = () => shareFile(`trip-${new Date(run.t0).toISOString().slice(0, 10)}.html`, tripReportHtml(run.rec));
    $('#rBack', c).onclick = () => { run = null; list(); };
  };
  const cleanupRun = () => {
    if (run) { clearInterval(run.dtcTimer); run.done = true; }
    if (run && app.demo && app.conn.transport?.setRpm) { const d = app.conn.transport; d.driving = false; d.setRpm(700); if (d.engine === 'off') d.setEngine('idle'); }
    run = null; stopLive();
  };
  const t = prm.get('test');
  if (t && TESTS[t]) startTest(t); else list();
  return () => { cleanupRun(); offs.forEach(f => f()); };
}
function freeVerdict(s) {
  const sm = s.samples || []; if (sm.length < 5) return { ok: true, lines: ['تسجيل قصير'] };
  const lines = []; let ok = true;
  const t = trimAnalysis(sm); if (t) { lines.push(`متوسط الخلطة بنك1 ${t.all1.toFixed(1)}%${t.hasBank2 ? ` · بنك2 ${t.all2.toFixed(1)}%` : ''}`); if (Math.abs(t.all1) > 10) { ok = false; lines.push(t.pattern === 'vacuum' ? 'بصمة تسريب هواء [تقديري]' : 'انحراف في الخلطة'); } }
  const e = sm.map(x => x.ect).filter(x => x != null); if (e.length) { lines.push(`الحرارة ${Math.min(...e).toFixed(0)}–${Math.max(...e).toFixed(0)}°C`); if (Math.max(...e) > 108) ok = false; }
  const v = sm.map(x => x.volt).filter(Boolean); if (v.length) { lines.push(`الفولت ${Math.min(...v).toFixed(2)}–${Math.max(...v).toFixed(2)}V`); }
  const sp = sm.map(x => x.speed).filter(x => x != null); if (sp.length) lines.push(`أقصى سرعة ${Math.max(...sp)} كم/س`);
  return { ok, lines };
}

/* =========================== Predictive (light digital twin) =========================== */
export async function twinView(c) {
  c.innerHTML = '<div class="card"><div class="empty"><span class="spin"></span></div></div>';
  const vin = app.vehicle.vin;
  const scans = (await store.all('scans')).filter(s => !vin || s.vehicle?.vin === vin).reverse();
  const trips = (await store.all('trips')).filter(s => !vin || s.vehicle?.vin === vin).reverse();
  const series = {
    ltft1: { n: 'متوسط خلطة الوقود بنك1 (%)', lim: [-15, 15], pts: [] },
    ltft2: { n: 'متوسط خلطة الوقود بنك2 (%)', lim: [-15, 15], pts: [] },
    rest: { n: 'فولت البطارية طافية (V)', lim: [12.2, 99], pts: [] },
    crank: { n: 'أقل فولت أثناء التدوير (V)', lim: [9.6, 99], pts: [] },
    run: { n: 'فولت الشحن (V)', lim: [13.4, 14.9], pts: [] },
    ect: { n: 'أعلى حرارة تبريد (°C)', lim: [-99, 108], pts: [] },
    cat1: { n: 'هامش اختبار الحفاز بنك1 (% من الحد)', lim: [-99, 90], pts: [] },
    mis: { n: 'مجموع الاحتراق الناقص (Mode 6)', lim: [-1, 50], pts: [] },
    dtc: { n: 'عدد الأعطال في الفحص', lim: [-1, 0.5], pts: [] },
  };
  for (const t of trips) {
    if (t.trims?.all1 != null) series.ltft1.pts.push([t.t, t.trims.all1]);
    if (t.trims?.hasBank2 && t.trims?.all2 != null) series.ltft2.pts.push([t.t, t.trims.all2]);
    if (t.res?.rest) series.rest.pts.push([t.t, t.res.rest]);
    if (t.res?.min) series.crank.pts.push([t.t, t.res.min]);
    if (t.res?.idle) series.run.pts.push([t.t, t.res.idle]);
    const e = (t.samples || []).map(s => s.ect).filter(x => x != null); if (e.length) series.ect.pts.push([t.t, Math.max(...e)]);
  }
  for (const s of scans) {
    series.dtc.pts.push([s.t, s.dtcs?.length || 0]);
    if (s.live?.[7] != null && !series.ltft1.pts.some(p => Math.abs(p[0] - s.t) < 6e4)) series.ltft1.pts.push([s.t, s.live[7]]);
    for (const m of s.mode06 || []) {
      const cat = m.rows.find(r => r.mid === 0x21); if (cat && cat.max) series.cat1.pts.push([s.t, cat.value / cat.max * 100]);
      const mis = m.rows.filter(r => r.mid >= 0xa2 && r.mid <= 0xad && r.tid === 0x0b); if (mis.length) series.mis.pts.push([s.t, mis.reduce((a, r) => a + r.value, 0)]);
    }
  }
  const cards = Object.entries(series).map(([k, s]) => {
    s.pts.sort((a, b) => a[0] - b[0]);
    const n = s.pts.length, last = s.pts.at(-1)?.[1];
    let pred = '<span class="dim small">يحتاج 3 قياسات على الأقل لحساب الاتجاه</span>', warn = false;
    if (n >= 3) {
      const days = s.pts.map(p => (p[0] - s.pts[0][0]) / 864e5), lr = linreg(days, s.pts.map(p => p[1]));
      if (lr) {
        const perMonth = lr.slope * 30;
        const lo = s.lim[0], hi = s.lim[1]; const now = days.at(-1);
        let cross = null;
        if (lr.slope > 0 && hi < 90) cross = (hi - lr.intercept) / lr.slope - now;
        if (lr.slope < 0 && lo > -90) cross = (lo - lr.intercept) / lr.slope - now;
        warn = cross != null && cross > 0 && cross < 120 && lr.r2 > 0.3;
        pred = `الاتجاه: <b class="num">${perMonth > 0 ? '+' : ''}${perMonth.toFixed(2)}</b> شهريًا · ثقة الاتجاه R²=${lr.r2.toFixed(2)}${cross != null && cross > 0 && cross < 720 ? ` · قد يصل الحد خلال ~<b class="num">${Math.round(cross)}</b> يوم` : ''}`;
      }
    }
    const outNow = last != null && (last < s.lim[0] || last > s.lim[1]);
    return `<div class="card ${warn || outNow ? 'glow' : ''}"><div class="card-head"><h3>${esc(s.n)}</h3><span class="sp"></span>${outNow ? '<span class="badge err">خارج الحد الآن</span>' : warn ? '<span class="badge warn">تحذير مبكر</span>' : n ? '<span class="badge ok">مستقر</span>' : ''}</div>
      <div class="row"><div class="kpi"><div class="v" style="font-size:22px">${last != null ? (+last).toFixed(1) : '—'}</div><div class="l">${n} قياس</div></div><span class="sp" style="flex:1"></span>${sparkline(s.pts.map(p => p[1]), warn || outNow ? '#ffb547' : '#3de0ff')}</div>
      <div class="small" style="margin-top:6px">${pred}</div></div>`;
  });
  c.innerHTML = `<div class="card glow" style="margin-bottom:16px"><h2>المتابعة التنبّؤية (توأم رقمي خفيف) ${conf('est')}</h2>
    <p class="muted">يتتبّع اتجاه القيم المهمة عبر الفحوصات والمشاوير المحفوظة لهذه السيارة${vin ? ` (<span class="mono">${esc(vin)}</span>)` : ''} ليحذّر مبكرًا قبل أن يتحوّل الانحراف إلى عطل. التنبؤ خطّي بسيط ويتحسّن مع زيادة القياسات.</p>
    <div class="small">البيانات: ${scans.length} فحص · ${trips.length} مشوار/اختبار. لزيادة الدقة: نفّذ «اختبار خلطة الوقود» و«اختبار الشحن» و«الفحص الشامل» بشكل دوري.</div></div>
    <div class="grid g3">${cards.join('')}</div>`;
}

/* =========================== Phone sensors =========================== */
export function sensorsView(c) {
  const hasCam = !!navigator.mediaDevices?.getUserMedia;
  let stream = null, audio = null, raf = 0;
  const draw = async () => {
    const photos = await store.all('photos');
    c.innerHTML = `<div class="grid g2">
      <div class="card"><div class="card-head"><h2>📷 الكاميرا: توثيق وتأشير القطع</h2></div>
        <p class="small muted">التقط صورة للقطعة أو الفيش، ثم اضغط على الصورة لوضع دوائر تأشير، واكتب ملاحظة. تُحفظ محليًا وتُرفق بالتقرير. الكاميرا لا تشخّص القطعة — هي للتوثيق والتأشير فقط.</p>
        ${hasCam ? '<div class="btn-row"><button class="btn primary" id="sCam">تشغيل الكاميرا</button></div>' : ''}
        <label class="btn" style="margin-top:8px">أو اختر/التقط صورة<input type="file" accept="image/*" capture="environment" id="sFile" hidden></label>
        <video id="sVid" playsinline muted class="hidden" style="width:100%;border-radius:12px;margin-top:10px"></video>
        <div class="btn-row hidden" id="sSnapRow" style="margin-top:8px"><button class="btn primary" id="sSnap">التقاط</button></div>
        <div id="sEdit"></div>
        <h3 style="margin-top:14px">الصور المحفوظة (${photos.length})</h3>
        <div class="photo-grid">${photos.map(p => `<div><img src="${p.data}" alt=""><div class="small">${esc(p.note || '')}</div><div class="small dim">${fmtDate(p.t)}</div><button class="btn sm ghost" data-del="${p.id}">حذف</button></div>`).join('') || '<div class="dim small">لا صور</div>'}</div></div>
      <div class="card"><div class="card-head"><h2>🎙 المايك: تحليل الأصوات</h2></div>
        <p class="small muted">يعرض طيف الصوت ويحدد الترددات الغالبة. إذا كانت السيارة متصلة يقارنها بدوران المكينة ليعرف إن كان الصوت مرتبطًا بالمكينة (دوران العمود، الإشعال، الكامات). <b>حدود صريحة:</b> مايك الجوال وضجيج المكان يحدّان الدقة، والتحليل لا يحدد القطعة التالفة بعينها ${conf('est')}.</p>
        ${hasCam ? '<button class="btn primary" id="sMic">بدء الاستماع</button>' : '<div class="warn">المتصفح لا يسمح بالوصول للمايك.</div>'}
        <canvas class="spec-canvas" id="sSpec" style="margin-top:10px"></canvas>
        <div id="sPeaks" class="small" style="margin-top:8px"></div></div></div>`;
    $$('[data-del]', c).forEach(b => b.onclick = async () => { await store.del('photos', b.dataset.del); draw(); });
    $('#sFile', c).onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { const im = new Image(); im.onload = () => editor(im); im.src = r.result; }; r.readAsDataURL(f); };
    $('#sCam', c)?.addEventListener('click', async () => {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); const v = $('#sVid', c); v.srcObject = stream; v.classList.remove('hidden'); await v.play(); $('#sSnapRow', c).classList.remove('hidden'); }
      catch (e) { toast('لم يُسمح بالكاميرا: ' + e.message, 'err'); }
    });
    $('#sSnap', c)?.addEventListener('click', () => { const v = $('#sVid', c); const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight; cv.getContext('2d').drawImage(v, 0, 0); stopCam(); const im = new Image(); im.onload = () => editor(im); im.src = cv.toDataURL('image/jpeg', .85); });
    $('#sMic', c)?.addEventListener('click', toggleMic);
  };
  const stopCam = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; $('#sVid', c)?.classList.add('hidden'); $('#sSnapRow', c)?.classList.add('hidden'); };
  const editor = im => {
    const box = $('#sEdit', c);
    const maxW = 1000, k = Math.min(1, maxW / im.width);
    box.innerHTML = `<canvas id="sC" style="width:100%;border-radius:12px;margin-top:10px;cursor:crosshair"></canvas><div class="small dim">اضغط على الصورة لوضع دائرة تأشير</div><input type="text" id="sNote" placeholder="ملاحظة (مثال: فيش حساس الأكسجين بنك1 متأكسد)"><div class="btn-row" style="margin-top:8px"><button class="btn primary" id="sSave">حفظ الصورة</button><button class="btn ghost" id="sUndo">تراجع</button></div>`;
    const cv = $('#sC', box); cv.width = im.width * k; cv.height = im.height * k; const g = cv.getContext('2d');
    const marks = []; const paint = () => { g.drawImage(im, 0, 0, cv.width, cv.height); marks.forEach((m, i) => { g.strokeStyle = '#ff5468'; g.lineWidth = 4; g.shadowColor = '#ff5468'; g.shadowBlur = 8; g.beginPath(); g.arc(m.x, m.y, cv.width / 18, 0, Math.PI * 2); g.stroke(); g.shadowBlur = 0; g.fillStyle = '#ff5468'; g.font = `bold ${cv.width / 30}px Chakra Petch`; g.fillText(String(i + 1), m.x + cv.width / 16, m.y); }); };
    paint();
    cv.onclick = e => { const r = cv.getBoundingClientRect(); marks.push({ x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }); paint(); };
    $('#sUndo', box).onclick = () => { marks.pop(); paint(); };
    $('#sSave', box).onclick = async () => { await store.put('photos', { id: uid(), t: Date.now(), data: cv.toDataURL('image/jpeg', .8), note: $('#sNote', box).value, vin: app.vehicle.vin || null, codes: app.allDtcs().map(d => d.code) }); toast('حُفظت الصورة', 'ok'); draw(); };
  };
  const toggleMic = async () => {
    if (audio) { stopMic(); $('#sMic', c).textContent = 'بدء الاستماع'; return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ac = new (window.AudioContext || window.webkitAudioContext)(); const src = ac.createMediaStreamSource(s); const an = ac.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0.6; src.connect(an);
      audio = { s, ac, an }; $('#sMic', c).textContent = 'إيقاف';
      const buf = new Float32Array(an.frequencyBinCount); const cv = $('#sSpec', c); const g = cv.getContext('2d');
      let lastTxt = 0;
      const loop = () => {
        raf = requestAnimationFrame(loop);
        an.getFloatFrequencyData(buf);
        const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = cv.clientHeight * devicePixelRatio;
        const binHz = ac.sampleRate / an.fftSize, maxHz = 1000, nb = Math.floor(maxHz / binHz);
        g.clearRect(0, 0, W, H); g.strokeStyle = '#3de0ff'; g.shadowColor = '#3de0ff'; g.shadowBlur = 8; g.lineWidth = 2; g.beginPath();
        for (let i = 1; i < nb; i++) { const x = i / nb * W, y = H - Math.max(0, (buf[i] + 110) / 80) * H; i === 1 ? g.moveTo(x, y) : g.lineTo(x, y); }
        g.stroke();
        if (Date.now() - lastTxt > 700) {
          lastTxt = Date.now();
          const peaks = [];
          for (let i = 3; i < nb - 1; i++) if (buf[i] > buf[i - 1] && buf[i] > buf[i + 1] && buf[i] > -75) peaks.push([i * binHz, buf[i]]);
          peaks.sort((a, b) => b[1] - a[1]);
          const top = peaks.slice(0, 4);
          const rpm = app.liveValues()[0x0c];
          const cyl = 8; // used only for the firing-order hint; shown as an estimate
          $('#sPeaks', c).innerHTML = top.length ? top.map(([f, db]) => {
            let rel = '';
            if (rpm > 400) { const ord = f / (rpm / 60); const near = [[0.5, 'نصف دورة — الكامات/الصبابات'], [1, 'دورة العمود — اتزان/بكرة/مروحة'], [2, 'ضعف الدوران'], [cyl / 2, 'تردد الإشعال (لمكينة 8 سلندر)']].find(([o]) => Math.abs(ord - o) / o < 0.06); rel = ` · رتبة ${ord.toFixed(2)} من الدوران${near ? ` ← <b>${near[1]}</b>` : ''}`; }
            return `<div><span class="num">${f.toFixed(0)} Hz</span> <span class="dim">(${db.toFixed(0)} dB)</span>${rel}</div>`;
          }).join('') + (rpm > 400 ? '' : '<div class="dim">وصّل السيارة وشغّل المكينة لربط الصوت بالدوران.</div>') : '<div class="dim">لا توجد قمم واضحة</div>';
        }
      };
      loop();
    } catch (e) { toast('لم يُسمح بالمايك: ' + e.message, 'err'); }
  };
  const stopMic = () => { cancelAnimationFrame(raf); audio?.s.getTracks().forEach(t => t.stop()); audio?.ac.close(); audio = null; };
  draw();
  const needLive = app.conn.ready;
  if (needLive) startLive({ fast: [0x0c], rateMs: 500 });
  return () => { stopCam(); stopMic(); stopLive(); };
}
