// Shell: navigation, responsive layout, status bar, router, voice control.
import { $, $$, esc, bus, toast, h, modal, shareFile } from './util.js';
import { app, loadLibrary, fullScan, connectDemo, requireConn } from './core.js';
import { settings, store } from './store.js';
import { go, speak } from './nav.js';
import { chargeRange } from './obd.js';
import * as V1 from './views-core.js';
import * as V2 from './views-live.js';
import * as V3 from './views-tools.js';
import * as V4 from './views-wiring.js';
import * as V5 from './views-analyst.js';
import { initSession, session } from './session.js';
import { sessionReportHtml, openReport } from './session-report.js';

export const ROUTES = [
  { id: 'dash', ic: '◉', t: 'لوحة القيادة', g: 'الأساس', v: V1.dashboard },
  { id: 'connect', ic: '⌁', t: 'الاتصال والقطعة', g: 'الأساس', v: V1.connectView },
  { id: 'map', ic: '⬡', t: 'خريطة الشبكة', g: 'الأساس', v: V1.mapView },
  { id: 'scan', ic: '✚', t: 'الفحص الشامل', g: 'الأساس', v: V1.scanView },
  { id: 'codes', ic: '⚠', t: 'الأعطال وأوضاع OBD', g: 'الأساس', v: V1.codesView },
  { id: 'ready', ic: '✓', t: 'الجاهزية', g: 'الأساس', v: V1.readyView },
  { id: 'live', ic: '◔', t: 'البيانات الحية', g: 'الأساس', v: V2.liveView },
  { id: 'diag', ic: '✦', t: 'محلّل الأعطال', g: 'التحليل', v: V5.diagView },
  { id: 'trip', ic: '⏱', t: 'مسجّل المشوار', g: 'التحليل', v: V2.tripView },
  { id: 'wiring', ic: '⌇', t: 'المخططات الكهربائية', g: 'التحليل', v: V4.wiringView },
  { id: 'twin', ic: '◈', t: 'المتابعة التنبّؤية', g: 'التحليل', v: V2.twinView },
  { id: 'services', ic: '⚙', t: 'الخدمات والتحكّم', g: 'الأدوات', v: V3.servicesView },
  { id: 'ai', ic: '✉', t: 'اسأل الفني', g: 'الأدوات', v: V3.aiView },
  { id: 'sensors', ic: '◎', t: 'حساسات الجوال', g: 'الأدوات', v: V2.sensorsView },
  { id: 'reports', ic: '☰', t: 'التقارير والسجل', g: 'السجل', v: V3.reportsView },
  { id: 'settings', ic: '⚒', t: 'الإعدادات', g: 'السجل', v: V3.settingsView },
];
const BOTTOM = ['dash', 'scan', 'live', 'ai'];
let cleanup = null, current = null, routeSeq = 0;

function buildNav() {
  const nav = $('#nav'); let g = '';
  nav.innerHTML = ROUTES.map(r => { const head = r.g !== g ? `<div class="nav-group">${(g = r.g)}</div>` : ''; return `${head}<a href="#/${r.id}" data-r="${r.id}"><span class="ic">${r.ic}</span><span>${r.t}</span><span class="badge err hidden" data-badge="${r.id}"></span></a>`; }).join('');
  const SHORT = { dash: 'الرئيسية', scan: 'الفحص', live: 'الحية', ai: 'الفني' };
  $('#bottombar').innerHTML = BOTTOM.map(id => `<a href="#/${id}" data-r="${id}"><span class="ic">${ROUTES.find(x => x.id === id).ic}</span>${SHORT[id]}</a>`).join('') + `<a href="#" id="moreBtn"><span class="ic">⋯</span>المزيد</a>`;
  $('#moreSheet').innerHTML = `<div class="sheet-grid">${ROUTES.map(r => `<a href="#/${r.id}"><span class="ic">${r.ic}</span>${r.t}</a>`).join('')}</div>`;
  const openSheet = e => { e.preventDefault(); $('#moreSheet').classList.remove('hidden'); $('#sheetBackdrop').classList.remove('hidden'); };
  $('#moreBtn').onclick = openSheet; $('#menuBtn').onclick = openSheet;
  const closeSheet = () => { $('#moreSheet').classList.add('hidden'); $('#sheetBackdrop').classList.add('hidden'); };
  $('#sheetBackdrop').onclick = closeSheet; $('#moreSheet').addEventListener('click', e => { if (e.target.closest('a')) closeSheet(); });
  $('#sidebarFoot').innerHTML = `التخزين محلي على هذا الجهاز فقط.<br>كل معلومة تحمل مستوى ثقة: <span class="conf c-sure">موثوق</span> <span class="conf c-best">أفضل جهد</span> <span class="conf c-est">تقديري</span>`;
}
async function route() {
  const my = ++routeSeq;
  const id = (location.hash.match(/^#\/([\w-]+)/) || [])[1] || 'dash';
  const r = ROUTES.find(x => x.id === id) || ROUTES[0];
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  current = r.id;
  $$('[data-r]').forEach(a => a.classList.toggle('active', a.dataset.r === r.id));
  $('#pageTitle').textContent = r.t;
  document.title = r.t + ' — فني السيارة';
  const host = $('#content'); host.innerHTML = ''; host.scrollTop = 0; window.scrollTo(0, 0);
  // every visit renders into its own container: work that finishes after the person has moved on
  // (a scan, a reply from Claude, a timer) lands in a detached element, never over the new page
  const c = document.createElement('div'); c.className = 'view'; host.appendChild(c);
  let fn = null;
  try { fn = (await r.v(c)) || null; } catch (e) { console.error(e); c.innerHTML = `<div class="danger">حدث خطأ في عرض الصفحة: ${esc(e.message)}</div>`; }
  if (my !== routeSeq) { if (typeof fn === 'function') try { fn(); } catch (e) { console.error(e); } return; } // left while it was loading
  cleanup = typeof fn === 'function' ? fn : null;
}
export function rerender() { route(); }

function statusBar() {
  const chip = $('#connChip'), dot = chip.querySelector('.dot'), txt = $('#connText');
  const upd = ({ state, msg } = { state: app.conn.state }) => {
    dot.className = 'dot ' + ({ on: 'on', connecting: 'busy', reconnecting: 'busy', adapter: 'busy', err: 'err' }[state] || '');
    txt.textContent = { on: app.demo ? 'متصل (تجريبي)' : 'متصل', connecting: 'جارٍ الاتصال…', reconnecting: 'إعادة اتصال…', adapter: 'القطعة فقط', err: 'خطأ اتصال', off: 'غير متصل' }[state] || state;
    chip.title = msg || '';
  };
  bus.on('conn', upd); upd();
  chip.onclick = () => go('connect');
  const vEl = $('#voltVal'), vDot = $('#voltChip .dot');
  bus.on('volt', v => {
    vEl.textContent = v == null ? '--.-' : v.toFixed(1);
    const running = app.running(), cr = chargeRange(app.vehicle, app.conn.voltSrc === 'ecm' ? '7E8' : null); // GM RVC lowers charging on purpose
    vDot.className = 'dot ' + (v == null ? '' : running ? (v >= cr.ok[0] && v <= cr.ok[1] ? 'on' : v >= cr.warn[0] && v <= cr.warn[1] ? 'busy' : 'err') : v >= 12.3 ? 'on' : v >= 11.9 ? 'busy' : 'err');
  });
  bus.on('voltsrc', d => { if (d.frozen) toast(`القطعة تعطي فولت ثابت (${d.adapter.toFixed(1)}V) ما يتغير، بينما كمبيوتر المكينة يقرا ${d.ecmMin.toFixed(2)}–${d.ecmMax.toFixed(2)}V — صار الفولت من كمبيوتر المكينة`, 'warn'); });
  bus.on('demo', d => $('#demoFlag').classList.toggle('hidden', !d));
  const badges = () => {
    const n = app.allDtcs().length;
    $$('[data-badge="codes"],[data-badge="scan"]').forEach(b => { b.textContent = n; b.classList.toggle('hidden', !n); });
  };
  bus.on('data', badges);
  // the operation that owns the adapter (scan, module scan, clearing…) is visible on every page
  const bb = $('#busyBar');
  const busy = () => {
    const b = app.busy; bb.classList.toggle('hidden', !b);
    if (!b) return;
    bb.querySelector('i').style.width = Math.round((b.p || 0) * 100) + '%';
    bb.querySelector('span').textContent = `${b.label}${b.p ? ' — ' + Math.round(b.p * 100) + '%' : ''}${b.t ? ' · ' + b.t : ''}`;
  };
  bus.on('scan', busy); bus.on('progress', busy);
  // automatic session recording: a chip while it records, the report as soon as it ends
  const chip2 = document.createElement('button');
  chip2.className = 'stat-chip rec-chip hidden'; chip2.id = 'recChip'; chip2.title = 'تسجيل الجلسة — يطلع التقرير لما تفصل القطعة';
  chip2.innerHTML = '<span class="dot err"></span><span>تسجيل</span><span class="num" id="recTime">00:00</span>';
  $('#connChip').before(chip2);
  chip2.onclick = () => go('reports');
  const clock = ms => { const s = Math.floor(ms / 1000); return `${s >= 3600 ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  bus.on('session', async ({ state, id, recovered }) => {
    const r0 = session.rec;
    chip2.classList.toggle('hidden', !r0);
    if (r0) $('#recTime').textContent = clock(Date.now() - r0.t);
    if (state !== 'done') return;
    const r = await store.get('sessions', id).catch(() => null);
    if (!r) return;
    const html = sessionReportHtml(r);
    const name = `car-session-${new Date(r.t).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html`;
    const nCodes = Object.keys(r.codes || {}).length, nVals = (r.stats?.series || []).length;
    const pick = await modal(recovered ? 'تقرير الجلسة السابقة جاهز' : 'تقرير الجلسة جاهز',
      `<p>سجّلت ${clock((r.tEnd || r.t) - r.t)} من أول فحص لين ${esc(r.endedBy || 'النهاية')}: ${nVals} قيمة حية، ${nCodes} كود، ${(r.events || []).length} حدث${r.stats?.dist ? `، ${r.stats.dist.toFixed(1)} km` : ''}.</p><p class="small dim">التقرير محفوظ في «التقارير والسجل».</p>`,
      [{ label: 'اعرض التقرير', value: 'view', cls: 'primary' }, { label: 'مشاركة / حفظ', value: 'share' }, { label: 'لاحقًا', value: null }]);
    if (pick === 'view') openReport(html, () => shareFile(name, html));
    else if (pick === 'share') shareFile(name, html);
  });
}

/* ---------------- voice control (Arabic) ---------------- */
const COMMANDS = [
  { re: /(فحص شامل|افحص|ابدا الفحص|ابدأ الفحص)/, run: async () => { go('scan'); if (!requireConn()) return; speak('بدأت الفحص الشامل'); const r = await fullScan({}); speak(r.dtcs.length ? `انتهى الفحص. وجدت ${r.dtcs.length} عطل` : 'انتهى الفحص. لا توجد أعطال'); } },
  { re: /(اقرا|اقرأ|اعطال|أعطال|اكواد|أكواد)/, run: () => { go('codes'); const d = app.allDtcs(); speak(d.length ? 'الأعطال: ' + d.map(x => x.code.split('').join(' ')).join('، ') : app.lastScan ? 'لا توجد أعطال' : 'لم يتم الفحص بعد'); } },
  { re: /(بيانات حي|الحيه|الحية|عدادات|عدّادات)/, run: () => go('live') },
  { re: /(جاهزي)/, run: () => { go('ready'); const s = app.readinessSummary(); speak(s || 'لم تقرأ الجاهزية بعد'); } },
  { re: /(فولت|بطاري)/, run: () => speak(app.conn.voltage ? `فولت البطارية ${app.conn.voltage.toFixed(1)}` : 'الفولت غير متاح، القطعة غير متصلة') },
  { re: /(خريط|شبكه|شبكة)/, run: () => go('map') },
  { re: /(تشخيص|السبب)/, run: () => go('diag') },
  { re: /(تجريبي|عرض)/, run: async () => { await connectDemo(); go('dash'); speak('شغّلت الوضع التجريبي'); } },
  { re: /(اتصل|وصل)/, run: () => go('connect') },
  { re: /(اسال|اسأل|الفني)/, run: () => go('ai') },
  { re: /(امسح|مسح)/, run: () => { go('scan'); speak('للمسح اضغط زر المسح وأكّد بيدك، لأسباب السلامة لا أمسح بالأمر الصوتي فقط'); } },
  { re: /(تقرير|سجل)/, run: () => go('reports') },
];
function voice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // no button when unsupported (honesty)
  const btn = $('#voiceBtn'); btn.classList.remove('hidden');
  let rec = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = settings().voiceLang || 'ar-SA'; rec.interimResults = false; rec.maxAlternatives = 3;
    btn.classList.add('listening');
    rec.onresult = e => {
      const alts = [...e.results[0]].map(a => a.transcript.trim());
      const said = alts[0];
      const cmd = COMMANDS.find(c => alts.some(a => c.re.test(a)));
      if (cmd) { toast('🎙 ' + said, 'ok'); cmd.run().catch?.(err => toast(err.message, 'err')); }
      else { toast(`🎙 «${said}» — لم أفهم الأمر. جرّب: افحص، الأعطال، البيانات الحية، الجاهزية، الفولت`, 'warn'); speak('لم أفهم الأمر'); }
    };
    rec.onerror = e => toast('التعرّف الصوتي: ' + (e.error === 'not-allowed' ? 'لم يُسمح باستخدام المايك' : e.error), 'warn');
    rec.onend = () => { btn.classList.remove('listening'); rec = null; };
    rec.start();
  };
}

async function boot() {
  buildNav(); statusBar(); voice(); initSession();
  try { await loadLibrary(); } catch (e) { console.warn('library', e); }
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('car-tech-sw.js').catch(() => {});
  window.addEventListener('online', () => bus.emit('net')); window.addEventListener('offline', () => bus.emit('net'));
}
export const currentRoute = () => current;
boot();
