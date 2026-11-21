// Phase-2 screens: services & bidirectional control (the fault analyst lives in views-analyst.js,
// wiring diagrams in views-wiring.js),
// AI technician, reports & history, settings.
import { $, $$, esc, bus, toast, modal, confirmAction, conf, fmtDate, hex2, hex3, hex4, download, shareFile, uid, safeImg } from './util.js';
import { app, requireConn, snapshotScan, loadLibrary, exclusive } from './core.js';
import { combineReadiness, readinessStats, chargeRange } from './obd.js';
import { describeDtc } from './dtcdb.js';
import { correlate } from './diag.js';
import { SIDS, STD_DIDS, routineBlocked, nrcText } from './network.js';
import { store, settings, saveSettings } from './store.js';
import { aiAvailable, buildContext, askClaude, localAnswer, saveAnswer } from './ai.js';
import { scanReportHtml } from './report.js';
import { session } from './session.js';
import { sessionReportHtml, openReport } from './session-report.js';
import { clearOne } from './views-core.js';
import { speak, canSpeak, params, go } from './nav.js';

const connected = () => app.conn.ready;

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
    $$('[data-srs]', c).forEach(b => b.onclick = () => { const m = app.ecus.get(b.dataset.srs); if (m) clearOne(m, draw); });
    if (!e) return;
    $('#svDisc', c).onclick = async ev => { const s = await op('اكتشاف خدمات الكمبيوتر', () => app.mods.discoverServices(e.mod), ev.currentTarget); if (s) out[modKey] = { ...(out[modKey] || {}), services: s }; draw(); };
    $('#svSec', c).onclick = async ev => { const s = await op('فحص حالة الوصول الأمني', () => app.mods.security(e.mod), ev.currentTarget); if (s) out[modKey] = { ...(out[modKey] || {}), sec: s }; draw(); };
    for (const k of ['rt', 'io', 'did']) {
      $(`#sc_${k}`, c).onclick = async ev => {
        const from = parseInt($(`#f_${k}`, c).value, 16), to = parseInt($(`#t_${k}`, c).value, 16);
        if (!(from >= 0) || !(to >= from) || to > 0xffff || to - from > 0x0fff) { toast('نطاق غير صالح (حد أقصى 4096 معرّف)', 'warn'); return; }
        if (app.busy) { toast(`انتظر حتى ينتهي: ${app.busy.label}`, 'warn'); return; }
        const btn = ev.currentTarget, bar = $(`#p_${k}`, c); bar.classList.remove('hidden');
        btn.textContent = 'إيقاف'; btn.onclick = () => { if (app.mods) app.mods.cancel = true; btn.disabled = true; };
        const fn = { rt: 'scanRoutines', io: 'scanIo', did: 'scanDids' }[k];
        const res = await op('مسح معرّفات الكمبيوتر', step => app.mods[fn](e.mod, from, to, (p, t) => { step(p, t); const i = bar.querySelector('i'); if (i) i.style.width = (p * 100).toFixed(0) + '%'; const pt = $(`#pt_${k}`, c); if (pt) pt.textContent = t; }), null, true);
        if (res) {
          out[modKey] = { ...(out[modKey] || {}), [k]: [...((out[modKey] || {})[k] || []).filter(x => x.id < from || x.id > to), ...res.found] };
          toast(`${res.found.length} معرّف موجود${res.cancelled ? ' (أُوقف المسح)' : ''}`, 'ok');
        }
        draw();
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
  // Every request to a module is one exclusive operation (never interleaved with a scan or live
  // polling), its errors are shown, and the module is always returned to normal addressing.
  const op = async (label, fn, btn, cancelable = false) => {
    if (!connected()) { toast('اتصل بالسيارة أولًا', 'warn'); return null; }
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
    try { return await exclusive(label, async step => { try { return await fn(step); } finally { await app.mods.done(); } }, { cancelable }); }
    catch (er) { toast(er.message, 'err'); return null; }
  };
  const preconditions = async () => {
    const r = await exclusive('قراءة السرعة قبل التنفيذ', () => app.obd.readPids([0x0d]));
    return [...r.values()][0]?.value ?? null;
  };
  const ready = () => {
    if (!connected()) { toast('اتصل بالسيارة أولًا', 'warn'); return false; }
    if (app.busy) { toast(`انتظر حتى ينتهي: ${app.busy.label}`, 'warn'); return false; }
    return true;
  };
  const runRoutine = async (e, rid) => {
    const bl = routineBlocked(rid); if (bl) { toast(bl, 'err'); return; }
    if (!ready()) return;
    let speed = null;
    try { speed = await preconditions(); } catch (er) { toast(er.message, 'err'); return; }
    if (speed > 0) { toast('ممنوع أثناء الحركة — أوقف السيارة', 'err'); return; }
    const name = libName('routine', rid);
    const ok = await confirmAction({
      title: `تشغيل روتين 0x${hex4(rid)}`, danger: true, typeWord: 'نفّذ',
      what: `${name ? `<b>${esc(name)}</b>` : '<b>روتين غير موثّق</b>: لا نعرف بالضبط ما يفعله — قد يكون تصفيرًا أو تهيئة أو اختبارًا يحرّك قطعة.'} سيُرسل للكمبيوتر ${esc(e.name)}.`,
      extra: `<ul class="small"><li>السرعة الحالية: ${speed == null ? 'غير معروفة — تأكد بنفسك أن السيارة متوقفة' : speed + ' كم/س ✓'}</li><li>حالة المكينة المطلوبة غير معروفة؛ إن لم تكن مناسبة سيرفض الكمبيوتر ونعرض السبب.</li><li>ابتعد عن المراوح والسيور والأجزاء المتحركة.</li></ul>`,
      reversible: null,
    });
    if (!ok) return;
    const res = await op(`تشغيل روتين 0x${hex4(rid)}`, () => app.mods.startRoutine(e.mod, rid));
    if (!res) return;
    modal(res.ok ? 'الكمبيوتر قبل الأمر' : 'الكمبيوتر رفض الأمر', res.ok ? `<div class="ok-box">ردّ الكمبيوتر بقبول تشغيل الروتين.</div><dl class="kv"><dt>بيانات الرد</dt><dd class="mono">${esc(res.data || '—')}</dd><dt>النتيجة</dt><dd class="mono">${esc(res.result || 'لم يُرسل نتيجة')}</dd></dl><div class="small dim">قبول الأمر لا يعني بالضرورة اكتمال العملية؛ تحقق من النتيجة على السيارة.</div>` : `<div class="warn">${esc(res.error)}</div>`);
  };
  const runIo = async (e, did) => {
    if (!ready()) return;
    let speed = null;
    try { speed = await preconditions(); } catch (er) { toast(er.message, 'err'); return; }
    if (speed > 0) { toast('ممنوع أثناء الحركة', 'err'); return; }
    const st = await modal(`اختبار فعّال 0x${hex4(did)}`, `<p>${esc(libName('io', did) || 'اختبار غير موثّق — لا نعرف القطعة التي سيشغّلها.')}</p><label class="f">قيمة التحكم (hex) — تعتمد على الكمبيوتر</label><input type="text" class="mono" id="ioV" value="01"><label class="f">المدة بالثواني (يُعاد التحكم للكمبيوتر تلقائيًا بعدها)</label><input type="number" id="ioS" value="3" min="1" max="10">
      <ul class="small"><li>السرعة: ${speed == null ? 'غير معروفة — تأكد أن السيارة متوقفة' : speed + ' كم/س ✓'}</li><li>ابتعد عن الأجزاء المتحركة.</li></ul>`, [{ label: 'إلغاء', value: null, cls: 'ghost' }, { label: 'متابعة', cls: 'primary', value: m => ({ v: m.querySelector('#ioV').value.replace(/\s/g, ''), s: Math.min(10, Math.max(1, +m.querySelector('#ioS').value || 3)) }) }]);
    if (!st || !/^([0-9a-f]{2})+$/i.test(st.v)) { if (st) toast('قيمة hex غير صالحة', 'warn'); return; }
    const ok = await confirmAction({ title: 'تأكيد التشغيل المباشر', what: `سيأخذ البرنامج التحكم بالمعرّف 0x${hex4(did)} لمدة ${st.s} ثانية ثم يعيده للكمبيوتر.`, reversible: 'يُعاد التحكم للكمبيوتر تلقائيًا بعد المدة، وإن انقطع الاتصال يستعيده الكمبيوتر عند انتهاء الجلسة', danger: true, typeWord: 'نفّذ' });
    if (!ok) return;
    toast('جارٍ التنفيذ…');
    const res = await op(`اختبار فعّال 0x${hex4(did)}`, () => app.mods.ioControl(e.mod, did, st.v.toUpperCase(), st.s));
    if (!res) return;
    modal(res.ok ? 'نُفّذ الاختبار' : 'رفض الكمبيوتر', res.ok ? `<div class="ok-box">قبل الكمبيوتر الأمر. ${res.returned ? 'وأُعيد التحكم له بنجاح.' : '<b>تنبيه:</b> لم يؤكّد الكمبيوتر إعادة التحكم؛ سيستعيده عند انتهاء الجلسة أو أطفئ السويتش.'}</div>` : `<div class="warn">${esc(res.error)}</div>`);
  };
  const runLib = async (e, x) => {
    if (x.kind === 'routine') return runRoutine(e, parseInt(x.id, 16));
    if (x.kind === 'io') return runIo(e, parseInt(x.id, 16));
    if (x.kind === 'write') {
      if (!/^([0-9a-f]{2})+$/i.test(String(x.data || '')) || !/^[0-9a-f]{1,4}$/i.test(String(x.id || ''))) { toast('بيانات هذا البند في المكتبة غير صالحة (المعرّف/القيمة يجب أن تكون hex)', 'err'); return; }
      if (!ready()) return;
      const ok = await confirmAction({ title: x.name, what: `كتابة القيمة <span class="mono">${esc(x.data)}</span> في المعرّف ${esc(x.id)}. ${esc(x.warn || '')}`, reversible: x.reversible ?? null, danger: true, typeWord: 'نفّذ' });
      if (!ok) return;
      const r = await op('كتابة بيانات في الكمبيوتر', () => app.mods.writeDid(e.mod, parseInt(x.id, 16), String(x.data).toUpperCase()));
      if (r) toast(r.ok ? 'قبل الكمبيوتر الكتابة' : 'رفض: ' + r.error, r.ok ? 'ok' : 'err');
    }
  };
  const mode8 = async () => {
    const o = $('#sv8Out', c); o.innerHTML = '<span class="spin"></span>';
    const r = await op('اكتشاف اختبارات Mode 08', () => app.obd.mode08Supported());
    if (!r) { o.innerHTML = ''; return; }
    const items = [...r.entries()].flatMap(([ecu, s]) => [...s].filter(x => x % 0x20).map(t => ({ ecu, t })));
    o.innerHTML = items.length ? items.map(x => `<div class="row small" style="margin:4px 0"><span style="flex:1">TID 0x${hex2(x.t)} — ${x.t === 1 ? 'اختبار تسريب EVAP (يغلق صمام التهوية ليختبر الإحكام)' : 'اختبار غير مسمّى في المعيار'}</span><button class="btn sm" data-t8="${x.t}">تشغيل…</button></div>`).join('') : '<div class="small dim">الكمبيوتر لا يعلن عن اختبارات Mode 08.</div>';
    $$('[data-t8]', o).forEach(b => b.onclick = async () => {
      const t = +b.dataset.t8;
      const ok = await confirmAction({ title: `تشغيل اختبار Mode 08 (0x${hex2(t)})`, what: t === 1 ? 'اختبار تسريب EVAP: الكمبيوتر يغلق نظام البخار. الشروط عادة: المكينة شغالة على الخمول، الوقود بين ربع وثلاثة أرباع الخزان، والسيارة واقفة.' : 'اختبار غير مسمّى.', reversible: 'ينتهي الاختبار وحده ويعود النظام لوضعه الطبيعي', typeWord: null });
      if (!ok) return;
      const res = await op(`اختبار Mode 08 (0x${hex2(t)})`, () => app.obd.runMode08(t));
      if (!res) return;
      const m = res.msgs[0];
      toast(m && !m.neg ? 'قبل الكمبيوتر بدء الاختبار — النتيجة تظهر في Mode 6 / الأعطال لاحقًا' : 'رفض: ' + (m?.neg ? nrcText(m.nrc) : res.error), m && !m.neg ? 'ok' : 'err');
    });
  };
  draw();
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
  let sending = false;
  const send = async q => {
    q = (q || '').trim(); if (!q || sending) return;
    sending = true;
    const ch = $('#aChat', c);
    ch.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(q)}</div><div class="msg bot" id="aWait"><span class="spin"></span></div>`); ch.scrollTop = 1e9;
    $('#aQ', c).value = '';
    try {
      let a, src = 'local';
      const av = aiAvailable();
      if (av.ready) {
        try { a = await askClaude(q, buildContext(app), hist.filter(h => h.src === 'claude')); src = 'claude'; }
        catch (e) { toast('Claude: ' + e.message + ' — تم استخدام الوضع المحلي', 'warn'); }
      }
      if (!a) a = await localAnswer(q, app);
      let id = uid();
      try { id = (await saveAnswer(q, a, src, app)).id; } catch (e) { toast('تعذّر حفظ الإجابة في المكتبة المحلية', 'warn'); }
      hist.push({ id, q, a, src });
    } catch (e) { toast(e.message, 'err'); }
    finally { sending = false; }
    draw(); // if the person already left this page, this draws into a detached container (harmless)
  };
  draw().then(() => { const q = params().q; if (q) { history.replaceState(null, '', '#/ai'); send(q); } });
}

/* =========================== Reports & history =========================== */
export async function reportsView(c) {
  let pick = [];
  const draw = async () => {
    const scans = await store.all('scans');
    const photos = await store.all('photos');
    const sess = (await store.all('sessions').catch(() => [])).filter(x => x.status === 'done');
    const live = session.rec;
    const dur = ms => { const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60); return h ? `${h} س ${m} د` : `${m} د ${t % 60} ث`; };
    c.innerHTML = `<div class="card glow" style="margin-bottom:16px"><div class="card-head"><h2>تقارير الجلسات — التسجيل التلقائي</h2><span class="sp"></span>
        ${live ? `<span class="badge err">● يسجّل الآن منذ ${dur(Date.now() - live.t)}</span><button class="btn sm danger" id="sStop">أنهِ التسجيل وأصدر التقرير</button>` : app.conn.ready ? '<button class="btn sm" id="sStart">ابدأ التسجيل الآن</button>' : ''}</div>
      <div class="small muted">يبدأ التسجيل لحاله أول ما تسوي فحص للأعطال، ويسجّل كل شي (كل القراءات الحية، الفولت، الأكواد وقت ظهورها واختفائها، كل فحص وعملية ورسالة، نتائج الفحص الموجّه، وسجل القطعة) لين تفصل القطعة — وبعدها يطلع التقرير الشامل لحاله. ينحفظ كل 20 ثانية، فلو انقفل الجوال يطلع التقرير لين آخر لحظة.</div>
      ${sess.length ? `<div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>البداية</th><th>المدة</th><th>المسافة</th><th>الأكواد</th><th>القيم</th><th>الانتهاء</th><th></th></tr></thead><tbody>${sess.map(x => `<tr><td>${fmtDate(x.t)}${x.demo ? ' <span class="badge">تجريبي</span>' : ''}</td><td>${dur((x.tEnd || x.t) - x.t)}</td><td class="num">${(x.stats?.dist || 0).toFixed(1)} km</td><td>${Object.keys(x.codes || {}).length}</td><td>${(x.stats?.series || []).length}</td><td class="small dim">${esc(x.endedBy || '')}</td><td><div class="btn-row"><button class="btn sm primary" data-sview="${x.id}">عرض</button><button class="btn sm" data-sshare="${x.id}">مشاركة</button><button class="btn sm ghost" data-sdel="${x.id}">حذف</button></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="small dim" style="margin-top:8px">ما فيه تقارير جلسات بعد — تطلع هنا بعد أول فحص وفصل للقطعة.</div>'}</div>
    <div class="grid g2"><div class="card glow"><h2>تقرير الحالة الحالية</h2><p class="small muted">تقرير HTML مستقل يُفتح على أي جهاز بدون إنترنت: السيارة، الأعطال لكل كمبيوتر، الجاهزية، لقطة الحظة، الترجيح، والصور الموثّقة.</p>
      <label class="chk small"><input type="checkbox" id="rPh" ${photos.length ? 'checked' : ''}> إرفاق الصور الموثّقة (${photos.length})</label>
      <div class="btn-row"><button class="btn primary" id="rNow" ${app.ecus.size ? '' : 'disabled'}>إنشاء ومشاركة</button><button class="btn" id="rDl" ${app.ecus.size ? '' : 'disabled'}>تنزيل</button></div>${app.ecus.size ? '' : '<div class="small dim">اتصل وافحص أولًا، أو اختر فحصًا محفوظًا من السجل.</div>'}</div>
      <div class="card"><h2>مقارنة الحالة عبر الزمن</h2><p class="small muted">اختر فحصين من السجل لمقارنة الأعطال الجديدة والمحلولة والمستمرة.</p><button class="btn" id="rCmp" ${pick.length === 2 ? '' : 'disabled'}>مقارنة المحدّدين (${pick.length}/2)</button><div id="rCmpOut"></div></div>
      <div class="card spanall"><h2>سجل الفحوصات (محفوظ على هذا الجهاز)</h2>${scans.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th>التاريخ</th><th>السيارة</th><th>الأعطال</th><th>الكمبيوترات</th><th></th></tr></thead><tbody>${scans.map(s => `<tr><td><input type="checkbox" data-pick="${esc(s.id)}" ${pick.includes(s.id) ? 'checked' : ''}></td><td>${fmtDate(s.t)}${s.demo ? ' <span class="badge vi">تجريبي</span>' : ''}</td><td>${esc([s.vehicle?.make, s.vehicle?.year].filter(Boolean).join(' ') || '—')} <span class="mono small dim">${esc(s.vehicle?.vin || '')}</span></td><td>${s.dtcs?.length ? `<span class="badge err">${s.dtcs.length}</span> <span class="small mono">${esc(s.dtcs.map(d => d.code).slice(0, 6).join(' '))}</span>` : '<span class="badge ok">0</span>'}</td><td class="num">${s.ecus?.length || 0}</td><td><button class="btn sm" data-rep="${esc(s.id)}">تقرير</button> <button class="btn sm ghost" data-del="${esc(s.id)}">حذف</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">لا توجد فحوصات محفوظة بعد. كل «فحص شامل» يُحفظ هنا تلقائيًا.</div>'}
      ${store.persistent ? '' : '<div class="warn" style="margin-top:8px">المتصفح يمنع التخزين الدائم (ربما وضع التصفح الخاص): السجل محفوظ لهذه الجلسة فقط.</div>'}
      <div class="small dim" style="margin-top:8px">المرحلة الأولى: التخزين محلي لكل جهاز. المزامنة بين الأجهزة غير متوفرة بعد — يمكنك نقل البيانات بتصدير نسخة احتياطية من الإعدادات.</div></div></div>`;
    const make = async (rec) => { if ($('#rPh', c)?.checked) rec = { ...rec, photos: photos.filter(p => safeImg(p.data) && (!rec.vehicle?.vin || !p.vin || p.vin === rec.vehicle.vin)) }; return scanReportHtml(rec, correlate({ dtcs: rec.dtcs || [], live: rec.live || {}, trims: null, volt: rec.voltage, mode06: (rec.mode06 || []).flatMap(m => m.rows || []), charge: chargeRange(rec.vehicle) })); };
    const cur = () => app.lastScan && app.lastScan.ecus ? { ...snapshotScan(), t: app.lastScan.t } : snapshotScan();
    const sName = x => `car-session-${new Date(x.t).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html`;
    $$('[data-sview]', c).forEach(b => b.onclick = async () => { const x = await store.get('sessions', b.dataset.sview); if (!x) return draw(); const html = sessionReportHtml(x); openReport(html, () => shareFile(sName(x), html)); });
    $$('[data-sshare]', c).forEach(b => b.onclick = async () => { const x = await store.get('sessions', b.dataset.sshare); if (x) shareFile(sName(x), sessionReportHtml(x)); });
    $$('[data-sdel]', c).forEach(b => b.onclick = async () => { if (await confirmAction({ title: 'حذف تقرير جلسة', what: 'حذف تسجيل هذه الجلسة وتقريرها من هذا الجهاز.', reversible: false })) { await store.del('sessions', b.dataset.sdel); draw(); } });
    $('#sStart', c)?.addEventListener('click', () => { session.start('يدويًا من صفحة التقارير'); draw(); });
    $('#sStop', c)?.addEventListener('click', async () => { await session.stop('أُنهي التسجيل يدويًا'); draw(); });
    $('#rNow', c).onclick = async () => shareFile(`car-report-${new Date().toISOString().slice(0, 10)}.html`, await make(cur()));
    $('#rDl', c).onclick = async () => { const r = await download(`car-report-${new Date().toISOString().slice(0, 10)}.html`, await make(cur())); if (r === 'downloaded') toast('نُزّل التقرير', 'ok'); };
    $$('[data-rep]', c).forEach(b => b.onclick = async () => { const s = await store.get('scans', b.dataset.rep); if (!s) { toast('هذا الفحص لم يعد موجودًا', 'warn'); draw(); return; } shareFile(`car-report-${new Date(s.t).toISOString().slice(0, 10)}.html`, await make(s)); });
    $$('[data-del]', c).forEach(b => b.onclick = async () => { if (await confirmAction({ title: 'حذف فحص', what: 'حذف هذا الفحص من السجل المحلي.', reversible: false })) { await store.del('scans', b.dataset.del); pick = pick.filter(x => x !== b.dataset.del); draw(); } });
    $$('[data-pick]', c).forEach(b => b.onchange = () => { pick = b.checked ? [...pick, b.dataset.pick].slice(-2) : pick.filter(x => x !== b.dataset.pick); draw(); });
    $('#rCmp', c).onclick = async () => {
      const got = (await Promise.all(pick.map(id => store.get('scans', id)))).filter(Boolean);
      if (got.length < 2) { pick = got.map(s => s.id); toast('أحد الفحصين المحدّدين لم يعد موجودًا', 'warn'); draw(); return; }
      const [a, b] = got.sort((x, y) => x.t - y.t);
      const A = new Set((a.dtcs || []).map(d => d.code)), B = new Set((b.dtcs || []).map(d => d.code));
      const nw = [...B].filter(x => !A.has(x)), gone = [...A].filter(x => !B.has(x)), same = [...B].filter(x => A.has(x));
      // all emission computers together, same rule as everywhere else in the app
      const rdy = s => { const st = readinessStats(combineReadiness((s.readiness || []).map(r => [r.ecu, r]))); return st ? `${st.ready}/${st.total}` : '—'; };
      $('#rCmpOut', c).innerHTML = `<div class="small" style="margin-top:10px">${fmtDate(a.t)} ← ${fmtDate(b.t)}</div><dl class="kv" style="margin-top:8px">
        <dt>أعطال جديدة</dt><dd>${nw.length ? nw.map(x => `<span class="badge err mono">${x}</span>`).join(' ') : '—'}</dd>
        <dt>أعطال اختفت</dt><dd>${gone.length ? gone.map(x => `<span class="badge ok mono">${x}</span>`).join(' ') : '—'}</dd>
        <dt>مستمرة</dt><dd>${same.length ? same.map(x => `<span class="badge warn mono">${x}</span>`).join(' ') : '—'}</dd>
        <dt>الجاهزية</dt><dd>${rdy(a)} ← ${rdy(b)}</dd><dt>فولت البطارية</dt><dd class="num">${a.voltage?.toFixed(2) || '—'} ← ${b.voltage?.toFixed(2) || '—'}</dd></dl>`;
    };
  };
  const off = bus.on('session', ({ state }) => { if (state === 'done' && c.isConnected) draw(); });
  draw();
  return off;
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
      try {
        const data = JSON.parse(await f.text());
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('المحتوى ليس كائن JSON');
        if (![data.modules, data.routines, data.codes, data.circuits].some(Boolean)) throw new Error('لا يحتوي modules أو routines أو codes أو circuits');
        await store.put('library', { id: uid(), t: Date.now(), name: String(data.name || f.name), data }); await loadLibrary(); toast('أُضيفت المكتبة', 'ok'); draw();
      } catch (er) { toast('ملف غير صالح: ' + er.message, 'err'); }
      e.target.value = '';
    };
    $('#lTpl', c).onclick = async () => { const r = await download('car-tech-library-template.json', JSON.stringify(LIB_TEMPLATE, null, 2), 'application/json'); if (r === 'downloaded') toast('نُزّل القالب', 'ok'); };
    $$('[data-ldel]', c).forEach(b => b.onclick = async () => { await store.del('library', b.dataset.ldel); await loadLibrary(); draw(); });
    $('#dExp', c).onclick = async () => { const o = { v: 1, t: Date.now(), settings: { ...settings(), apiKey: '' } }; for (const s2 of ['scans', 'trips', 'ai', 'photos', 'vehicles', 'library', 'sessions']) o[s2] = await store.all(s2); const r = await download(`car-tech-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(o), 'application/json'); if (r === 'downloaded') toast('صُدّرت النسخة (بدون مفتاح API)', 'ok'); };
    $('#dImp', c).onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const o = JSON.parse(await f.text());
        if (!o || typeof o !== 'object') throw new Error('bad');
        let n = 0, skipped = 0;
        for (const s2 of ['scans', 'trips', 'ai', 'photos', 'vehicles', 'library', 'sessions']) {
          for (const r of Array.isArray(o[s2]) ? o[s2] : []) {
            if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) { skipped++; continue; }
            if (s2 === 'sessions' && (typeof r.t !== 'number' || typeof r.series !== 'object' || !Array.isArray(r.events))) { skipped++; continue; }
            if (s2 === 'photos' && !safeImg(r.data)) { skipped++; continue; }
            await store.put(s2, r); n++;
          }
        }
        await loadLibrary(); toast(`استُوردت ${n} سجل${skipped ? ` (تُجوهل ${skipped} غير صالح)` : ''}`, 'ok');
      } catch (er) { toast('ملف غير صالح', 'err'); }
      e.target.value = '';
    };
    $('#dClr', c).onclick = async () => { if (!(await confirmAction({ title: 'حذف كل البيانات', what: 'حذف الفحوصات والمشاوير وتقارير الجلسات والصور والإجابات والمكتبات المحفوظة على هذا الجهاز.', reversible: false, danger: true, typeWord: 'احذف' }))) return; for (const s2 of ['scans', 'trips', 'ai', 'photos', 'vehicles', 'library', 'sessions']) await store.clear(s2); await loadLibrary(); toast('حُذفت البيانات', 'ok'); draw(); };
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
