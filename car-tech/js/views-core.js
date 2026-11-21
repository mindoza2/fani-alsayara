// Phase-1 screens: dashboard, connection, network map, full scan, codes & OBD modes, readiness.
import { $, $$, esc, bus, toast, modal, confirmAction, conf, fmtDate, hex2 } from './util.js';
import { app, connectBle, connectDemo, disconnect, fullScan, moduleScan, clearVerified, rereadVerified, readStdCodes, readFreeze, readMode06, readReadiness, readVinNow, exclusive, setVehicle, decodeVin, startLive, stopLive, requireConn, vehDisplacement } from './core.js';
import { PIDS, pidName, readinessStats } from './obd.js';
import { terminalCheck } from './network.js';
import { describeDtc, dtcSeverity } from './dtcdb.js';
import { netmapSvg, NODE_COLORS, pidGauge, updatePidGauge } from './widgets.js';
import { bleSupport, BLE_REFERENCE } from './transport.js';
import { correlate } from './diag.js';
import { store, settings } from './store.js';
import { go, speak, canSpeak } from './nav.js';
import { PROTOCOLS } from './elm.js';
import { moduleWiringHtml } from './views-wiring.js';

const KINDS = { stored: ['مخزّن', 's-stored'], pending: ['معلّق', 's-pending'], perm: ['دائم', 's-perm'], history: ['سابق', 's-pending'] };
export function dtcRow(code, kind, opts = {}) {
  const d = describeDtc(code); const [kl, kc] = KINDS[kind] || KINDS.stored;
  const sev = dtcSeverity(code);
  return `<div class="dtc"><div class="dtc-code ${kc}">${esc(code)}</div><div class="dtc-body">
    <div class="dtc-title">${esc(d.text)}</div>
    <div class="row wrap small" style="gap:6px;margin-top:4px"><span class="badge">${kl}</span>${conf(d.conf)}<span class="dim">${esc(d.src)}</span>${sev === 'high' ? '<span class="badge err">أولوية عالية</span>' : ''}${opts.extra || ''}</div>
    ${kind === 'perm' ? '<div class="small dim" style="margin-top:4px">«دائم»: تأكّد سابقًا ولا يُمسح بالجهاز — يزول وحده بعد أن يعيد الكمبيوتر اختباره وينجح.</div>' : ''}
    ${opts.ff || ''}
    <div class="btn-row" style="margin-top:6px"><a class="btn sm ghost" href="#/wiring?code=${code}">المخطط</a><a class="btn sm ghost" href="#/diag?code=${code}">حلّل العطل</a><a class="btn sm ghost" href="#/ai?q=${encodeURIComponent('اشرح الكود ' + code + ' وما السبب الأرجح في سيارتي')}">اسأل الفني</a></div>
  </div></div>`;
}
const connected = () => app.conn.ready;
// Progress of the operation that currently owns the adapter — the same on every page, so leaving
// a page and coming back shows where the scan really is.
export function busyBox() {
  const b = app.busy; if (!b) return '';
  return `<div class="busy-box" style="margin-top:10px"><div class="row"><div class="progress" style="flex:1"><i style="width:${Math.round((b.p || 0) * 100)}%"></i></div>${b.cancelable ? '<button class="btn sm" data-cancel>إيقاف</button>' : ''}</div><div class="small muted" data-bt style="margin-top:6px">${esc(b.label)}${b.t ? ' — ' + esc(b.t) : ''}</div></div>`;
}
export function wireBusy(root) { root.querySelectorAll('[data-cancel]').forEach(x => x.onclick = () => { app.busy?.cancel(); x.disabled = true; x.textContent = 'جارٍ الإيقاف…'; }); }
export function onProgress(root) {
  return bus.on('progress', b => {
    root.querySelectorAll('.busy-box .progress>i').forEach(i => { i.style.width = Math.round((b.p || 0) * 100) + '%'; });
    root.querySelectorAll('[data-bt]').forEach(s => { s.textContent = `${b.label}${b.t ? ' — ' + b.t : ''}`; });
  });
}
function connectCta() {
  const s = bleSupport();
  return `<div class="card glow"><div class="hero"><div style="flex:1;min-width:240px"><div class="big">ابدأ بالاتصال بقطعة الفحص</div>
    <p class="muted">ركّب قطعة ELM327 في فيش الفحص تحت الدركسون، شغّل السويتش (ON) أو المكينة، ثم اضغط اتصال.</p>
    ${s.ok ? '' : `<div class="warn">${esc(s.why)}</div>`}</div>
    <div class="btn-row"><button class="btn primary lg" data-act="ble" ${s.ok ? '' : 'disabled'}>⌁ اتصال عبر البلوتوث</button><button class="btn lg" data-act="demo">تجربة الوضع التجريبي</button></div></div></div>`;
}
export function wireConnectButtons(root, after) {
  root.querySelectorAll('[data-act=ble]').forEach(b => b.onclick = () => doConnect('ble', after));
  root.querySelectorAll('[data-act=demo]').forEach(b => b.onclick = () => doConnect('demo', after));
}
async function doConnect(kind, after) {
  const logBox = $('#connLog');
  const progress = t => { if (logBox) { logBox.textContent += t + '\n'; logBox.scrollTop = 1e9; } bus.emit('connprog', t); };
  try {
    const ok = kind === 'ble' ? await connectBle(progress) : await connectDemo(progress);
    toast(ok ? 'تم الاتصال بالسيارة' : 'القطعة متصلة لكن السيارة لم ترد', ok ? 'ok' : 'warn');
    if (ok) speak('تم الاتصال بالسيارة');
  } catch (e) {
    if (e.name === 'NotFoundError') toast('لم يتم اختيار قطعة', 'warn');
    else toast('تعذّر الاتصال: ' + e.message, 'err');
  }
  after?.();
}

/* =========================== Dashboard =========================== */
export function dashboard(c) {
  const offs = [];
  const draw = () => {
    // readiness of all emission computers together (the first answering computer may be the TCM)
    const v = app.vehicle, dt = app.allDtcs(), rd = app.readinessAll(), rs = readinessStats(rd);
    const ecus = [...app.ecus.values()].filter(e => !e.ghost && e.status !== 'unreach');
    const top = correlate({ dtcs: dt, live: app.liveValues(), trims: app.trims(), volt: app.conn.voltage, running: app.running(), displacement: vehDisplacement(), charge: app.ctx().charge })[0];
    c.innerHTML = `
    ${connected() ? '' : connectCta()}
    <div class="grid g4" style="margin-top:${connected() ? 0 : 16}px">
      <div class="card raised span2"><div class="card-head"><h2>السيارة</h2><span class="sp"></span>${v.source === 'auto' ? conf('sure') + '<span class="small dim">قراءة تلقائية AutoVIN</span>' : v.make ? '<span class="badge">اختيار يدوي</span>' : ''}<a class="btn sm ghost" href="#/connect">تعديل</a></div>
        ${v.vin || v.make ? `<div class="hero"><div><div class="big">${esc([v.make, v.model].filter(Boolean).join(' ') || 'سيارة غير معرّفة')} ${v.year ? `<span class="num">${v.year}</span>` : ''}</div>
        <div class="mono muted" style="font-size:15px">${esc(v.vin || '')}</div>
        ${v.vinInfo && !v.vinInfo.checkOk ? '<div class="small" style="color:var(--am)">رقم التحقق في VIN لا يطابق المعيار الأمريكي (طبيعي لبعض السيارات غير الأمريكية)</div>' : ''}</div></div>
        <dl class="kv" style="margin-top:8px"><dt>البروتوكول</dt><dd>${esc(app.conn.elm?.info.protocolName || '—')}</dd><dt>المكينة</dt><dd>${esc(v.engine || (vehDisplacement() ? vehDisplacement() + 'L' : 'غير محددة'))}</dd></dl>`
      : `<div class="empty"><div class="big">🚗</div>لم تُعرّف السيارة بعد. عند الاتصال يُقرأ رقم الهيكل تلقائيًا، أو اخترها يدويًا من صفحة الاتصال.</div>`}
      </div>
      <div class="card"><h3>الاتصال</h3><div class="kpi"><div class="v" style="font-size:20px">${esc({ on: 'متصل', off: 'غير متصل', connecting: 'جارٍ الاتصال', reconnecting: 'إعادة اتصال', adapter: 'القطعة فقط', err: 'خطأ' }[app.conn.state])}</div><div class="l">${esc(app.conn.transport?.name || '—')}</div></div>
        <div class="btn-row" style="margin-top:10px">${connected() ? '<button class="btn sm" id="dDisc">قطع الاتصال</button>' : '<a class="btn sm" href="#/connect">الاتصال</a>'}</div></div>
      <div class="card"><h3>فولت البطارية ${conf('sure')}</h3><div class="kpi"><div class="v" style="color:var(--cy)">${app.conn.voltage ? app.conn.voltage.toFixed(2) : '--.--'}<small class="g-unit"> V</small></div>
        <div class="l">${app.conn.voltage ? (app.running() ? (app.ctx().charge.rvc ? app.ctx().charge.note : 'المكينة شغالة: الطبيعي 13.5–14.8V') : 'المكينة طافية: الطبيعي 12.4–12.7V') : 'يُقرأ من القطعة مباشرة'}</div></div></div>

      <div class="card"><div class="kpi"><div class="v" style="color:${rd?.mil ? 'var(--rd)' : 'var(--gr)'}">${rd ? (rd.mil ? 'مضاءة' : 'مطفأة') : '—'}</div><div class="l">لمبة فحص المكينة (MIL)</div></div></div>
      <div class="card"><div class="kpi"><div class="v" style="color:${dt.length ? 'var(--rd)' : 'var(--gr)'}">${app.lastScan || dt.length ? dt.length : '—'}</div><div class="l">أعطال في كل الكمبيوترات</div></div></div>
      <div class="card"><div class="kpi"><div class="v">${ecus.length || '—'}</div><div class="l">كمبيوترات ترد</div></div></div>
      <div class="card"><div class="kpi"><div class="v">${rs ? `${rs.ready}/${rs.total}` : '—'}</div><div class="l">أنظمة الجاهزية المكتملة</div></div></div>

      <div class="card span2"><div class="card-head"><h2>قراءات سريعة</h2><span class="sp"></span><a class="btn sm ghost" href="#/live">كل البيانات الحية</a></div><div class="gauges" id="dGauges">${connected() ? '' : '<div class="empty">تظهر العدّادات بعد الاتصال</div>'}</div></div>
      <div class="card span2"><div class="card-head"><h2>الترجيح الحالي</h2><span class="sp"></span><a class="btn sm ghost" href="#/diag">التشخيص الموجّه</a></div>
        ${top ? `<div class="dtc-title" style="font-size:16px">${esc(top.title)}</div><div class="small muted" style="margin:6px 0">${top.evidence.map(esc).join(' · ')}</div>
        ${top.causes.slice(0, 3).map(x => `<div class="row small" style="margin:5px 0"><span style="flex:1">${esc(x.t)}</span><div class="bar" style="width:110px"><i style="width:${Math.round(x.p * 100)}%"></i></div><span class="num" style="width:38px">${Math.round(x.p * 100)}%</span></div>`).join('')}
        <div style="margin-top:6px">${conf('est')} <span class="small dim">ترجيح من محرّك ربط الأعطال</span></div>`
        : `<div class="empty">${app.lastScan ? 'لا توجد أعطال أو مؤشرات تستدعي التشخيص 👍' : 'شغّل الفحص الشامل ليظهر الترجيح هنا'}</div>`}</div>

      <div class="card span2"><div class="card-head"><h2>خريطة الشبكة</h2><span class="sp"></span><a class="btn sm ghost" href="#/map">فتح</a></div>
        ${app.ecus.size ? `<div class="netmap" id="dMap">${netmapSvg([...app.ecus.values()].map(nodeOf))}</div>` : '<div class="empty">تظهر الخريطة بعد الاتصال والفحص</div>'}</div>
      <div class="card span2"><div class="card-head"><h2>إجراءات سريعة</h2></div>
        <div class="grid g2">
          <a class="btn lg" href="#/scan">✚ الفحص الشامل</a><a class="btn lg" href="#/live">◔ البيانات الحية</a>
          <a class="btn lg" href="#/ready">✓ الجاهزية للفحص الدوري</a><a class="btn lg" href="#/trip">⏱ مسجّل المشوار</a>
          <a class="btn lg" href="#/ai">✉ اسأل الفني</a><a class="btn lg" href="#/reports">☰ التقارير</a>
        </div></div>
    </div>`;
    wireConnectButtons(c, draw);
    $('#dDisc', c)?.addEventListener('click', async () => { await disconnect(); draw(); });
    $('#dMap', c)?.addEventListener('click', e => { const n = e.target.closest('.node'); if (n) go('map', { k: n.dataset.key }); });
    if (connected()) gaugesOn();
  };
  let gs = {};
  const gaugesOn = () => {
    const box = $('#dGauges', c); if (!box) return;
    const sup = app.pidSupport.get(app.primaryEcu()) || new Set();
    const pids = [0x0c, 0x05, 0x0d, 0x42].filter(p => sup.has(p));
    gs = {};
    if (!pids.length) { box.innerHTML = '<div class="empty">الكمبيوتر لم يعلن عن قيم قياسية قابلة للعرض</div>'; return; }
    pids.forEach(p => { const g = pidGauge(p); gs[p] = g; box.appendChild(g); });
    startLive({ fast: pids, rateMs: 400 });
  };
  offs.push(bus.on('live', () => { const lv = app.liveValues(); const ctx = app.ctx(); for (const [p, g] of Object.entries(gs)) updatePidGauge(g, +p, lv[p], ctx); }));
  offs.push(bus.on('conn', ({ state }) => { if (['on', 'off', 'err', 'adapter'].includes(state)) draw(); }));
  offs.push(bus.on('data', () => { if (!app.scanning) { stopLive(); draw(); } }));
  offs.push(bus.on('volt', () => { const k = c.querySelector('.kpi .v[style*="--cy"]'); if (k && app.conn.voltage) k.firstChild.textContent = app.conn.voltage.toFixed(2); }));
  draw();
  return () => { offs.forEach(f => f()); stopLive(); };
}

/* =========================== Connection =========================== */
export function connectView(c) {
  const offs = [];
  const draw = () => {
    const s = bleSupport(), e = app.conn.elm, t = app.conn.transport, v = app.vehicle;
    c.innerHTML = `<div class="grid g2">
    <div class="card raised"><div class="card-head"><h2>قطعة الفحص</h2><span class="sp"></span><span class="badge ${connected() ? 'ok' : ''}">${esc({ on: 'متصل', off: 'غير متصل', connecting: 'جارٍ الاتصال', reconnecting: 'إعادة اتصال', adapter: 'القطعة فقط', err: 'خطأ' }[app.conn.state])}</span></div>
      ${s.ok ? '<div class="small muted">متصفحك يدعم Web Bluetooth ✓</div>' : `<div class="warn">${esc(s.why)}</div>`}
      <div class="btn-row" style="margin:12px 0">
        ${app.conn.state === 'off' || app.conn.state === 'err' ? `<button class="btn primary" data-act="ble" ${s.ok ? '' : 'disabled'}>⌁ اتصال عبر البلوتوث</button><button class="btn" data-act="demo">الوضع التجريبي</button>` : '<button class="btn danger" id="cDisc">قطع الاتصال</button>'}
      </div>
      <div class="hint">يعمل مع أي محوّل ELM327 بالبلوتوث منخفض الطاقة (BLE). البرنامج يكتشف خدمات القطعة ويختار خاصيتي الكتابة والإشعار حسب خصائصهما. القيم المختبرة لـ KONNWEI KDIAG (FFF0 / FFF2 / FFF1) تُستخدم كمرجع لترجيح الاختيار فقط.</div>
      <label class="f">سجل الاتصال</label><div class="log" id="connLog"></div>
    </div>
    <div class="card"><h2>تفاصيل القطعة والبروتوكول</h2>
      ${e ? `<dl class="kv">
        <dt>القطعة</dt><dd>${esc(t?.name || '')}</dd>
        <dt>الخدمة / الكتابة / الإشعار</dt><dd class="mono">${esc([app.conn.chosen?.service, app.conn.chosen?.write, app.conn.chosen?.notify].join(' / '))}</dd>
        <dt>مرجع معروف</dt><dd>${esc(app.conn.chosen?.ref || 'لا — اختيار ديناميكي')}</dd>
        <dt>إصدار الشريحة</dt><dd class="mono">${esc(e.info.version || '?')}</dd>
        <dt>الوصف</dt><dd>${esc(e.info.desc || '—')}</dd>
        <dt>شريحة STN</dt><dd>${esc(e.info.stn || 'لا')}</dd>
        <dt>البروتوكول</dt><dd>${esc(e.info.protocolName || '—')} ${e.proto ? conf('sure') : ''}</dd>
        <dt>J1979-2 (OBDonUDS)</dt><dd>${app.obd?.uds ? 'مُكتشَف ' + conf('best') : 'لا (OBD التقليدي)'}</dd>
      </dl>
      <h3 style="margin-top:14px">قدرات القطعة المكتشفة</h3>
      <div class="row wrap" style="gap:6px">${Object.entries({ header: 'تغيير العنوان', canFilter: 'فلتر CAN', flowControl: 'تحكم التدفق', timeout: 'مهلة قابلة للضبط', adaptiveTiming: 'توقيت تكيّفي', canPriority: 'أولوية 29-bit', progParams: 'معاملات قابلة للبرمجة', voltage: 'قراءة الفولت' }).map(([k, n]) => `<span class="badge ${e.info.caps[k] ? 'ok' : 'warn'}">${e.info.caps[k] ? '✓' : '✕'} ${n}</span>`).join('')}</div>
      ${e.info.clone ? '<div class="warn" style="margin-top:10px">تدّعي القطعة إصدارًا حديثًا لكن تنقصها أوامر أساسية — غالبًا نسخة مقلّدة. بعض وظائف طبقة المصنّع قد لا تعمل.</div>' : ''}
      ${t?.discovered?.length ? `<details class="acc" style="margin-top:12px"><summary>خدمات BLE المكتشفة (${t.discovered.length})</summary><div class="acc-body mono small">${t.discovered.map(s => `${esc(s.uuid)}: ${s.chars.map(ch => `${esc(ch.uuid)} [${esc(ch.p.join(','))}]`).join(' · ')}`).join('<br>')}</div></details>` : ''}`
      : '<div class="empty">تظهر التفاصيل بعد الاتصال</div>'}
    </div>
    <div class="card"><h2>تعريف السيارة</h2>
      <div class="small muted">يُقرأ رقم الهيكل تلقائيًا عند الاتصال (AutoVIN). يمكنك إدخاله أو اختيار السيارة يدويًا.</div>
      <label class="f">رقم الهيكل VIN</label><input type="text" id="vVin" class="mono" maxlength="17" value="${esc(v.vin || '')}" placeholder="17 خانة">
      <div class="grid g3" style="gap:8px"><div><label class="f">الشركة</label><input type="text" id="vMake" value="${esc(v.make || '')}" list="makes"></div><div><label class="f">الطراز</label><input type="text" id="vModel" value="${esc(v.model || '')}"></div><div><label class="f">السنة</label><input type="number" id="vYear" value="${esc(v.year || '')}"></div></div>
      <datalist id="makes">${['Chevrolet', 'GMC', 'Cadillac', 'Ford', 'Toyota', 'Lexus', 'Nissan', 'Hyundai', 'Kia', 'Honda', 'Mazda', 'Mitsubishi', 'BMW', 'Mercedes-Benz', 'Volkswagen', 'Audi', 'Jeep', 'Dodge', 'Ram'].map(m => `<option value="${m}">`).join('')}</datalist>
      <div class="grid g2" style="gap:8px"><div><label class="f">المكينة (وصف)</label><input type="text" id="vEng" value="${esc(v.engine || '')}" placeholder="مثال: V8 6.2L"></div><div><label class="f">سعة المكينة (لتر) — للتقديرات</label><input type="number" step="0.1" id="vDisp" value="${esc(vehDisplacement() || '')}"></div></div>
      <label class="f" style="margin-top:10px">تعديلات على السيارة <span class="dim small">(تغيّر ترجيح أسباب الأعطال في «محلّل الأعطال»)</span></label>
      <div class="row wrap small" style="gap:6px 14px">${[['mSwap', 'swap', 'المكينة مركّبة (سواب)'], ['mTune', 'tune', 'برمجة الكمبيوتر معدّلة (تيون)'], ['mAfm', 'afmOff', 'بدون نظام AFM'], ['mO2', 'rearO2Off', 'الحساسات/الدبات الخلفية ملغاة'], ['mAbs', 'absKill', 'فيها قاطع ABS']].map(([id, k, t]) => `<label class="chk"><input type="checkbox" id="${id}" ${v.mods?.[k] ? 'checked' : ''}> ${t}</label>`).join('')}</div>
      <input type="text" id="mNotes" value="${esc(v.mods?.notes || '')}" placeholder="ملاحظات: مثال مكينة LS3 6.2، الكمبيوتر مقفول على التيونر" style="margin-top:6px">
      <div class="btn-row" style="margin-top:12px"><button class="btn primary" id="vSave">حفظ</button>${connected() ? '<button class="btn" id="vAuto">قراءة VIN تلقائيًا</button>' : ''}</div>
      <div id="vInfo" class="small" style="margin-top:8px"></div>
    </div>
    <div class="card"><h2>طرفية الأوامر</h2><div class="small muted">إرسال أمر AT أو OBD مباشرة للقطعة (للمتقدمين). الرد يُعرض كما هو.</div>
      <div class="row" style="margin-top:10px"><input type="text" id="term" class="mono" placeholder="مثال: ATRV أو 0100" ${connected() || app.conn.state === 'adapter' ? '' : 'disabled'}><button class="btn" id="termGo" ${connected() || app.conn.state === 'adapter' ? '' : 'disabled'}>إرسال</button></div>
      <div class="warn small" style="margin-top:8px">أوامر مثل 04 (مسح) أو 14 أو 2F أو 31 تنفّذ فعليًا في السيارة، فيُطلب تأكيد قبل إرسالها؛ وأوامر البرمجة وتغيير إعدادات القطعة الدائمة محظورة. إعدادات القطعة التي تغيّرها هنا تُعاد تلقائيًا قبل أي فحص أو قراءة.</div>
      <div class="log" id="termOut" style="margin-top:8px"></div>
    </div></div>`;
    wireConnectButtons(c, draw);
    $('#cDisc', c)?.addEventListener('click', async () => { await disconnect(); draw(); });
    const showLog = () => { const l = $('#connLog', c); if (l && app.conn.elm) { l.textContent = app.conn.elm.log.slice(-80).join('\n'); l.scrollTop = 1e9; } };
    showLog();
    $('#vVin', c).oninput = e => { const d = decodeVin(e.target.value); $('#vInfo', c).innerHTML = d.valid ? `${esc(d.make || 'الشركة غير موجودة في الجدول')} · سنة الموديل ${d.year || '?'} ${d.checkOk ? conf('sure') + ' رقم التحقق صحيح' : '<span style="color:var(--am)">رقم التحقق لا يطابق (قد يكون طبيعيًا خارج أمريكا الشمالية)</span>'}` : e.target.value.length ? `${e.target.value.length}/17` : ''; };
    $('#vVin', c).dispatchEvent(new Event('input'));
    $('#vSave', c).onclick = async () => {
      const vin = $('#vVin', c).value.trim().toUpperCase();
      const disp = parseFloat($('#vDisp', c).value) || null;
      const { saveSettings } = await import('./store.js');
      saveSettings({ displacement: disp });
      // the engine size belongs to this car (saved with its VIN), not to every car
      setVehicle({ vin: vin || undefined, make: $('#vMake', c).value.trim() || undefined, model: $('#vModel', c).value.trim() || undefined, year: parseInt($('#vYear', c).value) || undefined, engine: $('#vEng', c).value.trim() || undefined, displacement: disp, mods: { swap: $('#mSwap', c).checked, tune: $('#mTune', c).checked, afmOff: $('#mAfm', c).checked, rearO2Off: $('#mO2', c).checked, absKill: $('#mAbs', c).checked, notes: $('#mNotes', c).value.trim() }, source: vin && vin === app.vehicle.vin && app.vehicle.source === 'auto' ? 'auto' : 'manual' });
      toast('تم حفظ بيانات السيارة', 'ok'); draw();
    };
    $('#vAuto', c)?.addEventListener('click', async () => { try { const vin = await readVinNow(); toast(vin ? 'VIN: ' + vin : 'السيارة لم ترسل رقم الهيكل عبر Mode 09', vin ? 'ok' : 'warn'); } catch (e) { toast(e.message, 'err'); } draw(); });
    const run = async () => {
      const raw = $('#term', c).value.trim(); if (!raw || !app.conn.elm) return;
      const cmd = raw.toUpperCase().replace(/\s+/g, '');
      // never in the middle of a scan: a raw command would change the header the scan is using
      if (app.busy) { toast(`انتظر حتى ينتهي: ${app.busy.label}`, 'warn'); return; }
      const chk = terminalCheck(cmd);
      if (chk.block) { toast(chk.block, 'err'); return; }
      if (chk.danger && !(await confirmAction({ title: 'أمر ينفّذ فعليًا في السيارة', what: `<span class="mono">${esc(cmd)}</span> — ${esc(chk.danger)}. الصفحات المخصصة لهذا الإجراء تعرض الشروط والتحذيرات بالتفصيل.`, reversible: null, danger: true, typeWord: 'نفّذ' }))) return;
      if (!app.conn.elm || app.busy) return;
      const out = $('#termOut', c);
      const r = await app.conn.elm.send(cmd, 8000);
      if (chk.dirty && app.conn.elm) app.conn.elm.dirty = true; // the app restores its adapter settings before its next request
      out.textContent += `> ${raw}\n${r.trim()}\n`; out.scrollTop = 1e9; $('#term', c).value = '';
    };
    $('#termGo', c).onclick = run; $('#term', c).onkeydown = e => { if (e.key === 'Enter') run(); };
  };
  offs.push(bus.on('conn', ({ state }) => { if (state !== 'connecting') draw(); }));
  offs.push(bus.on('elmlog', () => { const l = $('#connLog', c); if (l && app.conn.elm) { l.textContent = app.conn.elm.log.slice(-80).join('\n'); l.scrollTop = 1e9; } }));
  draw();
  return () => offs.forEach(f => f());
}

/* =========================== Network map =========================== */
export function nodeOf(e) {
  const n = (e.dtcs?.stored?.length || 0) + (e.dtcs?.pending?.length || 0) + (e.dtcs?.perm?.length || 0) + (e.dtcs?.mfr?.length || 0);
  return { key: e.key, name: e.name, addr: e.addr, status: e.status || 'ok', badge: e.status === 'fault' ? `${n} عطل` : e.status === 'partial' ? 'يرد — أعطال غير مقروءة' : undefined };
}
export function mapView(c) {
  const offs = []; let sel = null;
  try { sel = new URLSearchParams(location.hash.split('?')[1] || '').get('k'); } catch {}
  const draw = () => {
    const nodes = [...app.ecus.values()].map(nodeOf);
    const idle = connected() && !app.busy;
    c.innerHTML = `<div class="card glow"><div class="card-head"><h2>خريطة الكمبيوترات التي ترد</h2><span class="sp"></span>
      <button class="btn sm" id="mScan" ${idle ? '' : 'disabled'}>مسح سريع للكمبيوترات</button><button class="btn sm" id="mScanFull" ${idle ? '' : 'disabled'}>مسح موسّع</button></div>
      <div class="legend" style="margin-bottom:8px">${Object.entries(NODE_COLORS).map(([, [col, l]]) => `<span><i style="background:${col}"></i>${l}</span>`).join('')}</div>
      <div id="mProg">${busyBox()}</div>
      ${nodes.length ? `<div class="netmap" id="mSvg">${netmapSvg(nodes, { busName: app.conn.elm?.info.protocolName || 'الشبكة' })}</div>` : `<div class="empty"><div class="big">⬡</div>${connected() ? 'اضغط «مسح سريع» لاكتشاف الكمبيوترات' : 'اتصل بالسيارة أولًا'}</div>`}
      ${app.scanNote ? `<div class="warn" style="margin-top:8px">${esc(app.scanNote)}</div>` : ''}
      <div class="hint" style="margin-top:10px">الطبقة القياسية (الكمبيوترات التي ترد على طلب OBD العام) ${conf('sure')}. الكمبيوترات الأخرى تُكتشف بمسح العناوين الفيزيائية ${conf('best')}، وأسماؤها من المكتبة المرجعية أو مما يرسله الكمبيوتر نفسه، وإلا تُعرض بعنوانها فقط. كل مسح يبدأ بقائمة نظيفة.</div>
    </div>
    <div id="mDetail" style="margin-top:16px"></div>`;
    wireBusy(c);
    $('#mSvg', c)?.addEventListener('click', e => { const n = e.target.closest('.node'); if (n) { sel = n.dataset.key; detail(true); } });
    const doScan = full => async () => {
      if (!requireConn()) return;
      try { await moduleScan(full); toast('اكتمل مسح الكمبيوترات', 'ok'); } catch (e) { toast(e.message, 'err'); }
    };
    $('#mScan', c).onclick = doScan(false); $('#mScanFull', c).onclick = doScan(true);
    if (sel) detail(false);
  };
  const detail = scroll => {
    const box = $('#mDetail', c); const e = app.ecus.get(sel);
    if (!box) return;
    if (sel === '__adapter') { box.innerHTML = `<div class="card"><h2>قطعة الفحص</h2><p>${esc(app.conn.transport?.name || '—')} · ${esc(app.conn.elm?.info.version || '')}</p><a class="btn sm" href="#/connect">التفاصيل</a></div>`; return; }
    if (!e) { box.innerHTML = ''; return; }
    const ident = e.ident ? Object.entries(e.ident).filter(([k]) => k !== 'noUds') : [];
    const names = { 61840: 'VIN', 61847: 'اسم النظام', 61836: 'الرقم التسلسلي', 61845: 'إصدار البرنامج', 61831: 'رقم القطعة', 61834: 'المورّد' };
    box.innerHTML = `<div class="card raised"><div class="card-head"><h2>${esc(e.name)}</h2>${conf(e.conf || 'est')}<span class="badge" style="border-color:${NODE_COLORS[e.status]?.[0]};color:${NODE_COLORS[e.status]?.[0]}">${NODE_COLORS[e.status]?.[1] || ''}</span><span class="sp"></span>
      ${!e.ghost && e.status !== 'unreach' && connected() ? `<button class="btn sm" id="dRe" ${app.busy ? 'disabled' : ''}>إعادة القراءة</button><button class="btn sm danger" id="dClr" ${app.busy ? 'disabled' : ''}>مسح أعطال هذا الكمبيوتر</button>${e.mod || e.std ? `<a class="btn sm" href="#/services?k=${encodeURIComponent(e.key)}">الخدمات والتحكّم</a>` : ''}` : ''}</div>
      <dl class="kv"><dt>العنوان</dt><dd class="mono">${esc(e.addr || '—')}</dd>${e.nameSrc ? `<dt>مصدر الاسم</dt><dd>${esc(e.nameSrc)}</dd>` : ''}${e.proto ? `<dt>بروتوكول التشخيص</dt><dd>${esc(e.proto)}</dd>` : ''}${e.ecuName ? `<dt>اسم الكمبيوتر (Mode 9)</dt><dd>${esc(e.ecuName)}</dd>` : ''}
      ${ident.map(([k, v]) => `<dt>${esc(names[k] || k)}</dt><dd class="mono">${esc(v)}</dd>`).join('')}
      ${e.pids ? `<dt>قيم قياسية مدعومة</dt><dd>${e.pids.size}</dd>` : ''}</dl>
      ${e.note ? `<div class="hint" style="margin-top:10px">${esc(e.note)}</div>` : ''}${e.readError ? `<div class="warn" style="margin-top:10px">${esc(e.readError)}</div>` : ''}
      <div style="margin-top:10px">${dtcListOf(e) || (e.ghost || e.status === 'unreach' ? '' : '<div class="ok-box">لا توجد أعطال مسجّلة في هذا الكمبيوتر</div>')}</div>${moduleWiringHtml(e)}</div>`;
    $('#dRe', box)?.addEventListener('click', async ev => { ev.currentTarget.disabled = true; try { await rereadVerified(e); toast('تمت إعادة القراءة', 'ok'); } catch (er) { toast(er.message, 'err'); } draw(); });
    $('#dClr', box)?.addEventListener('click', () => clearOne(e, draw));
    if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); // only when the person picked a computer
  };
  offs.push(bus.on('data', () => { if (!app.scanning) draw(); })); // also fires when an operation ends
  offs.push(bus.on('scan', ({ running }) => { if (running) draw(); }));
  offs.push(bus.on('conn', ({ state }) => { if (state !== 'connecting') draw(); }));
  offs.push(onProgress(c));
  draw();
  return () => offs.forEach(f => f());
}
export function dtcListOf(e) {
  const rows = [];
  for (const k of ['stored', 'pending', 'perm']) (e.dtcs?.[k] || []).forEach(code => rows.push(dtcRow(code, k, { ff: ffFor(e.ecu, code) })));
  (e.dtcs?.mfr || []).forEach(d => rows.push(dtcRow(d.code, d.kind, { extra: `<span class="badge vi">طبقة المصنّع ${d.ftb != null ? '· نوع الخلل 0x' + hex2(d.ftb) : ''}</span>${d.active ? '<span class="badge err">نشط الآن</span>' : ''}` })));
  return rows.join('');
}
// A freeze frame belongs to exactly one code (the one the computer names in PID 02); it is never
// shown under other codes, and not at all when the computer did not say which code stored it.
function ffFor(ecu, code) {
  const f = app.freeze.get(ecu);
  if (!f || !f.items?.length || !f.dtc || f.dtc !== code) return '';
  return `<details class="acc" style="margin-top:6px"><summary>📸 لقطة الحظة (Freeze Frame) ${conf('sure')}</summary><div class="acc-body"><table class="tbl"><tbody>${f.items.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${esc(i.text)} ${esc(i.unit || '')}</td></tr>`).join('')}</tbody></table></div></details>`;
}
export async function clearOne(e, after) {
  const srs = (e.dtcs?.mfr || []).some(d => /^B00/.test(d.code));
  const ok = await confirmAction({
    title: e.std ? 'مسح الأعطال القياسية (Mode 04)' : `مسح أعطال ${e.name}`,
    what: e.std ? 'أمر المسح القياسي يُرسل لكل كمبيوترات الانبعاثات معًا (لا يمكن حصره بكمبيوتر واحد).' : 'سيتم إرسال أمر مسح الأعطال لهذا الكمبيوتر فقط.',
    extra: `<ul class="small"><li>تُمسح الأكواد ولقطة الحظة ونتائج الاختبارات الذاتية.</li>${e.std ? '<li>تُصفَّر الجاهزية (Readiness) وتحتاج السيارة دورة قيادة كاملة قبل الفحص الدوري.</li><li>الأكواد الدائمة (Permanent) لا تُمسح بالأداة؛ تزول وحدها بعد نجاح الاختبار.</li>' : ''}<li>المسح لا يصلح العطل؛ إن كان حقيقيًا سيرجع الكود.</li></ul>${srs ? '<div class="danger">⚠ هذا كمبيوتر وسائد هوائية: إطفاء اللمبة يخفي التحذير فقط. إن كان العطل حقيقيًا قد لا تعمل الوسادة وقت الحادث.</div>' : ''}`,
    reversible: false, danger: true, typeWord: srs ? 'أفهم' : null,
  });
  if (!ok) return;
  let res;
  try { res = await clearVerified([e]); } catch (er) { toast(er.message, 'err'); after?.(); return; }
  const r = res[0] || { ok: false };
  if (!r.ok) { toast('لم ينجح المسح: ' + (r.error || 'رفض'), 'err'); after?.(); return; }
  const left = e.std ? app.allDtcs().filter(d => d.kind === 'stored' && !d.mfr).length : (e.dtcs?.mfr?.filter(d => d.kind === 'stored').length || 0);
  toast(left ? `نُفّذ المسح لكن ${left} كود رجع فورًا — العطل ما زال قائمًا` : 'نُفّذ المسح وتأكّدنا بإعادة القراءة: لا أكواد مخزّنة الآن', left ? 'warn' : 'ok');
  after?.();
}

/* =========================== Full scan =========================== */
export function scanView(c) {
  const offs = [];
  const opt = { modules: true, full: false }; // the person's choices survive redraws
  const draw = () => {
    const ecus = [...app.ecus.values()];
    const dt = app.allDtcs();
    const busy = !!app.busy;
    const faulty = ecus.filter(e => e.status === 'fault'), clean = ecus.filter(e => e.status === 'ok' || e.status === 'partial'), silent = ecus.filter(e => e.status === 'noresp' || e.status === 'unreach');
    c.innerHTML = `${connected() ? '' : connectCta()}
    <div class="card glow" style="margin-top:${connected() ? 0 : 16}px"><div class="card-head"><h2>الفحص الشامل لكل الكمبيوترات</h2><span class="sp"></span>
      <label class="chk small"><input type="checkbox" id="sMods" ${opt.modules ? 'checked' : ''} ${busy ? 'disabled' : ''}> يشمل كمبيوترات المصنّع (أفضل جهد)</label>
      <label class="chk small"><input type="checkbox" id="sFull" ${opt.full ? 'checked' : ''} ${busy || !opt.modules ? 'disabled' : ''}> مسح عناوين موسّع (أبطأ)</label>
      <button class="btn primary lg" id="sGo" ${connected() && !busy ? '' : 'disabled'}>${busy ? 'جارٍ…' : '✚ ابدأ الفحص'}</button></div>
      ${busyBox()}
      ${busy ? '<div class="small dim" style="margin-top:6px">نتائج الفحص السابق مخفية حتى يكتمل هذا الفحص — كل فحص يبدأ من الصفر، وإن لم يكتمل تبقى النتائج السابقة كما هي.</div>' : ''}
      ${app.lastScan && !busy ? `<div class="small dim">آخر فحص: ${fmtDate(app.lastScan.t)}${app.lastScan.demo ? ' (تجريبي)' : ''}</div>` : ''}
    </div>
    ${!busy && (app.lastScan || dt.length) ? `
    <div class="grid g4" style="margin-top:16px">
      <div class="card"><div class="kpi"><div class="v" style="color:${dt.length ? 'var(--rd)' : 'var(--gr)'}">${dt.length}</div><div class="l">إجمالي الأعطال</div></div></div>
      <div class="card"><div class="kpi"><div class="v" style="color:var(--rd)">${faulty.length}</div><div class="l">كمبيوترات فيها عطل</div></div></div>
      <div class="card"><div class="kpi"><div class="v" style="color:var(--gr)">${clean.length}</div><div class="l">كمبيوترات سليمة</div></div></div>
      <div class="card"><div class="kpi"><div class="v" style="color:var(--tx3)">${silent.length}</div><div class="l">لا يرد / خارج الوصول</div></div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>النتائج لكل كمبيوتر</h2><span class="sp"></span>
      ${canSpeak() ? '<button class="btn sm" id="sSpeak">🔊 قراءة النتائج</button>' : ''}
      <button class="btn sm danger" id="sClrAll" ${connected() && dt.length ? '' : 'disabled'}>مسح الكل…</button></div>
      <div class="list">${ecus.map(e => {
        const n = (e.dtcs?.stored?.length || 0) + (e.dtcs?.pending?.length || 0) + (e.dtcs?.perm?.length || 0) + (e.dtcs?.mfr?.length || 0);
        const col = NODE_COLORS[e.status]?.[0] || '#8a96a8';
        return `<details class="acc" ${n ? 'open' : ''}><summary><span class="dot" style="background:${col};box-shadow:0 0 8px ${col}"></span><b>${esc(e.name)}</b> <span class="mono dim small">${esc(e.addr || '')}</span>${conf(e.conf || 'est')}<span class="sp" style="flex:1"></span>
          <span class="badge" style="color:${col};border-color:${col}">${n ? n + ' عطل' : NODE_COLORS[e.status]?.[1] || ''}</span></summary>
          <div class="acc-body">${dtcListOf(e) || `<div class="small muted">${e.note ? esc(e.note) : e.readError ? esc(e.readError) : 'لا توجد أعطال.'}</div>`}
          ${!e.ghost && e.status !== 'unreach' && n && connected() ? `<div class="btn-row" style="margin-top:8px"><button class="btn sm danger" data-clr="${esc(e.key)}">مسح أعطال هذا الكمبيوتر</button></div>` : ''}</div></details>`;
      }).join('')}</div></div>` : ''}`;
    $('#sGo', c).onclick = run;
    $('#sMods', c).onchange = e => { opt.modules = e.target.checked; if (!opt.modules) opt.full = false; draw(); };
    $('#sFull', c).onchange = e => { opt.full = e.target.checked; };
    wireBusy(c);
    $('#sClrAll', c)?.addEventListener('click', clearAll);
    $('#sSpeak', c)?.addEventListener('click', () => speak(dt.length ? `يوجد ${dt.length} عطل. ` + faulty.map(e => `${e.name}: ${[...(e.dtcs?.stored || []), ...(e.dtcs?.pending || []), ...(e.dtcs?.perm || []), ...(e.dtcs?.mfr || []).map(d => d.code)].map(x => describeDtc(x).text).join('، ')}`).join('. ') : 'لا توجد أعطال في أي كمبيوتر'));
    $$('[data-clr]', c).forEach(b => b.onclick = () => { const e = app.ecus.get(b.dataset.clr); if (e) clearOne(e, draw); });
  };
  const run = async () => {
    try {
      const rec = await fullScan({ modules: opt.modules, fullRange: opt.modules && opt.full });
      toast(rec.dtcs.length ? `اكتمل الفحص: ${rec.dtcs.length} عطل` : 'اكتمل الفحص: لا أعطال', rec.dtcs.length ? 'warn' : 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  const clearAll = async () => {
    const list = [...app.ecus.values()].filter(e => !e.ghost && e.status === 'fault');
    const srs = list.some(e => (e.dtcs?.mfr || []).some(d => /^B00/.test(d.code)));
    const ok = await confirmAction({
      title: 'مسح أعطال كل الكمبيوترات', what: `سيتم إرسال أمر المسح القياسي (Mode 04) ثم أمر المسح لكل كمبيوتر من طبقة المصنّع فيه أعطال (${list.filter(e => !e.std).length}).`,
      extra: `<ul class="small"><li>تُمسح الأكواد ولقطات الحظة ونتائج الاختبارات وتُصفَّر الجاهزية.</li><li>الأكواد الدائمة لا تُمسح بالأداة.</li><li>المسح لا يصلح الأعطال.</li></ul>${srs ? '<div class="danger">⚠ يشمل كمبيوتر الوسائد الهوائية: إطفاء اللمبة يخفي التحذير فقط، وقد لا تعمل الوسادة وقت الحاجة إن كان العطل حقيقيًا.</div>' : ''}`,
      reversible: false, danger: true, typeWord: 'امسح',
    });
    if (!ok) return;
    // the standard Mode 04 always goes out (it is what clears the engine computers), plus each faulty manufacturer module
    const std = [...app.ecus.values()].find(e => e.std);
    let res;
    try { res = await clearVerified([...(std ? [std] : []), ...list.filter(e => !e.std)]); } catch (er) { toast(er.message, 'err'); return; }
    const left = app.allDtcs().filter(d => d.kind === 'stored');
    await modal('نتيجة المسح', `<ul>${res.map(r => `<li>${esc(r.name)}: ${r.ok ? 'نجح' : 'فشل — ' + esc(r.error || 'رفض')}</li>`).join('')}</ul>${left.length ? `<div class="warn">رجعت أكواد فورًا بعد المسح: ${left.map(d => esc(d.code)).join('، ')} — العطل ما زال قائمًا.</div>` : '<div class="ok-box">أعدنا القراءة: لا أكواد مخزّنة الآن.</div>'}`);
    draw();
  };
  offs.push(bus.on('conn', () => draw()));
  offs.push(bus.on('scan', ({ running }) => { if (running) draw(); }));
  offs.push(bus.on('data', () => { if (!app.scanning) draw(); })); // an operation ended (here or on another page)
  offs.push(onProgress(c));
  draw();
  return () => offs.forEach(f => f());
}

/* =========================== Codes & OBD modes =========================== */
export function codesView(c) {
  let tab = 'dtc';
  const offs = [];
  const draw = () => {
    c.innerHTML = `<div class="seg" id="cTabs" style="margin-bottom:14px;flex-wrap:wrap">${[['dtc', 'الأعطال'], ['ff', 'لقطة الحظة'], ['m6', 'الاختبارات الذاتية (Mode 6)'], ['m5', 'حساسات O2 (Mode 5)'], ['m9', 'معلومات السيارة (Mode 9)'], ['m8', 'اختبارات التحكم (Mode 8)']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>${busyBox()}<div id="cBody"></div>`;
    $$('#cTabs button', c).forEach(b => b.onclick = () => { tab = b.dataset.t; draw(); });
    wireBusy(c);
    ({ dtc: tabDtc, ff: tabFf, m6: tabM6, m5: tabM5, m9: tabM9, m8: tabM8 })[tab]($('#cBody', c));
  };
  const btn = (id, label) => `<button class="btn" id="${id}" ${connected() && !app.busy ? '' : 'disabled'}>${label}</button>${connected() ? '' : ' <span class="small dim">اتصل أولًا</span>'}`;
  // every read is one exclusive operation; errors are shown, the button never stays spinning
  const act = (b, id, job, after) => $(id, b)?.addEventListener('click', async e => {
    const el = e.currentTarget; el.disabled = true; el.innerHTML = '<span class="spin"></span>';
    try { const r = await job(); after?.(r); } catch (er) { toast(er.message, 'err'); }
    draw();
  });
  const tabDtc = b => {
    const rows = [];
    for (const e of app.ecus.values()) { const l = dtcListOf(e); if (l) rows.push(`<div class="card" style="margin-bottom:12px"><h3>${esc(e.name)} <span class="mono dim small">${esc(e.addr || '')}</span></h3>${l}</div>`); }
    b.innerHTML = `<div class="card" style="margin-bottom:12px"><div class="row wrap"><div style="flex:1">قراءة المخزّنة (03) والمعلّقة (07) والدائمة (0A) من كل الكمبيوترات القياسية ${conf('sure')}</div>${btn('cRead', 'قراءة الآن')}<a class="btn" href="#/scan">الفحص الشامل</a></div></div>
      ${rows.join('') || `<div class="card"><div class="empty">${app.lastScan ? 'لا توجد أعطال 👍' : 'لم تتم القراءة بعد'}</div></div>`}`;
    act(b, '#cRead', readStdCodes);
  };
  const tabFf = b => {
    const ent = [...app.freeze.entries()];
    const items = ent.filter(([, f]) => f.items?.length), none = ent.filter(([, f]) => f.none);
    const nm = ecu => esc(app.ecus.get('std:' + ecu)?.name || ecu);
    b.innerHTML = `<div class="card"><div class="row wrap" style="margin-bottom:10px"><div style="flex:1">لقطة الحظة: القيم لحظة تسجيل العطل ${conf('sure')}</div>${btn('fRead', 'قراءة')}</div>
      ${items.map(([ecu, f]) => `<h3>${nm(ecu)} — الكود المسبّب: ${f.dtc ? `<span class="mono">${esc(f.dtc)}</span>` : '<span class="dim">غير معروف (الكمبيوتر لم يذكره)</span>'}</h3><div class="tbl-wrap"><table class="tbl"><tbody>${f.items.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${esc(i.text)} ${esc(i.unit || '')}</td></tr>`).join('')}</tbody></table></div>`).join('')}
      ${none.map(([ecu]) => `<div class="small muted" style="margin:6px 0">${nm(ecu)}: لا توجد لقطة محفوظة (الكمبيوتر أفاد بعدم تسجيل لقطة)</div>`).join('')}
      ${items.length || none.length ? '' : '<div class="empty">لا توجد لقطة محفوظة (أو لم تُقرأ بعد)</div>'}</div>`;
    act(b, '#fRead', readFreeze);
  };
  const tabM6 = b => {
    const m = app.mode06;
    let body = '<div class="empty">لم تُقرأ بعد</div>';
    if (m?.legacy) body = `<div class="warn">السيارة على بروتوكول قديم: صيغة Mode 6 فيه خاصة بالمصنّع. الرد الخام: <span class="mono">${esc(m.raw)}</span> ${conf('est')}</div>`;
    else if (m?.map?.size) body = [...m.map.entries()].map(([ecu, rows]) => `<h3>${esc(app.ecus.get('std:' + ecu)?.name || ecu)}</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>المراقب</th><th>الاختبار</th><th>القيمة</th><th>الحد الأدنى</th><th>الحد الأعلى</th><th>النتيجة</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(r.midName)}</td><td class="small">${esc(r.tidName)}</td><td class="num">${fmt(r.value)} ${esc(r.unit)}</td><td class="num dim">${fmt(r.min)}</td><td class="num dim">${fmt(r.max)}</td><td>${r.pass ? '<span class="badge ok">ناجح</span>' : '<span class="badge err">راسب</span>'} ${r.known ? '' : conf('est')}</td></tr>`).join('')}</tbody></table></div>`).join('');
    else if (m) body = '<div class="empty">الكمبيوتر لم يعلن عن نتائج Mode 6</div>';
    b.innerHTML = `<div class="card"><div class="row wrap" style="margin-bottom:10px"><div style="flex:1">نتائج الاختبارات الذاتية للمراقبات (يشمل عدّادات الاحتراق الناقص لكل سلندر إن توفرت) ${conf('sure')}</div>${btn('m6Read', 'قراءة')}</div>${m?.error ? `<div class="warn" style="margin-bottom:8px">تعذّرت القراءة: ${esc(m.error)}</div>` : ''}${body}</div>`;
    act(b, '#m6Read', readMode06);
  };
  let m5 = null, m8 = null; // results kept here so a redraw does not wipe them
  const tabM5 = b => {
    const r = m5;
    const out = !r ? (app.conn.elm?.isCan ? '<div class="hint">سيارتك على شبكة CAN: المعيار لا يدعم Mode 5 على CAN، ونتائج حساسات الأكسجين موجودة في تبويب Mode 6.</div>' : '')
      : r.notOnCan ? '<div class="hint">غير مدعوم على CAN — راجع Mode 6.</div>'
      : r.rows.length ? `<table class="tbl"><thead><tr><th>الحساس</th><th>الاختبار</th><th>القيمة</th><th>الحدود</th></tr></thead><tbody>${r.rows.map(x => `<tr><td>${esc(x.sensor)}</td><td>${esc(x.name)}</td><td class="num">${x.value.toFixed(3)} ${x.unit}</td><td class="num dim">${x.min != null ? x.min.toFixed(3) : '—'} – ${x.max != null ? x.max.toFixed(3) : '—'}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">لا نتائج (${esc(r.error || 'الكمبيوتر لم يرد')})</div>`;
    b.innerHTML = `<div class="card"><div class="row wrap" style="margin-bottom:10px"><div style="flex:1">اختبارات حساسات الأكسجين (Mode 5)</div>${btn('m5Read', 'قراءة')}</div><div id="m5Out">${out}</div></div>`;
    act(b, '#m5Read', () => exclusive('قراءة Mode 5', () => app.obd.mode05()), res => { m5 = res; });
  };
  const tabM9 = b => {
    const m = app.mode09;
    b.innerHTML = `<div class="card"><div class="row wrap" style="margin-bottom:10px"><div style="flex:1">معلومات السيارة والكمبيوترات (Mode 9) ${conf('sure')}</div>${btn('m9Read', 'قراءة')}</div>
      ${m?.size ? [...m.entries()].map(([ecu, i]) => `<h3>${esc(app.ecus.get('std:' + ecu)?.name || ecu)}</h3><dl class="kv">
        ${i.vin ? `<dt>VIN</dt><dd class="mono">${esc(i.vin)}</dd>` : ''}${i.ecuName ? `<dt>اسم الكمبيوتر</dt><dd>${esc(i.ecuName)}</dd>` : ''}
        ${i.calid ? `<dt>رقم المعايرة CALID</dt><dd class="mono">${i.calid.map(esc).join('، ')}</dd>` : ''}${i.cvn ? `<dt>CVN</dt><dd class="mono">${i.cvn.map(esc).join('، ')}</dd>` : ''}${i.esn ? `<dt>ESN</dt><dd class="mono">${esc(i.esn)}</dd>` : ''}
        <dt>معلومات مدعومة</dt><dd class="mono small">${i.supported.map(x => '0x' + hex2(x)).join(' ')}</dd></dl>
        ${i.ipt ? `<details class="acc" style="margin-top:8px"><summary>أداء المراقبات أثناء الاستخدام (IPT)</summary><div class="acc-body"><table class="tbl"><tbody>${i.ipt.map(x => `<tr><td class="mono">${esc(x.k)}</td><td class="num">${x.v}</td></tr>`).join('')}</tbody></table></div></details>` : ''}`).join('') : '<div class="empty">لم تُقرأ بعد</div>'}</div>`;
    act(b, '#m9Read', readVinNow);
  };
  const tabM8 = b => {
    const items = m8 ? [...m8.entries()].flatMap(([ecu, s]) => [...s].filter(x => x % 0x20).map(t => ({ ecu, t }))) : null;
    const out = !items ? '' : items.length ? items.map(x => `<div class="row"><span class="mono">TID 0x${hex2(x.t)}</span> — ${x.t === 1 ? 'اختبار تسريب نظام EVAP' : 'اختبار خاص (غير مسمّى في المعيار)'} <span class="dim small">(${esc(app.ecus.get('std:' + x.ecu)?.name || x.ecu)})</span></div>`).join('') : '<div class="empty">لا يعلن الكمبيوتر عن اختبارات Mode 8</div>';
    b.innerHTML = `<div class="card"><div class="row wrap" style="margin-bottom:10px"><div style="flex:1">اختبارات التحكم القياسية التي يعلنها الكمبيوتر (مثل اختبار تسريب EVAP) ${conf('sure')}</div>${btn('m8Read', 'اكتشاف')}</div><div id="m8Out">${out}</div><div class="small dim">التنفيذ من صفحة «الخدمات والتحكّم».</div></div>`;
    act(b, '#m8Read', () => exclusive('اكتشاف اختبارات Mode 8', () => app.obd.mode08Supported()), res => { m8 = res; });
  };
  // results of an operation started elsewhere (or a scan finishing) show up here without leaving
  offs.push(bus.on('scan', ({ running }) => { if (running) draw(); }));
  offs.push(bus.on('data', () => { if (!app.scanning) draw(); }));
  offs.push(onProgress(c));
  draw();
  return () => offs.forEach(f => f());
}
const fmt = v => (v == null ? '—' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));

/* =========================== Readiness =========================== */
export function readyView(c) {
  const offs = [];
  const nameOf = ecu => app.ecus.get('std:' + ecu)?.name || ecu;
  const monGrid = r => `<div class="grid g3">${r.mons.map(m => `<div class="mon ${!m.sup ? 'r-na' : m.ready ? 'r-ok' : 'r-no'}"><div class="ic">${!m.sup ? '–' : m.ready ? '✓' : '…'}</div><div><div>${esc(m.name)}</div><div class="small dim">${!m.sup ? 'غير مدعوم' : m.ready ? 'جاهز' : 'غير جاهز'}${m.cont ? ' · مراقبة مستمرة' : ''}${r.cycle ? ` · هذه الدورة: ${(() => { const cm = r.cycle.mons.find(x => x.name === m.name); return !cm || !cm.sup ? '—' : cm.ready ? 'اكتمل' : 'لم يكتمل'; })()}` : ''}</div></div></div>`).join('')}</div>`;
  const draw = () => {
    const entries = [...app.readiness.entries()];
    // one verdict for the car: all emission computers combined (SAE J1979 rules)
    const all = app.readinessAll(), st = readinessStats(all);
    const year = app.vehicle.year;
    const allowed = year && year < 2001 ? 2 : 1;
    const pass = all && !all.mil && st.notReady.length <= allowed;
    const multi = entries.length > 1;
    c.innerHTML = `<div class="card glow"><div class="card-head"><h2>الجاهزية للفحص الدوري (Readiness / I/M)</h2><span class="sp"></span><button class="btn primary" id="rRead" ${connected() && !app.busy ? '' : 'disabled'}>قراءة الجاهزية</button></div>
      <div class="small muted">كل نظام انبعاثات يختبر نفسه أثناء القيادة. بعد مسح الأعطال أو فصل البطارية تصبح الأنظمة «غير جاهزة» حتى تكتمل دورة القيادة.</div>${busyBox()}</div>
      ${all ? `<div class="grid g4" style="margin-top:16px">
          <div class="card span2"><div class="kpi"><div class="v" style="color:${pass ? 'var(--gr)' : 'var(--am)'}">${pass ? 'جاهزة غالبًا' : 'غير جاهزة بعد'}</div><div class="l">${multi ? `مجموع ${entries.length} كمبيوترات انبعاثات` : esc(nameOf(entries[0][0]))} — ${all.diesel ? 'ديزل' : 'بنزين'} ${conf('best')} (قاعدة عامة: ${allowed === 2 ? 'حتى نظامين' : 'نظام واحد'} غير مكتمل مسموح ولمبة المكينة مطفأة؛ تختلف حسب الجهة الفاحصة)</div></div></div>
          <div class="card"><div class="kpi"><div class="v" style="color:${all.mil ? 'var(--rd)' : 'var(--gr)'}">${all.mil ? 'مضاءة' : 'مطفأة'}</div><div class="l">لمبة المكينة · ${all.dtcCount} كود مؤكد</div></div></div>
          <div class="card"><div class="kpi"><div class="v">${st.ready}/${st.total}</div><div class="l">الأنظمة المكتملة</div></div></div>
          <div class="card spanall"><h3>حالة كل نظام ${conf('sure')}</h3>${monGrid(multi ? all : entries[0][1])}
          ${multi ? '<div class="small dim" style="margin-top:8px">النظام «جاهز» فقط إذا أكمله كل كمبيوتر يدعمه، واللمبة «مضاءة» إذا أضاءها أي كمبيوتر (معيار SAE J1979). التفاصيل لكل كمبيوتر أدناه.</div>' : ''}</div>
        </div>
        ${multi ? entries.map(([ecu, r]) => { const s = readinessStats(r); return `<details class="acc" style="margin-top:12px"><summary><b>${esc(nameOf(ecu))}</b><span class="sp" style="flex:1"></span>${r.mil ? '<span class="badge err">اللمبة مضاءة</span>' : '<span class="badge ok">اللمبة مطفأة</span>'}<span class="badge">${s.ready}/${s.total}</span></summary><div class="acc-body">${monGrid(r)}</div></details>`; }).join('') : ''}`
      : `<div class="card" style="margin-top:16px"><div class="empty">${connected() ? 'اضغط «قراءة الجاهزية»' : 'اتصل بالسيارة أولًا'}</div></div>`}
      <div class="card" id="rExtra" style="margin-top:16px"></div>`;
    wireBusy(c);
    $('#rRead', c).onclick = async e => {
      e.currentTarget.disabled = true; e.currentTarget.innerHTML = '<span class="spin"></span>';
      try { await readReadiness(); } catch (er) { toast(er.message, 'err'); }
      draw();
    };
    const ex = $('#rExtra', c);
    if (app.readyExtra?.length) ex.innerHTML = `<h3>منذ آخر مسح للأعطال ${conf('sure')}</h3><dl class="kv">${app.readyExtra.map(v => `<dt>${esc(pidName(v.pid))}</dt><dd class="num">${esc(v.text)} ${esc(v.unit)}</dd>`).join('')}</dl>`;
    else ex.remove();
  };
  offs.push(bus.on('scan', ({ running }) => { if (running) draw(); }));
  offs.push(bus.on('data', () => { if (!app.scanning) draw(); }));
  offs.push(bus.on('conn', ({ state }) => { if (state !== 'connecting') draw(); }));
  offs.push(onProgress(c));
  draw();
  return () => offs.forEach(f => f());
}
