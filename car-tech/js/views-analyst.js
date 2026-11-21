// «محلّل الأعطال»: every fault analysed as a mechanic + electrician + programmer would, on the
// car's own wiring, with a step-by-step test that runs on the car and reads it live.
import { $, $$, esc, bus, toast, conf } from './util.js';
import { app, startLive, stopLive, vehDisplacement } from './core.js';
import { PIDS } from './obd.js';
import { params } from './nav.js';
import { analyze, analysisCtx, AREA } from './analyst.js';
import { srcBadge } from './wiring-gm.js';

const connected = () => app.conn.ready;
const areaBadge = a => `<span class="badge" style="border-color:${AREA[a][1]};color:${AREA[a][1]}">${AREA[a][0]}</span>`;

export function diagView(c) {
  const p = params();
  const offs = []; let tok = null;
  const runs = {}; // item index → runner state
  let res = null;
  const draw = () => {
    res = analyze(analysisCtx(app, vehDisplacement()));
    const { items, shared, plat, mods } = res;
    const dt = app.allDtcs();
    const ml = [mods.swap && 'مكينة مركّبة', mods.tune && 'برمجة معدّلة', (mods.afmOff || mods.noAFM) && 'بدون AFM', mods.rearO2Off && 'حساسات/دبات خلفية ملغاة', mods.absKill && 'قاطع ABS'].filter(Boolean);
    c.innerHTML = `<div class="card glow"><div class="card-head"><h2>محلّل الأعطال</h2><span class="sp"></span>${connected() ? '<button class="btn" id="gLive">إضافة قراءات حية للتحليل</button>' : ''}<a class="btn" href="#/scan">فحص جديد</a></div>
      <div class="small muted">لكل عطل: يتتبّع دائرته في مخطط سيارتك، ويجمع الأدلة من القراءات الحية ولقطة اللحظة والأكواد الثانية والكمبيوترات اللي ترد، ويحلل السبب من ثلاث زوايا: ${areaBadge('elec')} ${areaBadge('mech')} ${areaBadge('soft')}. بعدها يمشيك بالفحص على السيارة خطوة خطوة لين يوصل للسبب. النسب ترجيحية ${conf('est')}.</div>
      <div class="row wrap small" style="margin-top:8px;gap:6px"><span class="badge">${dt.length} عطل</span><span class="badge">${app.samples.length} عينة حية</span>${app.mode06?.map?.size ? '<span class="badge ok">نتائج Mode 6</span>' : ''}${app.conn.voltage ? `<span class="badge">فولت ${app.conn.voltage.toFixed(1)}V</span>` : ''}${plat ? `<span class="badge ok">مخطط سيارتك: ${esc(plat.title)}</span>` : '<span class="badge">مخططات عامة</span>'}</div>
      <div class="small" style="margin-top:8px">تعديلات سيارتك: ${ml.length || mods.notes ? `<b>${esc(ml.join('، '))}</b>${mods.notes ? ` <span class="dim">— ${esc(mods.notes)}</span>` : ''}` : '<span class="dim">ما سجّلت تعديلات</span>'} <a href="#/connect" class="small">تعديل</a> <span class="dim">(السواب والتيون يغيّرون ترجيح الأسباب)</span></div></div>
      ${shared.length ? `<div class="card raised" style="margin-top:14px"><div class="card-head"><h2>سبب مشترك محتمل</h2>${conf('est')}</div>${shared.map(s => `<div class="warn small" style="margin:6px 0"><b>${esc(s.t)}</b> — ${esc(s.why)} <span class="mono dim">${esc([...new Set(s.codes)].join(' · '))}</span></div>`).join('')}</div>` : ''}
      ${items.length ? items.map((it, i) => itemHtml(it, i)).join('') : `<div class="card" style="margin-top:14px"><div class="empty"><div class="big">✦</div>${app.lastScan ? 'لا توجد أعطال أو قيم غير طبيعية تستدعي التحليل.' : 'شغّل الفحص الشامل أولًا ليبدأ التحليل.'}</div></div>`}`;
    $('#gLive', c)?.addEventListener('click', e => {
      const b = e.currentTarget; if (b.disabled) return;
      const sup = app.pidSupport.get(app.primaryEcu()) || new Set();
      const pids = [0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0c, 0x0f, 0x10, 0x0b, 0x11, 0x14, 0x15, 0x18, 0x19, 0x33, 0x42, 0x46].filter(x => sup.has(x));
      if (!pids.length) { toast('الكمبيوتر لم يعلن عن القيم المطلوبة للتحليل — شغّل الفحص الشامل أولًا', 'warn'); return; }
      b.disabled = true; b.innerHTML = '<span class="spin"></span> 12 ثانية';
      const t = startLive({ fast: pids, rateMs: 300 });
      setTimeout(() => { stopLive(t); if (c.isConnected) { draw(); toast('أُضيفت قراءات حية للتحليل', 'ok'); } }, 12000);
    });
    $$('[data-run]', c).forEach(b => b.onclick = () => { const i = +b.dataset.run; runs[i] = { cur: items[i].tree[0]?.id, hist: [] }; renderRun(i); });
    for (const i of Object.keys(runs)) if (items[+i]) renderRun(+i); else delete runs[i];
    if (p.code && !draw.scrolled) { draw.scrolled = true; const k = items.findIndex(it => it.codes.includes(p.code)); if (k >= 0) setTimeout(() => $(`#it${k}`, c)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }
  };
  const itemHtml = (it, i) => {
    const total = Object.values(it.areas).reduce((a, b) => a + b, 0) || 1;
    return `<div class="card ${i === 0 ? 'raised' : ''}" id="it${i}" style="margin-top:14px${p.code && it.codes.includes(p.code) ? ';outline:1px solid var(--c1,#3de0ff)' : ''}"><div class="card-head"><span class="badge ${i === 0 ? 'err' : ''}">#${i + 1}</span><h2>${esc(it.title)}</h2>${it.safety ? '<span class="badge err">سلامة</span>' : ''}${it.early ? '<span class="badge warn">تحذير مبكر</span>' : ''}<span class="sp"></span>${it.codes.map(x => `<span class="badge mono">${esc(x)}</span>`).join('')}</div>
      <div class="area-bar">${Object.entries(it.areas).filter(([, v]) => v > 0.01).map(([a, v]) => `<i style="width:${Math.round(v / total * 100)}%;background:${AREA[a][1]}" title="${AREA[a][0]} ${Math.round(v / total * 100)}%"></i>`).join('')}</div>
      <div class="small dim" style="margin:4px 0 10px">${Object.entries(it.areas).filter(([, v]) => v > 0.01).map(([a, v]) => `${AREA[a][0]} ${Math.round(v / total * 100)}%`).join(' · ')}</div>
      <div class="grid g2"><div><h3>ليش صار؟ الأسباب المرجّحة</h3>${it.causes.map(x => `<div style="margin:8px 0"><div class="row small"><span style="flex:1">${areaBadge(x.area)} ${esc(x.t)}</span><div class="bar" style="width:90px"><i style="width:${Math.round(x.p * 100)}%"></i></div><span class="num" style="width:38px">${Math.round(x.p * 100)}%</span></div>${x.why ? `<div class="small dim" style="margin-top:2px">${esc(x.why)}</div>` : ''}</div>`).join('')}
          <h3 style="margin-top:12px">الأدلة من سيارتك</h3>${it.evidence.length ? `<ul class="small">${it.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : '<div class="small dim">ما فيه قراءات مرتبطة بعد — اضغط «إضافة قراءات حية» أو ابدأ الفحص.</div>'}</div>
        <div><h3>الدائرة في سيارتك</h3>${it.path.length ? `${it.loc ? `<div class="small" style="margin-bottom:6px">📍 مكان القطعة: ${esc(it.loc)}</div>` : ''}<ul class="small path">${it.path.map(x => `<li>${x.pin && x.pin !== x.label && !x.pin.startsWith(x.label) ? `<b>${esc(x.label)}</b> — <span class="dim">${esc(x.pin)}</span>` : `<b>${esc(x.pin || x.label)}</b>`} ${it.vehicleSheet ? srcBadge(x.l) : ''}</li>`).join('')}</ul>` : '<div class="small dim">ما فيه رسم لهذي الدائرة.</div>'}
          <div class="btn-row" style="margin-top:8px">${it.sheet ? `<a class="btn sm" href="#/wiring?c=${encodeURIComponent(it.sheet)}${it.codes[0] ? '&code=' + it.codes[0] : ''}">الرسم الكهربائي</a>` : ''}<a class="btn sm" href="#/ai?q=${encodeURIComponent('حلّل لي: ' + it.title + ' — الأكواد ' + it.codes.join(' ') + ' — وش السبب الأرجح في سيارتي وكيف أتأكد؟')}">اسأل الفني</a></div>
          ${it.tree.length ? `<div style="margin-top:12px" id="run${i}"><button class="btn primary" data-run="${i}">ابدأ الفحص على السيارة (${it.tree.filter(n => n.k !== 'end').length} خطوات كحد أقصى)</button></div>` : ''}</div></div></div>`;
  };
  // ---------------- the guided test on the car ----------------
  const val = pid => pid === '__volt' ? app.conn.voltage : app.live.get?.(pid)?.value ?? app.liveValues()[pid];
  const renderRun = i => {
    const box = $(`#run${i}`, c); const it = res?.items[i]; const st = runs[i];
    if (!box || !it || !st) return;
    const node = it.tree.find(n => n.id === st.cur);
    const step = st.hist.length + 1;
    const hist = st.hist.length ? `<ol class="small dim run-hist">${st.hist.map(h => `<li>${esc(h.t.length > 70 ? h.t.slice(0, 70) + '…' : h.t)} → ${h.num ? `<bdi dir="ltr">${esc(h.num)}</bdi> — ` : ''}<b class="${h.st === 'bad' ? 'err-t' : h.st === 'ok' ? 'ok-t' : ''}">${esc(h.r)}</b></li>`).join('')}</ol>` : '';
    const ctl = `<div class="btn-row" style="margin-top:8px">${st.hist.length ? '<button class="btn sm ghost" data-back>رجوع خطوة</button>' : ''}<button class="btn sm ghost" data-stop>إيقاف الفحص</button></div>`;
    if (!node) { box.innerHTML = `${hist}<div class="hint small">انتهى الفحص هنا — ارجع له لاحقًا لما تتوفر الظروف المطلوبة.</div><div class="btn-row"><button class="btn sm" data-restart>أعد من البداية</button></div>`; wireRun(i, null); return; }
    if (node.k === 'end') {
      const v = node.verdict;
      box.innerHTML = `${hist}<div class="verdict" style="border-color:${AREA[v.area][1]}"><div class="row">${areaBadge(v.area)}<b>النتيجة</b></div><div style="margin-top:6px">${esc(v.t)}</div><div class="small" style="margin-top:6px">🔧 الإصلاح: ${esc(v.fix)}</div></div>
        <div class="btn-row" style="margin-top:8px">${st.hist.length ? '<button class="btn sm ghost" data-back>رجوع خطوة</button>' : ''}<button class="btn sm" data-restart>أعد الفحص</button></div>`;
      wireRun(i, node); return;
    }
    let body = '';
    const pids = [node.pid, node.pid2].filter(x => x != null);
    if (node.k === 'live') {
      const live = connected();
      body = live ? `<div class="run-live">${pids.map(q => `<div><span class="dim small">${esc(q === '__volt' ? 'فولت البطارية' : PIDS[q]?.[0] || q)}</span><div class="num big" dir="ltr" data-lv="${q}">—</div></div>`).join('')}</div>
          ${node.watch ? '<div class="small dim" dir="ltr" data-ext></div>' : ''}<button class="btn sm primary" data-judge>احكم على القراءة الآن</button>`
        : `<div class="small dim">غير متصل بالسيارة: اكتب القراءة يدويًا.</div><div class="row" style="gap:6px;margin-top:6px">${pids.map((q, k) => `<input type="number" step="any" data-man="${k}" placeholder="${esc(q === '__volt' ? 'الفولت' : PIDS[q]?.[0] || 'القيمة')}" style="max-width:150px">`).join('')}<button class="btn sm primary" data-judge>تم</button></div>`;
    } else if (node.k === 'measure') {
      body = `<div class="row" style="gap:6px;margin-top:6px"><input type="number" step="any" data-man="0" placeholder="القراءة" style="max-width:150px"><span class="dim">${esc(node.unit || '')}</span><button class="btn sm primary" data-judge>تم</button></div>`;
    } else if (node.k === 'ask') {
      body = `<div class="btn-row" style="margin-top:6px">${node.opts.map(([l, go], k) => `<button class="btn sm" data-opt="${k}">${esc(l)}</button>`).join('')}</div>`;
    } else if (node.k === 'auto') {
      const r = node.check();
      body = `<div class="${r.st === 'ok' ? 'ok-box' : r.st === 'bad' ? 'danger' : 'warn'} small">${esc(r.say)}</div><button class="btn sm primary" data-auto style="margin-top:6px">التالي</button>`;
    } else body = '<button class="btn sm primary" data-done style="margin-top:6px">تم ✓</button>';
    box.innerHTML = `${hist}<div class="run-step"><div class="small dim">الخطوة ${step}</div><div style="margin:4px 0">${esc(node.t)}</div>
      ${node.where ? `<div class="small">📍 ${esc(node.where)}</div>` : ''}${node.expect ? `<div class="small">✓ المتوقع: ${esc(node.expect)} ${conf('est')}</div>` : ''}
      ${body}<div class="small" id="rj${i}" style="margin-top:6px"></div></div>${ctl}`;
    wireRun(i, node);
    if (node.k === 'live' && connected()) {
      const nums = [...new Set([...pids.filter(q => typeof q === 'number'), ...(node.koeo || node.run ? [0x0c] : [])])];
      if (nums.length) { if (tok) stopLive(tok); tok = startLive({ fast: nums, rateMs: 400 }); }
      updLive(i);
    }
  };
  const fmt = v => v == null ? '—' : Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0);
  const updLive = i => {
    const box = $(`#run${i}`, c); if (!box) return;
    // a wiggle test keeps the lowest and highest value seen while the step is open
    const st = runs[i], node = res?.items[i]?.tree.find(n => n.id === st?.cur);
    if (node?.watch && node.pid != null) { const v = val(node.pid); if (typeof v === 'number') { st.ext = st.ext || { min: v, max: v }; st.ext.min = Math.min(st.ext.min, v); st.ext.max = Math.max(st.ext.max, v); const ex = $('[data-ext]', box); if (ex) ex.textContent = `أدنى ${fmt(st.ext.min)} · أعلى ${fmt(st.ext.max)}`; } }
    $$('[data-lv]', box).forEach(el => { const q = el.dataset.lv; const v = val(q === '__volt' ? q : +q); el.textContent = v != null && typeof v === 'number' ? (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0)) + ' ' + (q === '__volt' ? 'V' : PIDS[+q]?.[1] || '') : '—'; }); };
  const go = (i, node, r, label, num = '') => {
    const st = runs[i];
    st.hist.push({ id: node.id, t: node.t, r: label, num, st: r?.st });
    st.ext = null;
    const it = res.items[i];
    let next = r?.go;
    if (next === undefined) { const k = it.tree.findIndex(n => n.id === node.id); next = node.next !== undefined ? node.next : it.tree[k + 1]?.id ?? null; }
    st.cur = next;
    if (tok) { stopLive(tok); tok = null; }
    renderRun(i);
  };
  const wireRun = (i, node) => {
    const box = $(`#run${i}`, c); const st = runs[i];
    $('[data-stop]', box)?.addEventListener('click', () => { delete runs[i]; if (tok) { stopLive(tok); tok = null; } box.innerHTML = `<button class="btn primary" data-run="${i}">ابدأ الفحص على السيارة</button>`; $('[data-run]', box).onclick = () => { runs[i] = { cur: res.items[i].tree[0]?.id, hist: [] }; renderRun(i); }; });
    $('[data-restart]', box)?.addEventListener('click', () => { runs[i] = { cur: res.items[i].tree[0]?.id, hist: [] }; renderRun(i); });
    $('[data-back]', box)?.addEventListener('click', () => { const h = st.hist.pop(); if (h) st.cur = h.id; if (tok) { stopLive(tok); tok = null; } renderRun(i); });
    if (!node) return;
    $('[data-done]', box)?.addEventListener('click', () => go(i, node, null, 'تم'));
    $('[data-auto]', box)?.addEventListener('click', () => { const r = node.check(); go(i, node, r, r.say); });
    $$('[data-opt]', box).forEach(b => b.onclick = () => { const [l, to] = node.opts[+b.dataset.opt]; go(i, node, { go: to, st: 'info' }, l); });
    $('[data-judge]', box)?.addEventListener('click', () => {
      let a, b2;
      if (node.k === 'live' && connected()) {
        const rpm = app.liveValues()[0x0c];
        if (node.koeo && rpm > 300) { $(`#rj${i}`, box).innerHTML = '<span class="warn">المكينة شغالة: طفّها وخلّ السويتش ON، ثم احكم.</span>'; return; }
        if (node.run && rpm != null && rpm < 300) { $(`#rj${i}`, box).innerHTML = '<span class="warn">المكينة طافية: شغّلها أول، ثم احكم.</span>'; return; }
        a = val(node.pid); b2 = node.pid2 != null ? val(node.pid2) : null;
      }
      else { const ins = $$('[data-man]', box); a = ins[0]?.value === '' ? null : parseFloat(ins[0]?.value); b2 = ins[1] ? (ins[1].value === '' ? null : parseFloat(ins[1].value)) : null; }
      if (a == null || Number.isNaN(a)) { $(`#rj${i}`, box).innerHTML = '<span class="warn">ما فيه قراءة بعد — انتظر القيمة أو اكتبها.</span>'; return; }
      const r = node.judge(a, b2, st.ext || {});
      const num = `${typeof a === 'number' ? (Math.abs(a) < 10 ? a.toFixed(2) : a.toFixed(0)) : a}${node.unit ? ' ' + node.unit : ''}${st.ext && node.watch ? ` (أدنى ${fmt(st.ext.min)} · أعلى ${fmt(st.ext.max)})` : ''}`;
      go(i, node, r, r.say, num);
    });
  };
  offs.push(bus.on('live', () => { for (const i of Object.keys(runs)) updLive(+i); }));
  const iv = setInterval(() => { for (const i of Object.keys(runs)) updLive(+i); }, 1000); // the battery voltage is polled outside live data
  offs.push(() => clearInterval(iv));
  offs.push(bus.on('data', () => { if (!app.scanning && !Object.keys(runs).length) draw(); }));
  draw();
  return () => { offs.forEach(f => f()); if (tok) stopLive(tok); };
}
