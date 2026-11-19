// Phase-2 screens: guided diagnosis, services & bidirectional control, wiring diagrams,
// AI technician, reports & history, settings.
import { $, $$, esc, bus, toast, modal, confirmAction, conf, fmtDate, hex2, hex3, hex4, download, shareFile, uid } from './util.js';
import { app, requireConn, snapshotScan, startLive, stopLive, loadLibrary, finalizeStatuses } from './core.js';
import { PIDS, pidName } from './obd.js';
import { describeDtc } from './dtcdb.js';
import { correlate, circuitFor, getCircuit, CIRCUIT_LIST, chainCheck } from './diag.js';
import { wiringSvg, ROLE } from './widgets.js';
import { SIDS, STD_DIDS, routineBlocked, nrcText } from './network.js';
import { store, settings, saveSettings } from './store.js';
import { aiAvailable, buildContext, askClaude, localAnswer, saveAnswer } from './ai.js';
import { scanReportHtml } from './report.js';
import { clearOne } from './views-core.js';
import { speak, canSpeak, params, go } from './nav.js';

const connected = () => app.conn.ready;
function diagCtx() {
  const m6 = app.mode06?.map ? [...app.mode06.map.values()].flat() : [];
  return { dtcs: app.allDtcs(), live: app.liveValues(), trims: app.trims(), volt: app.conn.voltage, running: app.running(), mode06: m6, displacement: settings().displacement };
}

/* =========================== Guided diagnosis =========================== */
export function diagView(c) {
  const draw = () => {
    const list = correlate(diagCtx());
    const dt = app.allDtcs();
    c.innerHTML = `<div class="card glow"><div class="card-head"><h2>التشخيص الموجّه وربط الأعطال</h2><span class="sp"></span>${connected() ? '<button class="btn" id="gLive">إضافة قراءات حية للتحليل</button>' : ''}<a class="btn" href="#/scan">فحص جديد</a></div>
      <div class="small muted">المحرّك يربط الأعطال ببعضها مع القيم الحية ونتائج الاختبارات الذاتية، ويرجّح السبب الجذري بدل شرح كل كود لحاله. النسب ترجيحية ${conf('est')} وتتحسّن مع البيانات (سجّل «اختبار خلطة الوقود» مثلًا).</div>
      <div class="row wrap small" style="margin-top:8px;gap:6px"><span class="badge">${dt.length} عطل</span><span class="badge">${app.samples.length} عينة حية</span>${app.mode06?.map?.size ? '<span class="badge ok">نتائج Mode 6 متوفرة</span>' : ''}${app.conn.voltage ? `<span class="badge">فولت ${app.conn.voltage.toFixed(1)}V</span>` : ''}</div></div>
      ${list.length ? list.map((d, i) => `<div class="card ${i === 0 ? 'raised' : ''}" style="margin-top:14px"><div class="card-head"><span class="badge ${i === 0 ? 'err' : ''}">#${i + 1}</span><h2>${esc(d.title)}</h2>${conf(d.conf)}${d.safety ? '<span class="badge err">سلامة</span>' : ''}${d.early ? '<span class="badge warn">تحذير مبكر</span>' : ''}<span class="sp"></span>${d.codes.map(x => `<span class="badge mono">${esc(x)}</span>`).join('')}</div>
        <div class="grid g2"><div><h3>الأسباب المرجّحة</h3>${d.causes.map(x => `<div class="row small" style="margin:6px 0"><span style="flex:1">${esc(x.t)}</span><div class="bar" style="width:120px"><i style="width:${Math.round(x.p * 100)}%"></i></div><span class="num" style="width:40px">${Math.round(x.p * 100)}%</span></div>`).join('')}
          <h3 style="margin-top:12px">الأدلة</h3><ul class="small">${d.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>
          <div><h3>خطوات الفحص ونقاط القياس</h3><ol class="small" style="padding-inline-start:18px">${d.steps.map(s => `<li style="margin-bottom:8px">${esc(s.t)}<div class="dim">📍 القياس: ${esc(s.m)} · ✓ المتوقع: ${esc(s.e)}</div></li>`).join('')}</ol>
          <div class="btn-row">${d.circuit ? `<a class="btn sm" href="#/wiring?c=${d.circuit}${d.codes[0] ? '&code=' + d.codes[0] : ''}">المخطط الكهربائي</a>` : ''}<a class="btn sm" href="#/ai?q=${encodeURIComponent('ساعدني في تشخيص: ' + d.title + ' — الأكواد ' + d.codes.join(' '))}">اسأل الفني</a></div></div></div></div>`).join('')
      : `<div class="card" style="margin-top:14px"><div class="empty"><div class="big">✦</div>${app.lastScan ? 'لا توجد أعطال أو قيم غير طبيعية تستدعي التشخيص.' : 'شغّل الفحص الشامل أولًا ليبدأ التحليل.'}</div></div>`}`;
    $('#gLive', c)?.addEventListener('click', async e => {
      e.target.innerHTML = '<span class="spin"></span>';
      const sup = app.pidSupport.get(app.primaryEcu()) || new Set();
      const pids = [0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0c, 0x10, 0x0b, 0x14, 0x42].filter(p => sup.has(p));
      startLive({ fast: pids, rateMs: 300 });
      setTimeout(() => { stopLive(); draw(); toast('أُضيفت قراءات حية للتحليل', 'ok'); }, 12000);
    });
  };
  draw();
  return () => stopLive();
}

/* =========================== Services & bidirectional =========================== */
export function servicesView(c) {
  const pk = params().k;
  let modKey = pk || [...app.ecus.values()].find(e => e.mod)?.key || null;
  const out = {}; // per module results
  const draw = () => {
    const mods = [...app.ecus.values()].filter(e => e.mod);
    const e = app.ecus.get(modKey);
    const r = out[modKey] || {};
    const srsCand = mods.filter(m => (m.dtcs?.mfr || []).some(d => /^B00/.test(d.code)) || /SDM|SRS|airbag|وسائد/i.test(m.name));
    const libItems = (app.lib.routines || []).filter(x => e && parseInt(x.req, 16) === e.req && (!x.make || x.make === app.vehicle.group || x.make === app.vehicle.make));
    c.innerHTML = `<div class="danger" style="margin-bottom:14px">⚠ قبل أي إجراء: السيارة متوقفة، القير على P، فرامل اليد مشدودة، والبطارية مشحونة. البرنامج يطلب التأكيد قبل كل إجراء ويوضّح إن كان قابلًا للتراجع، وينفّذ فقط ما يعلنه الكمبيوتر — ويعرض الرد الحقيقي (نجاح أو رفض وسببه) بدون ادّعاء.</div>
    <div class="grid g2">
      <div class="card"><h2>الخدمات القياسية ${conf('sure')}</h2>
        <div class="list"><div class="row"><div style="flex:1"><b>مسح أعطال الانبعاثات (Mode 04)</b><div class="small dim">يمسح الأكواد ولقطة الحظة ويصفّر الجاهزية</div></div><button class="btn sm danger" id="svClr" ${connected() ? '' : 'disabled'}>مسح…</button></div>
        <div class="row"><div style="flex:1"><b>اختبارات التحكم (Mode 08)</b><div class="small dim">مثل اختبار تسريب EVAP إن أعلنه الكمبيوتر</div></div><button class="btn sm" id="sv8" ${connected() ? '' : 'disabled'}>اكتشاف</button></div><div id="sv8Out"></div></div></div>
      <div class="card"><h2>إطفاء تحذير الوسائد الهوائية</h2>
        ${srsCand.length ? srsCand.map(m => `<div class="row" style="margin:6px 0"><div style="flex:1"><b>${esc(m.name)}</b> <span class="mono small dim">${esc(m.addr)}</span><div class="small dim">${(m.dtcs?.mfr || []).filter(d => /^B00/.test(d.code)).map(d => d.code).join('، ') || ''} ${conf(/SDM|SRS/i.test(m.name) ? 'best' : 'est')} ${/SDM|SRS/i.test(m.name) ? '' : '(مرشّح لأنه يسجّل أكواد SRS)'}</div></div><button class="btn sm danger" data-srs="${esc(m.key)}">إطفاء التحذير…</button></div>`).join('')
        : '<div class="empty small">لم يُكتشف كمبيوتر وسائد هوائية يمكن الوصول له. شغّل «المسح الموسّع» من خريطة الشبكة. إن لم يظهر فهو غير مكشوف عبر هذه القطعة (قد يكون على شبكة لا تصلها).</div>'}
        <div class="warn small" style="margin-top:8px">إطفاء لمبة الوسائد يخفي التحذير فقط ولا يصلح العطل؛ لو كان العطل حقيقيًا قد لا تنفتح الوسادة وقت الحادث.</div></div>
    </div>
    <div class="card raised" style="margin-top:16px"><div class="card-head"><h2>خدمات وتحكّم الكمبيوترات ${conf('best')}</h2><span class="sp"></span>
      ${mods.length ? `<select id="svMod" style="width:auto">${mods.map(m => `<option value="${esc(m.key)}" ${m.key === modKey ? 'selected' : ''}>${esc(m.name)} — ${esc(m.addr)}</option>`).join('')}</select>` : ''}</div>
      ${!mods.length ? `<div class="empty">لا توجد كمبيوترات مكتشفة بالعنونة الفيزيائية بعد. ${connected() ? '<a class="btn sm" href="#/map">مسح الكمبيوترات من الخريطة</a>' : 'اتصل بالسيارة أولًا.'}</div>` : `
      <div class="small muted">يكتشف البرنامج وقت التشغيل ما يعلنه هذا الكمبيوتر: الخدمات، الروتينات (تصفير/تهيئة/إعادة تعلّم/اختبارات)، والاختبارات الفعّالة (تشغيل مباشر للقطع). لا توجد قائمة ثابتة؛ الأسماء من المكتبة المرجعية إن وُجدت وإلا تُعرض بالمعرّف.</div>
      <div class="btn-row" style="margin:12px 0"><button class="btn" id="svDisc">١. اكتشاف الخدمات</button><button class="btn" id="svSec">٢. حالة الوصول الأمني</button></div>
      ${r.services ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>الخدمة</th><th>الحالة</th><th>رد الكمبيوتر</th></tr></thead><tbody>${r.services.map(s => `<tr><td><span class="mono dim">0x${hex2(s.sid)}</span> ${esc(s.name)}</td><td>${s.st === 'yes' ? '<span class="badge ok">مدعومة</span>' : s.st === 'no' ? '<span class="badge">غير مدعومة</span>' : '<span class="badge warn">غير معروف</span>'}</td><td class="small">${esc(s.why)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${r.sec ? `<div class="${r.sec.state === 'locked' ? 'warn' : 'hint'}" style="margin-top:8px">🔐 ${esc(r.sec.text)}</div>` : ''}
      <div class="grid g3" style="margin-top:14px">
        ${scanBox('rt', 'الروتينات (خدمات/تهيئة/إعادة تعلّم)', '0200', '02FF', 'يقرأ نتيجة كل معرّف بأمر آمن (طلب النتيجة) ولا يشغّله. معرّفات إطلاق الوسائد وبرمجة الذاكرة مستبعدة نهائيًا.')}
        ${scanBox('io', 'الاختبارات الفعّالة (Active Test)', '0100', '01FF', 'يرسل «إرجاع التحكم للكمبيوتر» لكل معرّف — أمر آمن لا يحرّك شيئًا.')}
        ${scanBox('did', 'البيانات المحسّنة (قراءة)', 'F180', 'F19F', 'قراءة فقط. القيم الخام تُعرض كما هي؛ تفسيرها يحتاج المكتبة المرجعية.')}
      </div>
      ${resultList(r)}
      ${libItems.length ? `<h3 style="margin-top:14px">من المكتبة المرجعية لهذا الكمبيوتر</h3>${libItems.map((x, i) => `<div class="row" style="margin:6px 0"><div style="flex:1"><b>${esc(x.name)}</b> <span class="mono small dim">${esc(x.kind)} ${esc(x.id)}</span> ${conf(x.conf || 'best')}<div class="small dim">${esc(x.warn || '')}</div></div><button class="btn sm" data-lib="${i}">تنفيذ…</button></div>`).join('')}` : ''}`}
      <div class="hint small" style="margin-top:14px">البرمجة والترميز والفلاشة خارج نطاق هذا البرنامج (تحتاج أدوات منفصلة مثل HP Tuners أو J2534).</div>
    </div>`;
    $('#svMod', c)?.addEventListener('change', ev => { modKey = ev.target.value; draw(); });
    $('#svClr', c)?.addEventListener('click', () => { const std = [...app.ecus.values()].find(x => x.std); if (std) clearOne(std, draw); else toast('لا يوجد كمبيوتر قياسي يرد', 'warn'); });
    $('#sv8', c)?.addEventListener('click', mode8);
    $$('[data-srs]', c).forEach(b => b.onclick = () => clearOne(app.ecus.get(b.dataset.srs), draw));
    if (!e) return;
    $('#svDisc', c).onclick = async ev => { ev.target.innerHTML = '<span class="spin"></span>'; out[modKey] = { ...r, services: await app.mods.discoverServices(e.mod) }; await app.mods.done(); draw(); };
    $('#svSec', c).onclick = async ev => { ev.target.innerHTML = '<span class="spin"></span>'; out[modKey] = { ...r, sec: await app.mods.security(e.mod) }; await app.mods.done(); draw(); };
    for (const k of ['rt', 'io', 'did']) {
      $(`#sc_${k}`, c).onclick = async ev => {
        const from = parseInt($(`#f_${k}`, c).value, 16), to = parseInt($(`#t_${k}`, c).value, 16);
        if (!(from >= 0) || !(to >= from) || to - from > 0x0fff) { toast('نطاق غير صالح (حد أقصى 4096 معرّف)', 'warn'); return; }
        const bar = $(`#p_${k}`, c); bar.classList.remove('hidden');
        ev.target.textContent = 'إيقاف'; ev.target.onclick = () => { app.mods.cancel = true; };
        const fn = { rt: 'scanRoutines', io: 'scanIo', did: 'scanDids' }[k];
        try {
          const res = await app.mods[fn](e.mod, from, to, (p, t) => { bar.querySelector('i').style.width = (p * 100).toFixed(0) + '%'; $(`#pt_${k}`, c).textContent = t; });
          out[modKey] = { ...(out[modKey] || {}), [k]: [...((out[modKey] || {})[k] || []).filter(x => x.id < from || x.id > to), ...res.found] };
          toast(`${res.found.length} معرّف موجود${res.cancelled ? ' (أُوقف المسح)' : ''}`, 'ok');
        } catch (er) { toast(er.message, 'err'); }
        await app.mods.done(); draw();
      };
    }
    $$('[data-run]', c).forEach(b => b.onclick = () => runRoutine(e, parseInt(b.dataset.run, 16)));
    $$('[data-io]', c).forEach(b => b.onclick = () => runIo(e, parseInt(b.dataset.io, 16)));
    $$('[data-lib]', c).forEach(b => b.onclick = () => runLib(e, libItems[+b.dataset.lib]));
  };
  const scanBox = (k, title, f, t, note) => `<div class="card"><h3>${title}</h3><div class="small dim">${note}</div><div class="row" style="margin-top:8px"><input type="text" class="mono" id="f_${k}" value="${f}" style="width:80px"> – <input type="text" class="mono" id="t_${k}" value="${t}" style="width:80px"><button class="btn sm" id="sc_${k}">اكتشاف</button></div><div class="progress hidden" id="p_${k}" style="margin-top:8px"><i style="width:0"></i></div><div class="small mono dim" id="pt_${k}"></div></div>`;
  const resultList = r => {
    let h = '';
    if (r.rt?.length) h += `<h3 style="margin-top:14px">روتينات موجودة (${r.rt.length})</h3>${r.rt.map(x => `<div class="row" style="margin:5px 0"><span class="mono">0x${hex4(x.id)}</span><span style="flex:1" class="small">${esc(libName('routine', x.id) || 'اسم غير معروف — غير موجود في المكتبة')} · ${esc(x.result)}</span><button class="btn sm" data-run="${hex4(x.id)}">تشغيل…</button></div>`).join('')}`;
    if (r.io?.length) h += `<h3 style="margin-top:14px">اختبارات فعّالة موجودة (${r.io.length})</h3>${r.io.map(x => `<div class="row" style="margin:5px 0"><span class="mono">0x${hex4(x.id)}</span><span style="flex:1" class="small">${esc(libName('io', x.id) || 'اسم غير معروف')} · ${esc(x.result)}</span><button class="btn sm" data-io="${hex4(x.id)}">تشغيل…</button></div>`).join('')}`;
    if (r.did?.length) h += `<h3 style="margin-top:14px">بيانات مقروءة (${r.did.length})</h3><table class="tbl"><tbody>${r.did.map(x => `<tr><td class="mono">0x${hex4(x.id)}</td><td>${esc(x.name || libName('did', x.id) || '—')} ${x.name ? conf('sure') : ''}</td><td class="mono small">${typeof x.result === 'string' ? esc(x.result) : esc(x.result.ascii || x.result.raw)}</td></tr>`).join('')}</tbody></table>`;
    if (r.rt && !r.rt.length && r.io && !r.io.length) h += '<div class="hint" style="margin-top:10px">لم يُكشف أي روتين أو اختبار فعّال في هذه النطاقات. جرّب نطاقات أخرى، أو أن الكمبيوتر يتطلب وصولًا أمنيًا.</div>';
    return h;
  };
  const libName = (kind, id) => (app.lib.routines || []).find(x => x.kind === kind && parseInt(x.id, 16) === id)?.name;
  const preconditions = async () => {
    let speed = null;
    try { const r = await app.obd.readPids([0x0d]); speed = [...r.values()][0]?.value ?? null; } catch {}
    return speed;
  };
  const runRoutine = async (e, rid) => {
    const bl = routineBlocked(rid); if (bl) { toast(bl, 'err'); return; }
    const speed = await preconditions();
    if (speed > 0) { toast('ممنوع أثناء الحركة — أوقف السيارة', 'err'); return; }
    const name = libName('routine', rid);
    const ok = await confirmAction({
      title: `تشغيل روتين 0x${hex4(rid)}`, danger: true, typeWord: 'نفّذ',
      what: `${name ? `<b>${esc(name)}</b>` : '<b>روتين غير موثّق</b>: لا نعرف بالضبط ما يفعله — قد يكون تصفيرًا أو تهيئة أو اختبارًا يحرّك قطعة.'} سيُرسل للكمبيوتر ${esc(e.name)}.`,
      extra: `<ul class="small"><li>السرعة الحالية: ${speed == null ? 'غير معروفة — تأكد بنفسك أن السيارة متوقفة' : speed + ' كم/س ✓'}</li><li>حالة المكينة المطلوبة غير معروفة؛ إن لم تكن مناسبة سيرفض الكمبيوتر ونعرض السبب.</li><li>ابتعد عن المراوح والسيور والأجزاء المتحركة.</li></ul>`,
      reversible: null,
    });
    if (!ok) return;
    const res = await app.mods.startRoutine(e.mod, rid); await app.mods.done();
    modal(res.ok ? 'الكمبيوتر قبل الأمر' : 'الكمبيوتر رفض الأمر', res.ok ? `<div class="ok-box">ردّ الكمبيوتر بقبول تشغيل الروتين.</div><dl class="kv"><dt>بيانات الرد</dt><dd class="mono">${esc(res.data || '—')}</dd><dt>النتيجة</dt><dd class="mono">${esc(res.result || 'لم يُرسل نتيجة')}</dd></dl><div class="small dim">قبول الأمر لا يعني بالضرورة اكتمال العملية؛ تحقق من النتيجة على السيارة.</div>` : `<div class="warn">${esc(res.error)}</div>`);
  };
  const runIo = async (e, did) => {
    const speed = await preconditions();
    if (speed > 0) { toast('ممنوع أثناء الحركة', 'err'); return; }
    const st = await modal(`اختبار فعّال 0x${hex4(did)}`, `<p>${esc(libName('io', did) || 'اختبار غير موثّق — لا نعرف القطعة التي سيشغّلها.')}</p><label class="f">قيمة التحكم (hex) — تعتمد على الكمبيوتر</label><input type="text" class="mono" id="ioV" value="01"><label class="f">المدة بالثواني (يُعاد التحكم للكمبيوتر تلقائيًا بعدها)</label><input type="number" id="ioS" value="3" min="1" max="10">
      <ul class="small"><li>السرعة: ${speed == null ? 'غير معروفة — تأكد أن السيارة متوقفة' : speed + ' كم/س ✓'}</li><li>ابتعد عن الأجزاء المتحركة.</li></ul>`, [{ label: 'إلغاء', value: null, cls: 'ghost' }, { label: 'متابعة', cls: 'primary', value: m => ({ v: m.querySelector('#ioV').value.replace(/\s/g, ''), s: Math.min(10, Math.max(1, +m.querySelector('#ioS').value || 3)) }) }]);
    if (!st || !/^([0-9a-f]{2})+$/i.test(st.v)) { if (st) toast('قيمة hex غير صالحة', 'warn'); return; }
    const ok = await confirmAction({ title: 'تأكيد التشغيل المباشر', what: `سيأخذ البرنامج التحكم بالمعرّف 0x${hex4(did)} لمدة ${st.s} ثانية ثم يعيده للكمبيوتر.`, reversible: 'يُعاد التحكم للكمبيوتر تلقائيًا بعد المدة، وإن انقطع الاتصال يستعيده الكمبيوتر عند انتهاء الجلسة', danger: true, typeWord: 'نفّذ' });
    if (!ok) return;
    toast('جارٍ التنفيذ…');
    const res = await app.mods.ioControl(e.mod, did, st.v.toUpperCase(), st.s); await app.mods.done();
    modal(res.ok ? 'نُفّذ الاختبار' : 'رفض الكمبيوتر', res.ok ? `<div class="ok-box">قبل الكمبيوتر الأمر. ${res.returned ? 'وأُعيد التحكم له بنجاح.' : '<b>تنبيه:</b> لم يؤكّد الكمبيوتر إعادة التحكم؛ سيستعيده عند انتهاء الجلسة أو أطفئ السويتش.'}</div>` : `<div class="warn">${esc(res.error)}</div>`);
  };
  const runLib = async (e, x) => {
    if (x.kind === 'routine') return runRoutine(e, parseInt(x.id, 16));
    if (x.kind === 'io') return runIo(e, parseInt(x.id, 16));
    if (x.kind === 'write') {
      const ok = await confirmAction({ title: x.name, what: `كتابة القيمة <span class="mono">${esc(x.data)}</span> في المعرّف ${esc(x.id)}. ${esc(x.warn || '')}`, reversible: x.reversible ?? null, danger: true, typeWord: 'نفّذ' });
      if (!ok) return;
      const r = await app.mods.writeDid(e.mod, parseInt(x.id, 16), x.data); await app.mods.done();
      toast(r.ok ? 'قبل الكمبيوتر الكتابة' : 'رفض: ' + r.error, r.ok ? 'ok' : 'err');
    }
  };
  const mode8 = async () => {
    const o = $('#sv8Out', c); o.innerHTML = '<span class="spin"></span>';
    const r = await app.obd.mode08Supported();
    const items = [...r.entries()].flatMap(([ecu, s]) => [...s].filter(x => x % 0x20).map(t => ({ ecu, t })));
    o.innerHTML = items.length ? items.map(x => `<div class="row small" style="margin:4px 0"><span style="flex:1">TID 0x${hex2(x.t)} — ${x.t === 1 ? 'اختبار تسريب EVAP (يغلق صمام التهوية ليختبر الإحكام)' : 'اختبار غير مسمّى في المعيار'}</span><button class="btn sm" data-t8="${x.t}">تشغيل…</button></div>`).join('') : '<div class="small dim">الكمبيوتر لا يعلن عن اختبارات Mode 08.</div>';
    $$('[data-t8]', o).forEach(b => b.onclick = async () => {
      const t = +b.dataset.t8;
      const ok = await confirmAction({ title: `تشغيل اختبار Mode 08 (0x${hex2(t)})`, what: t === 1 ? 'اختبار تسريب EVAP: الكمبيوتر يغلق نظام البخار. الشروط عادة: المكينة شغالة على الخمول، الوقود بين ربع وثلاثة أرباع الخزان، والسيارة واقفة.' : 'اختبار غير مسمّى.', reversible: 'ينتهي الاختبار وحده ويعود النظام لوضعه الطبيعي', typeWord: null });
      if (!ok) return;
      const res = await app.obd.runMode08(t);
      const m = res.msgs[0];
      toast(m && !m.neg ? 'قبل الكمبيوتر بدء الاختبار — النتيجة تظهر في Mode 6 / الأعطال لاحقًا' : 'رفض: ' + (m?.neg ? nrcText(m.nrc) : res.error), m && !m.neg ? 'ok' : 'err');
    });
  };
  draw();
}

/* =========================== Wiring diagrams =========================== */
export function wiringView(c) {
  const p = params();
  let id = p.c || (p.code ? circuitFor(p.code) : null) || (app.allDtcs().map(d => circuitFor(d.code)).find(Boolean)) || 'charging';
  let sel = null; const offs = [];
  const draw = () => {
    const cir = getCircuit(id);
    const codes = [...new Set(app.allDtcs().map(d => d.code))];
    const live = { ...app.liveValues(), __volt: app.conn.voltage, running: app.running() };
    const checks = cir ? chainCheck(id, live, app.conn.voltage) : [];
    c.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row wrap">
      <select id="wSel" style="width:auto">${CIRCUIT_LIST().map(k => `<option value="${k}" ${k === id ? 'selected' : ''}>${esc(getCircuit(k)?.title || k)}</option>`).join('')}</select>
      ${codes.length ? `<span class="small dim">من أعطال السيارة:</span>${codes.map(x => `<button class="btn sm ${circuitFor(x) === id ? 'primary' : ''}" data-code="${x}" ${circuitFor(x) ? '' : 'disabled title="لا يوجد مخطط لهذا الكود في المكتبة"'}>${x}</button>`).join('')}` : ''}
      <span class="sp" style="flex:1"></span>${p.code && !circuitFor(p.code) ? `<span class="warn small">لا يوجد مخطط لـ ${esc(p.code)} في المكتبة</span>` : ''}</div></div>
    ${cir ? `<div class="grid g3"><div class="card span2 wiring"><div class="card-head"><h2>${esc(cir.title)}</h2>${conf(cir.fromLibrary ? 'best' : 'est')}<span class="small dim">${cir.fromLibrary ? 'من المكتبة المرجعية المضافة' : 'مخطط نموذجي عام — ليس مخطط المصنّع لسيارتك'}</span></div>
      <div id="wSvg">${wiringSvg(cir, { live, checks, selected: sel })}</div>
      <div class="legend" style="margin-top:8px">${Object.entries(ROLE).map(([, [col, l]]) => `<span><i style="background:${col}"></i>${l}</span>`).join('')}</div>
      <div class="small dim" style="margin-top:6px">مصادر المعلومات: القيم داخل المربعات قراءة حية ${conf('sure')} · المكوّنات والأسلاك من المكتبة ${conf('best')} · القيم المتوقعة والتقديرات ${conf('est')}</div></div>
      <div class="card"><h2>التفاصيل</h2><div id="wDet"><div class="dim small">اضغط على أي سلك أو قطعة في الرسم</div></div>
        <h3 style="margin-top:14px">أين تنكسر السلسلة؟ (من القراءات الحية)</h3>${checks.length ? checks.map(k => `<div class="${k.st === 'ok' ? 'ok-box' : k.st === 'warn' ? 'warn' : 'danger'} small" style="margin:6px 0">${esc(k.t)}</div>`).join('') + `<div class="small dim">${conf('est')} تفسير القراءة تقديري</div>` : `<div class="small dim">${connected() ? 'لا توجد قراءة حية مرتبطة بهذه الدائرة' : 'اتصل بالسيارة لتركيب القراءات الحية على الرسم'}</div>`}
        ${cir.notes?.length ? `<h3 style="margin-top:14px">ملاحظات</h3><ul class="small">${cir.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <div class="hint small" style="margin-top:10px">أرقام الأطراف وألوان الأسلاك تختلف حسب السيارة ولا نعرضها إلا إن وُجدت في مكتبة مضافة. يمكنك إضافة مخططات من «الإعدادات ← المكتبة المرجعية».</div></div></div>`
      : '<div class="card"><div class="empty">لا يوجد مخطط</div></div>'}`;
    $('#wSel', c).onchange = e => { id = e.target.value; sel = null; draw(); };
    $$('[data-code]', c).forEach(b => b.onclick = () => { const k = circuitFor(b.dataset.code); if (k) { id = k; sel = null; draw(); } });
    $('#wSvg', c)?.addEventListener('click', e => {
      const w = e.target.closest('.wire'), cp = e.target.closest('.wcomp');
      if (w) { sel = 'w' + w.dataset.w; showWire(cir, +w.dataset.w, live, checks); }
      else if (cp) { sel = 'c' + cp.dataset.c; showComp(cir, cp.dataset.c); }
      else return;
      $('#wSvg', c).innerHTML = wiringSvg(cir, { live, checks, selected: sel });
    });
  };
  const showWire = (cir, k, live, checks) => {
    const w = cir.wires[k]; const [col, role] = ROLE[w.role] || ROLE.sig;
    const lv = w.pid != null ? live[w.pid] : w.vlive ? live.__volt : null;
    const chk = checks.find(x => x.wire === k);
    $('#wDet', c).innerHTML = `<div class="row"><span class="dot" style="background:${col}"></span><b>${esc(w.label)}</b>${conf(w.conf || 'best')}</div>
      <dl class="kv" style="margin-top:8px"><dt>الوظيفة</dt><dd>${role}</dd><dt>نقطة القياس</dt><dd>${esc(w.measure || '—')}</dd><dt>القيمة المتوقعة</dt><dd>${esc(w.expect || '—')} ${conf('est')}</dd>
      ${w.pid != null ? `<dt>قراءة الكمبيوتر</dt><dd class="num">${lv != null ? lv.toFixed?.(2) + ' ' + (PIDS[w.pid]?.[1] || '') : '—'} ${lv != null ? conf('sure') : ''}</dd>` : ''}
      <dt>رقم الطرف / اللون</dt><dd class="dim">${esc(w.pin || 'غير موثّق — راجع دليل المصنّع')}</dd></dl>
      ${chk ? `<div class="${chk.st === 'ok' ? 'ok-box' : 'warn'} small" style="margin-top:8px">${esc(chk.t)}</div>` : ''}
      ${w.role === 'sig' && /وسادة|إطلاق/.test(w.label) ? '<div class="danger small" style="margin-top:8px">لا تقِس هذه الدائرة بالملتيميتر</div>' : ''}`;
  };
  const showComp = (cir, cid) => {
    const x = cir.comps.find(q => q.id === cid);
    const ws = cir.wires.map((w, i) => ({ w, i })).filter(({ w }) => (w.a || 'ecm') === cid || (w.b || 'c') === cid);
    $('#wDet', c).innerHTML = `<b>${esc(x.label)}</b><div class="small dim">${{ ecm: 'كمبيوتر', part: 'قطعة', fuse: 'فيوز', relay: 'ريليه', batt: 'بطارية', dlc: 'فيش الفحص' }[x.kind] || ''}</div><h3 style="margin-top:10px">الأسلاك المتصلة</h3><ul class="small">${ws.map(({ w }) => `<li>${esc(w.label)} — ${esc(w.expect || '')}</li>`).join('')}</ul>`;
  };
  if (connected()) {
    const sup = app.pidSupport.get(app.primaryEcu()) || new Set();
    const pids = [0x05, 0x0f, 0x11, 0x0b, 0x10, 0x14, 0x0c, 0x07, 0x42, 0x2e].filter(q => sup.has(q));
    startLive({ fast: pids, rateMs: 800 });
    let last = 0;
    offs.push(bus.on('live', () => { if (Date.now() - last > 2000 && !sel) { last = Date.now(); draw(); } }));
  }
  draw();
  return () => { offs.forEach(f => f()); stopLive(); };
}

/* =========================== AI technician =========================== */
export function aiView(c) {
  const hist = app.aiHist ||= [];
  const draw = async () => {
    const av = aiAvailable();
    const lib = await store.all('ai');
    c.innerHTML = `<div class="grid g3"><div class="card span2"><div class="card-head"><h2>اسأل الفني</h2><span class="sp"></span>
      ${av.ready ? '<span class="badge ok">● Claude متصل</span>' : `<span class="badge warn">● الوضع المحلي</span><span class="small dim">${!av.online ? 'لا يوجد إنترنت' : !av.key ? 'لا يوجد مفتاح API' : 'Claude موقوف من الإعدادات'}</span>`}</div>
      <div class="chat" id="aChat">${hist.length ? hist.map(m => `<div class="msg me">${esc(m.q)}</div><div class="msg bot">${esc(m.a)}<div class="meta"><span class="badge ${m.src === 'claude' ? 'info' : ''}">${m.src === 'claude' ? 'Claude' : 'نموذج محلي + المكتبة'}</span>${m.src === 'claude' ? '<span>حُفظ في المكتبة المحلية</span>' : conf('est')}${canSpeak() ? '<a href="#" data-say="' + esc(m.id) + '">🔊 استمع</a>' : ''}</div></div>`).join('') : '<div class="empty">اسأل عن أي عطل أو قراءة. الفني يرى أعطال سيارتك وجاهزيتها والقيم الحية تلقائيًا.</div>'}</div>
      <div class="row wrap" style="gap:6px;margin:10px 0">${['ما السبب الأرجح لأعطال سيارتي؟', 'هل السيارة جاهزة للفحص الدوري؟', 'اكتب تقريرًا مختصرًا لحالة السيارة', 'اشرح خلطة الوقود الحالية'].map(q => `<button class="btn sm ghost" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <div class="row"><textarea id="aQ" style="min-height:52px" placeholder="اكتب سؤالك…"></textarea><button class="btn primary" id="aSend">إرسال</button></div>
      <div class="small dim" style="margin-top:6px">${av.key ? 'يُرسل السؤال مع ملخّص بيانات السيارة إلى Claude عبر مفتاحك (محسوب بالاستخدام ومنفصل عن اشتراك claude.ai).' : '<a href="#/settings">أضف مفتاح Claude API</a> للحصول على إجابات الذكاء الكامل. المفتاح يُحفظ على هذا الجهاز فقط.'}</div></div>
      <div class="card"><h2>مكتبة التشخيصات المحفوظة (${lib.length})</h2><input type="search" id="aS" placeholder="بحث…"><div class="list" id="aLib" style="margin-top:8px;max-height:60vh;overflow:auto"></div></div></div>`;
    const renderLib = f => { $('#aLib', c).innerHTML = lib.filter(e => !f || (e.q + e.a).includes(f)).slice(0, 50).map(e => `<details class="acc"><summary class="small">${esc(e.q.slice(0, 80))}</summary><div class="acc-body small" style="white-space:pre-wrap">${esc(e.a)}<div class="dim">${fmtDate(e.t)}</div><button class="btn sm ghost" data-del="${e.id}">حذف</button></div></details>`).join('') || '<div class="dim small">لا توجد إجابات محفوظة</div>'; $$('[data-del]', c).forEach(b => b.onclick = async () => { await store.del('ai', b.dataset.del); draw(); }); };
    renderLib(); $('#aS', c).oninput = e => renderLib(e.target.value);
    const ch = $('#aChat', c); ch.scrollTop = 1e9;
    $('#aSend', c).onclick = () => send($('#aQ', c).value);
    $('#aQ', c).onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#aQ', c).value); } };
    $$('[data-q]', c).forEach(b => b.onclick = () => send(b.dataset.q));
    $$('[data-say]', c).forEach(a => a.onclick = ev => { ev.preventDefault(); const m = hist.find(x => x.id === a.dataset.say); if (m) speak(m.a); });
  };
  const send = async q => {
    q = (q || '').trim(); if (!q) return;
    const ch = $('#aChat', c);
    ch.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(q)}</div><div class="msg bot" id="aWait"><span class="spin"></span></div>`); ch.scrollTop = 1e9;
    $('#aQ', c).value = '';
    let a, src = 'local';
    const av = aiAvailable();
    if (av.ready) {
      try { a = await askClaude(q, buildContext(app), hist.filter(h => h.src === 'claude')); src = 'claude'; }
      catch (e) { toast('Claude: ' + e.message + ' — تم استخدام الوضع المحلي', 'warn'); }
    }
    if (!a) a = await localAnswer(q, app);
    const ent = await saveAnswer(q, a, src, app);
    hist.push({ id: ent.id, q, a, src });
    draw();
  };
  draw().then(() => { const q = params().q; if (q) { history.replaceState(null, '', '#/ai'); send(q); } });
}

/* =========================== Reports & history =========================== */
export async function reportsView(c) {
  let pick = [];
  const draw = async () => {
    const scans = await store.all('scans');
    const photos = await store.all('photos');
    c.innerHTML = `<div class="grid g2"><div class="card glow"><h2>تقرير الحالة الحالية</h2><p class="small muted">تقرير HTML مستقل يُفتح على أي جهاز بدون إنترنت: السيارة، الأعطال لكل كمبيوتر، الجاهزية، لقطة الحظة، الترجيح، والصور الموثّقة.</p>
      <label class="chk small"><input type="checkbox" id="rPh" ${photos.length ? 'checked' : ''}> إرفاق الصور الموثّقة (${photos.length})</label>
      <div class="btn-row"><button class="btn primary" id="rNow" ${app.ecus.size ? '' : 'disabled'}>إنشاء ومشاركة</button><button class="btn" id="rDl" ${app.ecus.size ? '' : 'disabled'}>تنزيل</button></div>${app.ecus.size ? '' : '<div class="small dim">اتصل وافحص أولًا، أو اختر فحصًا محفوظًا من السجل.</div>'}</div>
      <div class="card"><h2>مقارنة الحالة عبر الزمن</h2><p class="small muted">اختر فحصين من السجل لمقارنة الأعطال الجديدة والمحلولة والمستمرة.</p><button class="btn" id="rCmp" ${pick.length === 2 ? '' : 'disabled'}>مقارنة المحدّدين (${pick.length}/2)</button><div id="rCmpOut"></div></div>
      <div class="card spanall"><h2>سجل الفحوصات (محفوظ على هذا الجهاز)</h2>${scans.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th>التاريخ</th><th>السيارة</th><th>الأعطال</th><th>الكمبيوترات</th><th></th></tr></thead><tbody>${scans.map(s => `<tr><td><input type="checkbox" data-pick="${s.id}" ${pick.includes(s.id) ? 'checked' : ''}></td><td>${fmtDate(s.t)}${s.demo ? ' <span class="badge vi">تجريبي</span>' : ''}</td><td>${esc([s.vehicle?.make, s.vehicle?.year].filter(Boolean).join(' ') || '—')} <span class="mono small dim">${esc(s.vehicle?.vin || '')}</span></td><td>${s.dtcs.length ? `<span class="badge err">${s.dtcs.length}</span> <span class="small mono">${esc(s.dtcs.map(d => d.code).slice(0, 6).join(' '))}</span>` : '<span class="badge ok">0</span>'}</td><td class="num">${s.ecus.length}</td><td><button class="btn sm" data-rep="${s.id}">تقرير</button> <button class="btn sm ghost" data-del="${s.id}">حذف</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">لا توجد فحوصات محفوظة بعد. كل «فحص شامل» يُحفظ هنا تلقائيًا.</div>'}
      ${store.persistent ? '' : '<div class="warn" style="margin-top:8px">المتصفح يمنع التخزين الدائم (ربما وضع التصفح الخاص): السجل محفوظ لهذه الجلسة فقط.</div>'}
      <div class="small dim" style="margin-top:8px">المرحلة الأولى: التخزين محلي لكل جهاز. المزامنة بين الأجهزة غير متوفرة بعد — يمكنك نقل البيانات بتصدير نسخة احتياطية من الإعدادات.</div></div></div>`;
    const make = async (rec) => { if ($('#rPh', c)?.checked) rec = { ...rec, photos: photos.filter(p => !rec.vehicle?.vin || !p.vin || p.vin === rec.vehicle.vin) }; return scanReportHtml(rec, correlate({ dtcs: rec.dtcs, live: rec.live || {}, trims: null, volt: rec.voltage })); };
    const cur = () => app.lastScan && app.lastScan.ecus ? { ...snapshotScan(), t: app.lastScan.t } : snapshotScan();
    $('#rNow', c).onclick = async () => shareFile(`car-report-${new Date().toISOString().slice(0, 10)}.html`, await make(cur()));
    $('#rDl', c).onclick = async () => download(`car-report-${new Date().toISOString().slice(0, 10)}.html`, await make(cur()));
    $$('[data-rep]', c).forEach(b => b.onclick = async () => { const s = await store.get('scans', b.dataset.rep); shareFile(`car-report-${new Date(s.t).toISOString().slice(0, 10)}.html`, await make(s)); });
    $$('[data-del]', c).forEach(b => b.onclick = async () => { if (await confirmAction({ title: 'حذف فحص', what: 'حذف هذا الفحص من السجل المحلي.', reversible: false })) { await store.del('scans', b.dataset.del); draw(); } });
    $$('[data-pick]', c).forEach(b => b.onchange = () => { pick = b.checked ? [...pick, b.dataset.pick].slice(-2) : pick.filter(x => x !== b.dataset.pick); draw(); });
    $('#rCmp', c).onclick = async () => {
      const [a, b] = (await Promise.all(pick.map(id => store.get('scans', id)))).sort((x, y) => x.t - y.t);
      const A = new Set(a.dtcs.map(d => d.code)), B = new Set(b.dtcs.map(d => d.code));
      const nw = [...B].filter(x => !A.has(x)), gone = [...A].filter(x => !B.has(x)), same = [...B].filter(x => A.has(x));
      const rdy = s => { const r = s.readiness?.[0]; if (!r) return '—'; const sup = r.mons.filter(m => m.sup); return `${sup.filter(m => m.ready).length}/${sup.length}`; };
      $('#rCmpOut', c).innerHTML = `<div class="small" style="margin-top:10px">${fmtDate(a.t)} ← ${fmtDate(b.t)}</div><dl class="kv" style="margin-top:8px">
        <dt>أعطال جديدة</dt><dd>${nw.length ? nw.map(x => `<span class="badge err mono">${x}</span>`).join(' ') : '—'}</dd>
        <dt>أعطال اختفت</dt><dd>${gone.length ? gone.map(x => `<span class="badge ok mono">${x}</span>`).join(' ') : '—'}</dd>
        <dt>مستمرة</dt><dd>${same.length ? same.map(x => `<span class="badge warn mono">${x}</span>`).join(' ') : '—'}</dd>
        <dt>الجاهزية</dt><dd>${rdy(a)} ← ${rdy(b)}</dd><dt>فولت البطارية</dt><dd class="num">${a.voltage?.toFixed(2) || '—'} ← ${b.voltage?.toFixed(2) || '—'}</dd></dl>`;
    };
  };
  draw();
}

/* =========================== Settings =========================== */
export function settingsView(c) {
  const draw = async () => {
    const s = settings();
    const libs = app.lib.sources || [];
    const SR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    c.innerHTML = `<div class="grid g2">
    <div class="card"><h2>الفني الذكي (Claude API)</h2>
      <label class="f">مفتاح Claude API</label><div class="row"><input type="password" id="kKey" value="${esc(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off"><button class="btn sm" id="kShow">إظهار</button></div>
      <div class="small dim">يُحفظ على هذا الجهاز فقط ولا يُرسل إلا إلى Anthropic عند السؤال. الاستخدام محسوب على حساب API (منفصل عن اشتراك claude.ai).</div>
      <label class="f">النموذج</label><select id="kModel">${[['claude-sonnet-5-5', 'Claude Sonnet 5.5 (موصى به — متوازن)'], ['claude-opus-5-5', 'Claude Opus 5.5 (الأقوى — أعلى تكلفة)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (الأسرع — أقل تكلفة)']].map(([v, l]) => `<option value="${v}" ${s.model === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" id="kOn" ${s.aiOn ? 'checked' : ''}> تفعيل Claude عند توفّر الإنترنت</label>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" id="kSave">حفظ</button><button class="btn" id="kTest">اختبار المفتاح</button></div></div>
    <div class="card"><h2>الصوت</h2>
      <div class="small">التعرّف على الأوامر بالعربي: ${SR ? '<span class="badge ok">مدعوم في هذا المتصفح</span>' : '<span class="badge warn">غير مدعوم في هذا المتصفح — زر المايك مخفي</span>'}</div>
      <div class="small" style="margin-top:6px">قراءة النتائج صوتيًا: ${canSpeak() ? '<span class="badge ok">مدعومة</span>' : '<span class="badge warn">غير مدعومة</span>'}</div>
      <label class="chk" style="margin-top:8px"><input type="checkbox" id="vSpeak" ${s.speak ? 'checked' : ''}> قراءة النتائج بصوت</label>
      <label class="f">لهجة التعرّف</label><select id="vLang">${[['ar-SA', 'العربية — السعودية'], ['ar-AE', 'العربية — الإمارات'], ['ar-EG', 'العربية — مصر'], ['ar-KW', 'العربية — الكويت']].map(([v, l]) => `<option value="${v}" ${s.voiceLang === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="small dim" style="margin-top:8px">أوامر مدعومة: «افحص»، «الأعطال»، «البيانات الحية»، «الجاهزية»، «الفولت»، «الخريطة»، «التشخيص»، «اسأل الفني»، «تقرير»، «الوضع التجريبي». المسح لا يُنفّذ بالصوت وحده لأسباب السلامة.</div></div>
    <div class="card"><h2>قطعة البلوتوث</h2>
      <div class="small muted">المتصفح يسمح فقط بالوصول لخدمات BLE المعلنة مسبقًا. البرنامج يعلن الخدمات الشائعة لمحوّلات ELM327؛ إن كانت قطعتك تستخدم خدمة مختلفة أضف رقمها هنا.</div>
      <label class="f">خدمات إضافية (UUID مفصولة بفاصلة)</label><input type="text" class="mono" id="bU" value="${esc((s.extraUuids || []).join(', '))}" placeholder="مثال: ffe0, 0000abcd-0000-1000-8000-00805f9b34fb">
      <button class="btn" id="bSave" style="margin-top:8px">حفظ</button></div>
    <div class="card"><h2>المكتبة المرجعية (قابلة للتوسّع)</h2>
      <div class="small muted">أضف ملفات JSON فيها: أسماء كمبيوترات بعناوينها، روتينات/اختبارات/تهيئات بأسمائها وتحذيراتها، شروحات أكواد خاصة بالمصنّع، ومخططات كهربائية. كل ما يأتي منها يُعلَّم «أفضل جهد».</div>
      <div class="btn-row" style="margin-top:8px"><label class="btn">استيراد ملف<input type="file" accept=".json,application/json" id="lImp" hidden></label><button class="btn ghost" id="lTpl">تنزيل قالب فارغ</button></div>
      <div class="list" style="margin-top:8px">${libs.map(l => `<div class="row small"><span style="flex:1">${esc(l.name)}</span><span class="dim">${fmtDate(l.t)}</span><button class="btn sm ghost" data-ldel="${l.id}">حذف</button></div>`).join('') || '<div class="dim small">لا توجد مكتبات مضافة — يُستخدم الأساس المدمج فقط.</div>'}</div></div>
    <div class="card"><h2>البيانات على هذا الجهاز</h2>
      <div class="btn-row"><button class="btn" id="dExp">تصدير نسخة احتياطية</button><label class="btn">استيراد نسخة<input type="file" accept=".json" id="dImp" hidden></label><button class="btn danger" id="dClr">حذف كل البيانات…</button></div></div>
    <div class="card"><h2>عن البرنامج والصدق في القدرات</h2><ul class="small">
      <li>الطبقة القياسية (أكواد OBD، الجاهزية، القيم الحية، Mode 2/5/6/8/9) تُكتشف كاملة من السيارة ${conf('sure')}.</li>
      <li>طبقة المصنّع (كمبيوترات أخرى، خدمات، تحكّم، مخططات) تعتمد على المسح وقت التشغيل + المكتبة المرجعية + التقدير ${conf('best')} ${conf('est')}.</li>
      <li>الوظائف المحمية بمفتاح أمان (seed/key) غير متاحة ويُقال ذلك بوضوح.</li>
      <li>جاهزية لـ SAE J1979-2 (OBDonUDS): يُكتشف تلقائيًا إن لم ترد السيارة على OBD التقليدي ${conf('best')}.</li>
      <li>البرمجة والفلاشة خارج النطاق (أدوات منفصلة مثل HP Tuners / J2534).</li></ul></div></div>`;
    $('#kShow', c).onclick = () => { const i = $('#kKey', c); i.type = i.type === 'password' ? 'text' : 'password'; };
    $('#kSave', c).onclick = () => { saveSettings({ apiKey: $('#kKey', c).value.trim(), model: $('#kModel', c).value, aiOn: $('#kOn', c).checked }); toast('تم الحفظ', 'ok'); };
    $('#kTest', c).onclick = async e => {
      saveSettings({ apiKey: $('#kKey', c).value.trim(), model: $('#kModel', c).value });
      if (!navigator.onLine) { toast('لا يوجد اتصال بالإنترنت', 'warn'); return; }
      e.target.innerHTML = '<span class="spin"></span>';
      try { const a = await askClaude('رد بكلمة واحدة: جاهز', 'اختبار اتصال'); toast('المفتاح يعمل ✓ — ' + a.slice(0, 40), 'ok'); } catch (er) { toast('فشل: ' + er.message, 'err'); }
      e.target.textContent = 'اختبار المفتاح';
    };
    $('#vSpeak', c).onchange = e => saveSettings({ speak: e.target.checked });
    $('#vLang', c).onchange = e => saveSettings({ voiceLang: e.target.value });
    $('#bSave', c).onclick = () => { saveSettings({ extraUuids: $('#bU', c).value.split(/[,\s]+/).map(x => x.trim()).filter(Boolean) }); toast('سيُستخدم في الاتصال القادم', 'ok'); };
    $('#lImp', c).onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { const data = JSON.parse(await f.text()); await store.put('library', { id: uid(), t: Date.now(), name: data.name || f.name, data }); await loadLibrary(); toast('أُضيفت المكتبة', 'ok'); draw(); }
      catch (er) { toast('ملف غير صالح: ' + er.message, 'err'); }
    };
    $('#lTpl', c).onclick = () => download('car-tech-library-template.json', JSON.stringify(LIB_TEMPLATE, null, 2), 'application/json');
    $$('[data-ldel]', c).forEach(b => b.onclick = async () => { await store.del('library', b.dataset.ldel); await loadLibrary(); draw(); });
    $('#dExp', c).onclick = async () => { const o = { v: 1, t: Date.now(), settings: { ...settings(), apiKey: '' } }; for (const s2 of ['scans', 'trips', 'ai', 'photos', 'vehicles', 'library']) o[s2] = await store.all(s2); download(`car-tech-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(o), 'application/json'); toast('صُدّرت النسخة (بدون مفتاح API)', 'ok'); };
    $('#dImp', c).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const o = JSON.parse(await f.text()); let n = 0; for (const s2 of ['scans', 'trips', 'ai', 'photos', 'vehicles', 'library']) for (const r of o[s2] || []) { await store.put(s2, r); n++; } await loadLibrary(); toast(`استُوردت ${n} سجل`, 'ok'); } catch (er) { toast('ملف غير صالح', 'err'); } };
    $('#dClr', c).onclick = async () => { if (!(await confirmAction({ title: 'حذف كل البيانات', what: 'حذف الفحوصات والمشاوير والصور والإجابات والمكتبات المحفوظة على هذا الجهاز.', reversible: false, danger: true, typeWord: 'احذف' }))) return; for (const s2 of ['scans', 'trips', 'ai', 'photos', 'vehicles', 'library']) await store.clear(s2); await loadLibrary(); toast('حُذفت البيانات', 'ok'); draw(); };
  };
  draw();
}
const LIB_TEMPLATE = {
  name: 'مكتبتي المرجعية',
  modules: [{ make: 'GM', req: '7E0', res: '7E8', name: 'اسم الكمبيوتر', conf: 'best' }],
  routines: [{ make: 'GM', req: '7E0', kind: 'routine', id: '0000', name: 'اسم الخدمة', warn: 'تحذير خاص بهذا الإجراء', conf: 'best' }, { req: '7E0', kind: 'io', id: '0000', name: 'اسم الاختبار الفعّال' }, { req: '7E0', kind: 'write', id: '0000', data: '00', name: 'تهيئة', reversible: false }],
  codes: { P1234: 'شرح الكود الخاص بالمصنّع' },
  circuits: { my_circuit: { title: 'عنوان المخطط', comps: [{ id: 'ecm', label: 'الكمبيوتر', x: 40, y: 70, w: 150, h: 200, kind: 'ecm' }, { id: 'c', label: 'القطعة', x: 590, y: 110, w: 170, h: 120, kind: 'part' }], wires: [{ i: 0, role: 'ref5', label: 'مرجع 5V', expect: '5V', measure: 'فولت للأرضي', pin: 'طرف 1 / رمادي' }], notes: [] } },
};
