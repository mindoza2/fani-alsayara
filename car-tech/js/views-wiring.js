// Wiring diagrams: generic sheets for any car, and the car's own wiring (pins, wire colours,
// fuses, grounds, module locations) when it is a known platform — with live readings and what
// answered on the network laid over the drawing.
import { $, $$, esc, bus, conf } from './util.js';
import { app, startLive, stopLive, vehDisplacement } from './core.js';
import { PIDS } from './obd.js';
import { circuitFor, getCircuit, CIRCUIT_LIST, chainCheck } from './diag.js';
import { wiringSvg, ROLE } from './widgets.js';
import { params } from './nav.js';
import { settings, saveSettings } from './store.js';
import { gmPlatform, gmCircuits, GM_LIST, gmCircuitFor, gmChecks, SRC, srcBadge, FUSES, GROUNDS, MODULES, DLC_PINS, moduleGrounds, moduleOf as moduleOfEcu } from './wiring-gm.js';

const connected = () => app.conn.ready;
const KIND = { ecm: 'كمبيوتر', part: 'قطعة', fuse: 'فيوز', relay: 'مقاومة/ريليه', batt: 'بطارية', dlc: 'فيش الفحص' };

export function platformNow() { return gmPlatform(app.vehicle, settings().wiringPlat || 'auto', vehDisplacement()); }
// The sheet that answers a code for the connected car.
export function circuitForCar(code) { return platformNow() ? gmCircuitFor(code) : circuitFor(code); }

// For the network map: how one computer of the connected car is fed, grounded and wired.
export function moduleWiringHtml(e) {
  const plat = platformNow();
  if (!plat || !e) return '';
  if (e.key === 'unreach:swcan') return `<div class="hint" style="margin-top:10px">${srcBadge('plat')} الشبكة البطيئة على طرف 1 (سلك DK GRN دائرة 5060): عليها كمبيوتر الهيكل والعدادات والوسائد والمكيف والراديو ومنع السرقة. <a class="btn sm" href="#/wiring?c=lsgmlan">رسمها الكهربائي</a></div>`;
  const m = moduleOfEcu(e);
  if (!m) return '';
  const gs = moduleGrounds(m, plat);
  const fz = m.fuses.map(n => { const f = FUSES.find(x => x.n === n); return f ? `${f.name} ${f.n} (${f.a}A)` : n; });
  const down = e.ghost || e.status === 'noresp';
  const go = m.circuit || 'mod:' + m.id;
  return `<div class="card" style="margin-top:12px"><div class="card-head"><h3>كهرباء هذا الكمبيوتر في سيارتك</h3>${srcBadge('oem')}<span class="sp"></span><a class="btn sm" href="#/wiring?c=${encodeURIComponent(go)}">الرسم الكهربائي</a></div>
    <dl class="kv"><dt>المكان</dt><dd>${esc(m.loc)}</dd><dt>الشبكة</dt><dd>${esc(m.net)}</dd>
    <dt>الفيوزات</dt><dd class="mono">${fz.map(esc).join(' · ') || '—'}</dd>
    <dt>الأرضي</dt><dd>${gs.map(g => { const x = GROUNDS.find(z => z.g === g); return `<span class="mono">${g}</span>${x ? ' — ' + esc(x.loc) : ''}`; }).join('<br>') || esc(m.gtext || 'في صفحة المخطط الأصلي')}</dd>
    <dt>أطراف الشبكة ${srcBadge('plat')}</dt><dd class="small">${m.pins.map(x => `<span class="mono">${esc(x[0])}</span> ${esc(x[1])} · ${esc(x[2])} · ${esc(x[3])}`).join('<br>')}</dd></dl>
    ${down ? `<div class="warn" style="margin-top:8px">هذا الكمبيوتر ما يرد. افحص بالترتيب: الفيوزات (والسويتش ON) ← نقطة الأرضي ← سلك الإيقاظ ← سلكي الشبكة عند فيشه.</div>` : ''}</div>`;
}

export function wiringView(c) {
  const p = params();
  const offs = [];
  let sel = null, tab = 'fuses', q = '', tok = null;
  let plat = platformNow(), GM = plat ? gmCircuits(plat) : null;
  const ids = () => plat ? [...new Set([...GM_LIST(plat), ...CIRCUIT_LIST().filter(k => getCircuit(k)?.fromLibrary)])] : CIRCUIT_LIST();
  const get = id => {
    const lib = getCircuit(id);
    if (lib?.fromLibrary) return lib; // a library the person added for this car wins
    if (GM?.[id]) return { ...GM[id](), vehicle: true };
    return lib;
  };
  const forCode = code => plat ? gmCircuitFor(code) : circuitFor(code);
  let id = (plat && p.code && forCode(p.code)) || p.c || (p.code ? forCode(p.code) : null) || app.allDtcs().map(d => forCode(d.code)).find(Boolean) || (plat ? 'dlc' : 'charging');
  if (!ids().includes(id)) id = ids().includes('srs') && /SDM/.test(id) ? 'srs' : ids()[0];

  const checksHtml = (cir, checks) => checks.length ? checks.map(k => `<div class="${k.st === 'ok' ? 'ok-box' : k.st === 'warn' ? 'warn' : 'danger'} small" style="margin:6px 0">${esc(k.t)}</div>`).join('') + `<div class="small dim">${conf('est')} تفسير القراءة تقديري</div>` : `<div class="small dim">${connected() ? (cir.vehicle && /canbus|lsgmlan|mod:/.test(id) && !app.modulesScanned ? 'سوِّ «مسح سريع للكمبيوترات» من خريطة الشبكة ليظهر هنا مين يرد ومين لا' : 'لا توجد قراءة حية مرتبطة بهذه الدائرة') : 'اتصل بالسيارة لتركيب القراءات الحية على الرسم'}</div>`;
  const evalNow = cir => {
    const live = { ...app.liveValues(), __volt: app.conn.voltage, running: app.running() };
    const codes = [...new Set(app.allDtcs().map(d => d.code))];
    const checks = cir ? [...(cir.vehicle ? gmChecks(id, cir, { ecus: [...app.ecus.values()], volt: app.conn.voltage, connected: connected(), codes }) : []), ...chainCheck(id, live, app.conn.voltage, app.ctx().charge)] : [];
    return { live, checks };
  };
  // live readings refresh only the drawing and the checks (the rest of the page stays as it is)
  const drawLive = () => {
    const cir = get(id), box = $('#wSvg', c); if (!cir || !box) return;
    const { live, checks } = evalNow(cir);
    box.innerHTML = wiringSvg(cir, { live, checks, selected: sel });
    const ch = $('#wChecks', c); if (ch) ch.innerHTML = checksHtml(cir, checks);
  };
  const draw = () => {
    const cir = get(id);
    const codes = [...new Set(app.allDtcs().map(d => d.code))];
    const live = { ...app.liveValues(), __volt: app.conn.voltage, running: app.running() };
    const checks = cir ? [
      ...(cir.vehicle ? gmChecks(id, cir, { ecus: [...app.ecus.values()], volt: app.conn.voltage, connected: connected(), codes }) : []),
      ...chainCheck(id, live, app.conn.voltage, app.ctx().charge),
    ] : [];
    const pl = settings().wiringPlat || 'auto';
    c.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row wrap">
      <select id="wSel" style="width:auto;max-width:100%">${ids().map(k => `<option value="${esc(k)}" ${k === id ? 'selected' : ''}>${esc(get(k)?.title || k)}</option>`).join('')}</select>
      <select id="wPlat" style="width:auto" title="مخطط أي سيارة">
        <option value="auto" ${pl === 'auto' ? 'selected' : ''}>السيارة: تلقائي</option>
        <option value="gmt900" ${pl === 'gmt900' ? 'selected' : ''}>شاحنات GM ‏2007–2014 (GMT900)</option>
        <option value="generic" ${pl === 'generic' ? 'selected' : ''}>مخططات عامة</option></select>
      ${codes.length ? `<span class="small dim">من أعطال السيارة:</span>${codes.map(x => `<button class="btn sm ${forCode(x) === id ? 'primary' : ''}" data-code="${esc(x)}" ${forCode(x) ? '' : 'disabled title="لا يوجد مخطط لهذا الكود"'}>${esc(x)}</button>`).join('')}` : ''}
      ${p.code && !forCode(p.code) ? `<span class="warn small">لا يوجد مخطط لـ ${esc(p.code)}</span>` : ''}</div>
      ${plat ? `<div class="small" style="margin-top:8px">${srcBadge('oem')} مخطط سيارتك: <b>${esc(plat.title)}</b>${plat.manual ? ' <span class="dim">(اخترتها يدويًا)</span>' : ''}</div>` : ''}</div>
    ${cir ? `<div class="grid g3"><div class="card span2 wiring"><div class="card-head"><h2>${esc(cir.title)}</h2>${cir.vehicle ? srcBadge('oem') : conf(cir.fromLibrary ? 'best' : 'est')}<span class="sp"></span>
        ${cir.vehicle && SRC[cir.src] ? `<a class="btn sm" href="${SRC[cir.src]}" target="_blank" rel="noopener">المخطط الأصلي ↗</a>` : `<span class="small dim">${cir.fromLibrary ? 'من المكتبة المرجعية المضافة' : 'مخطط نموذجي عام — ليس مخطط المصنّع لسيارتك'}</span>`}</div>
      <div class="small dim swipe-hint">اسحب الرسم للجانب لرؤية باقيه ↔</div>
      <div id="wSvg">${wiringSvg(cir, { live, checks, selected: sel })}</div>
      <div class="legend" style="margin-top:8px">${Object.entries(ROLE).map(([, [col, l]]) => `<span><i style="background:${col}"></i>${l}</span>`).join('')}</div>
      <div class="small dim" style="margin-top:6px">${cir.vehicle
        ? `أسماء الأسلاك والفيوزات ونقاط الأرضي ومواقع الكمبيوترات ${srcBadge('oem')} · أرقام أطراف الشبكة وألوانها ${srcBadge('plat')} · القيم داخل المربعات قراءة حية ${conf('sure')} · القيم المتوقعة ${srcBadge('est')}`
        : `مصادر المعلومات: القيم داخل المربعات قراءة حية ${conf('sure')} · المكوّنات والأسلاك من المكتبة ${conf('best')} · القيم المتوقعة والتقديرات ${conf('est')}`}</div></div>
      <div class="card"><h2>التفاصيل</h2><div id="wDet"><div class="dim small">اضغط على أي سلك أو قطعة في الرسم</div></div>
        <h3 style="margin-top:14px">أين تنكسر السلسلة؟ (من السيارة الآن)</h3><div id="wChecks">${checksHtml(cir, checks)}</div>
        
        ${cir.notes?.length ? `<h3 style="margin-top:14px">ملاحظات</h3><ul class="small">${cir.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        ${cir.vehicle ? '' : '<div class="hint small" style="margin-top:10px">أرقام الأطراف وألوان الأسلاك تختلف حسب السيارة ولا نعرضها إلا إن وُجدت في مكتبة مضافة. يمكنك إضافة مخططات من «الإعدادات ← المكتبة المرجعية».</div>'}</div></div>`
      : '<div class="card"><div class="empty">لا يوجد مخطط</div></div>'}
    ${plat ? refCard() : ''}`;
    $('#wSel', c).onchange = e => { id = e.target.value; sel = null; draw(); };
    $('#wPlat', c).onchange = e => {
      saveSettings({ wiringPlat: e.target.value });
      plat = platformNow(); GM = plat ? gmCircuits(plat) : null; sel = null;
      if (!ids().includes(id)) id = plat ? 'dlc' : 'charging';
      draw();
    };
    $$('[data-code]', c).forEach(b => b.onclick = () => { const k = forCode(b.dataset.code); if (k && ids().includes(k)) { id = k; sel = null; draw(); } });
    $('#wSvg', c)?.addEventListener('click', e => {
      const w = e.target.closest('.wire'), cp = e.target.closest('.wcomp');
      if (w) { sel = 'w' + w.dataset.w; showWire(cir, +w.dataset.w, live, checks); }
      else if (cp) { sel = 'c' + cp.dataset.c; showComp(cir, cp.dataset.c); }
      else return;
      $('#wSvg', c).innerHTML = wiringSvg(cir, { live, checks, selected: sel });
    });
    wireRef();
  };
  const showWire = (cir, k, live, checks) => {
    const w = cir.wires[k]; const [col, role] = ROLE[w.role] || ROLE.sig;
    const lv = w.pid != null ? live[w.pid] : w.vlive ? live.__volt : null;
    const chk = checks.filter(x => x.wire === k);
    $('#wDet', c).innerHTML = `<div class="row"><span class="dot" style="background:${col}"></span><b>${esc(w.label)}</b>${cir.vehicle ? srcBadge(w.l) : conf(w.conf || 'best')}</div>
      <dl class="kv" style="margin-top:8px"><dt>الوظيفة</dt><dd>${role}</dd>
      <dt>${cir.vehicle ? 'الطرف / اللون / الدائرة' : 'رقم الطرف / اللون'}</dt><dd class="${w.pin ? '' : 'dim'}">${esc(w.pin || 'غير موثّق — راجع دليل المصنّع')}</dd>
      <dt>نقطة القياس</dt><dd>${esc(w.measure || '—')}</dd><dt>القيمة المتوقعة</dt><dd>${esc(w.expect || '—')} ${cir.vehicle ? srcBadge('est') : conf('est')}</dd>
      ${w.pid != null || w.vlive ? `<dt>${w.vlive ? 'فولت القطعة الآن' : 'قراءة الكمبيوتر'}</dt><dd class="num">${lv != null ? (typeof lv === 'number' ? lv.toFixed(2) : esc(String(lv))) + ' ' + (w.vlive ? 'V' : (PIDS[w.pid]?.[1] || '')) : '—'} ${lv != null ? conf('sure') : ''}</dd>` : ''}</dl>
      ${chk.map(x => `<div class="${x.st === 'ok' ? 'ok-box' : x.st === 'warn' ? 'warn' : 'danger'} small" style="margin-top:8px">${esc(x.t)}</div>`).join('')}
      ${cir.safety || (w.role === 'sig' && /وسادة|إطلاق/.test(w.label)) ? '<div class="danger small" style="margin-top:8px">لا تقِس دوائر الوسائد بالملتيميتر</div>' : ''}`;
  };
  const showComp = (cir, cid) => {
    const x = cir.comps.find(q2 => q2.id === cid);
    const ws = cir.wires.map((w, i) => ({ w, i })).filter(({ w }) => (w.a || 'ecm') === cid || (w.b || 'c') === cid);
    const g = GROUNDS.find(z => (x.label || '').includes(z.g));
    $('#wDet', c).innerHTML = `<b>${esc(x.label)}</b><div class="small dim">${KIND[x.kind] || ''}${x.sub ? ' · ' + esc(x.sub) : ''}</div>
      ${g && cir.vehicle ? `<div class="small" style="margin-top:6px">${srcBadge(g.l)} ${esc(g.g)}: ${esc(g.loc)} — عليه: ${esc(g.on)}</div>` : ''}
      <h3 style="margin-top:10px">الأسلاك المتصلة</h3><ul class="small">${ws.map(({ w }) => `<li><b>${esc(w.label)}</b>${w.pin ? ` — ${esc(w.pin)}` : ''}${w.expect ? ` — ${esc(w.expect)}` : ''}</li>`).join('')}</ul>`;
  };
  // Reference tables for the car: fuses, grounds, computers, diagnostic connector.
  const refCard = () => {
    const f = s => !q || s.toLowerCase().includes(q.toLowerCase());
    let body = '';
    const short = w => w.replace(/علبة فيوزات المكينة.*$/, 'علبة فيوزات المكينة').replace(/علبة فيوزات الطبلون.*$/, 'علبة فيوزات الطبلون');
    const it = (head, lines) => `<div class="wref-it"><div class="h">${head}</div>${lines.filter(Boolean).map(l => `<div class="small">${l}</div>`).join('')}</div>`;
    if (tab === 'fuses') body = `<div class="wref">${FUSES.filter(x => f(`${x.n} ${x.name} ${x.feeds} ${x.where}`)).map(x => it(`<b class="mono">${esc(x.name)} ${esc(x.n)}</b><span class="badge">${esc(x.a)}A</span><span class="sp"></span>${srcBadge(x.l)}`, [esc(x.feeds), `<span class="dim">${esc(short(x.where))}</span>`])).join('') || '<div class="dim small">لا نتائج</div>'}</div>
      <div class="small dim" style="margin-top:8px">الأرقام من مخطط 2012 بنزين، وتختلف قليلًا بين السنوات والديزل — طابقها مع الملصق داخل غطاء العلبة قبل السحب.</div>`;
    if (tab === 'grounds') body = `<div class="wref">${GROUNDS.filter(x => f(`${x.g} ${x.loc} ${x.on}`)).map(x => it(`<b class="mono">${esc(x.g)}</b><span class="sp"></span>${srcBadge(x.l)}`, [esc(x.loc), `<span class="dim">عليها: ${esc(x.on)}</span>`])).join('') || '<div class="dim small">لا نتائج</div>'}</div>
      <div class="small dim" style="margin-top:8px">نقطة أرضي مرتخية أو صدئة تعطي قراءات غريبة في أكثر من كمبيوتر بنفس الوقت. فكّها ونظّفها وشدّها.</div>`;
    if (tab === 'modules') body = `<div class="wref">${MODULES.filter(m => f(`${m.ar} ${m.id} ${m.loc} ${m.net}`)).map(m => {
      const gs = moduleGrounds(m, plat); const go = m.circuit || (ids().includes('mod:' + m.id) ? 'mod:' + m.id : null);
      const fz = m.fuses.map(n => { const x = FUSES.find(z => z.n === n); return x ? `${esc(x.name)} ${n} (${esc(x.a)}A)` : n; }).join(' · ');
      return it(`<b>${esc(m.ar)}</b><span class="mono small dim">${m.id}</span><span class="sp"></span>${go ? `<button class="btn sm" data-go="${esc(go)}">الرسم</button>` : ''}`,
        [esc(m.loc), `<span class="dim">الشبكة:</span> ${esc(m.net)}`, fz ? `<span class="dim">الفيوزات:</span> <span class="mono">${fz}</span>` : '', `<span class="dim">الأرضي:</span> <span class="mono">${gs.join(' · ') || '—'}</span>${!gs.length && m.gtext ? ` <span class="dim">(${esc(m.gtext)})</span>` : ''}`]);
    }).join('') || '<div class="dim small">لا نتائج</div>'}</div>`;
    if (tab === 'dlc') body = `<div class="wref">${DLC_PINS.map(x => it(`<span class="badge">طرف ${x.p}</span><b>${esc(x.f)}</b>`, [`<span class="mono">${esc(x.col)} · دائرة ${esc(x.ckt)}</span>`, `<span class="dim">يروح إلى:</span> ${esc(x.to)}`, x.note ? `<span class="dim">${esc(x.note)}</span>` : ''])).join('')}</div>
      <div class="small dim" style="margin-top:8px">وظائف الأطراف ${srcBadge('std')} · الألوان والدوائر ${srcBadge('plat')}</div>`;
    return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>مرجع كهرباء سيارتك</h2>${srcBadge('oem')}<span class="sp"></span>
      <div class="seg" id="wTabs">${[['fuses', 'الفيوزات'], ['grounds', 'نقاط الأرضي'], ['modules', 'الكمبيوترات'], ['dlc', 'فيش الفحص']].map(([k, t]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      ${tab !== 'dlc' ? `<input id="wQ" type="search" placeholder="بحث… (مثال: ABS، G103، المكينة)" value="${esc(q)}" style="margin-bottom:10px">` : ''}
      <div id="wRef">${body}</div>
      <div class="small dim" style="margin-top:8px">المصدر: مخطط المصنّع لسييرا 1500 ‏2012 — <a href="${SRC.power}" target="_blank" rel="noopener">توزيع الطاقة ↗</a> · <a href="${SRC.ground}" target="_blank" rel="noopener">توزيع الأرضي ↗</a> · <a href="${SRC.data}" target="_blank" rel="noopener">شبكات البيانات ↗</a></div></div>`;
  };
  const wireRef = () => {
    $$('[data-tab]', c).forEach(b => b.onclick = () => { tab = b.dataset.tab; draw(); });
    $$('[data-go]', c).forEach(b => b.onclick = () => { id = b.dataset.go; sel = null; draw(); c.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); });
    const inp = $('#wQ', c);
    if (inp) inp.oninput = e => {
      q = e.target.value; const pos = e.target.selectionStart;
      draw(); const n = $('#wQ', c); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch {} }
    };
  };
  if (connected()) {
    const sup = app.pidSupport.get(app.primaryEcu()) || new Set();
    const pids = [0x05, 0x0f, 0x11, 0x0b, 0x10, 0x14, 0x0c, 0x07, 0x42, 0x2e].filter(x => sup.has(x));
    if (pids.length) tok = startLive({ fast: pids, rateMs: 800 });
    let last = 0;
    offs.push(bus.on('live', () => { if (Date.now() - last > 2000 && !sel) { last = Date.now(); drawLive(); } }));
  }
  offs.push(bus.on('data', () => { if (!app.scanning && !sel && document.activeElement?.id !== 'wQ') draw(); }));
  draw();
  return () => { offs.forEach(f => f()); if (tok) stopLive(tok); };
}
