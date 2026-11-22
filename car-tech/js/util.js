// Shared helpers: DOM, formatting, modals, toasts, events.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');
export const hex3 = n => n.toString(16).toUpperCase().padStart(3, '0');
export const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');
export const bytesHex = arr => (arr || []).map(hex2).join(' ');
export function fmtNum(v, d = 0) {
  if (v == null || Number.isNaN(v)) return '--';
  return Number(v).toFixed(d);
}
export function fmtDate(t) {
  const d = new Date(t);
  return d.toLocaleString('ar-SA-u-ca-gregory-nu-latn', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtTime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// Rejects if the promise has not settled within ms (storage on some phones can stall forever).
export function withTimeout(p, ms, msg = 'انتهت المهلة') {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}
// Only image data URLs made by this app's camera/canvas are rendered (imported backups are untrusted).
export const safeImg = s => (typeof s === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(s) ? s : '');

// Confidence levels shown on every piece of information.
export const CONF = {
  sure: { cls: 'c-sure', label: 'موثوق', tip: 'قراءة حية أو معيار OBD قياسي' },
  best: { cls: 'c-best', label: 'أفضل جهد', tip: 'من المكتبة المرجعية أو بروتوكول خاص بالمصنّع' },
  est: { cls: 'c-est', label: 'تقديري', tip: 'تقدير ذكي — تحقّق منه قبل الاعتماد عليه' },
};
export function conf(level) {
  const c = CONF[level] || CONF.est;
  return `<span class="conf ${c.cls}" title="${esc(c.tip)}">${c.label}</span>`;
}

// Simple event bus
const listeners = {};
export const bus = {
  on(ev, fn) { (listeners[ev] ||= new Set()).add(fn); return () => listeners[ev].delete(fn); },
  // iterate over a copy: a handler that adds/removes listeners must not affect this round
  emit(ev, data) { [...(listeners[ev] || [])].forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
};

export function toast(msg, kind = '') {
  bus.emit('toast', { msg, kind }); // the session recorder keeps every message
  const box = $('#toasts');
  const t = h(`<div class="toast ${kind}">${esc(msg)}</div>`);
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6500 : 3800);
}

// Modal dialog. buttons: [{label, value, cls}] → resolves with value.
// Only one dialog at a time: a newer one resolves the older one as cancelled (null) instead of
// leaving its caller waiting forever.
let openClose = null;
export function modal(title, bodyHtml, buttons = [{ label: 'حسنًا', value: true, cls: 'primary' }]) {
  if (openClose) openClose(null);
  return new Promise(res => {
    const bd = $('#modalBackdrop'), m = $('#modal');
    m.innerHTML = `<h2>${esc(title)}</h2><div class="modal-body">${bodyHtml}</div><div class="btn-row"></div>`;
    const row = m.querySelector('.btn-row');
    const onKey = e => { if (e.key === 'Escape') close(null); };
    const close = v => { if (openClose !== close) return; openClose = null; document.removeEventListener('keydown', onKey); bd.classList.add('hidden'); m.innerHTML = ''; res(v); };
    openClose = close; document.addEventListener('keydown', onKey);
    buttons.forEach(b => {
      const el = h(`<button class="btn ${b.cls || ''}">${esc(b.label)}</button>`);
      el.onclick = () => {
        if (b.check && !b.check(m)) return;
        close(typeof b.value === 'function' ? b.value(m) : b.value);
      };
      row.appendChild(el);
    });
    bd.onclick = e => { if (e.target === bd) close(null); };
    bd.classList.remove('hidden');
  });
}

// Confirmation for sensitive actions; states honestly whether reversible.
export async function confirmAction({ title, what, reversible, extra = '', danger = false, typeWord = null }) {
  const rev = reversible == null
    ? `<div class="warn">؟ قابلية التراجع غير معروفة لهذا الإجراء (غير موثّق في المكتبة) — تعامل معه كأنه غير قابل للتراجع.</div>`
    : reversible
      ? `<div class="ok-box">↺ قابل للتراجع: ${esc(reversible === true ? 'نعم' : reversible)}</div>`
      : `<div class="danger">⚠ غير قابل للتراجع — لا يمكن استرجاع الحالة السابقة بعد التنفيذ.</div>`;
  const tw = typeWord ? `<label class="f">للتأكيد اكتب: <b>${esc(typeWord)}</b></label><input type="text" id="cfType" autocomplete="off">` : '';
  const body = `<p>${what}</p>${extra}${rev}${tw}`;
  const r = await modal(title, body, [
    { label: 'إلغاء', value: false, cls: 'ghost' },
    {
      label: 'تأكيد التنفيذ', value: true, cls: danger ? 'danger' : 'primary',
      check: m => { if (!typeWord) return true; const ok = m.querySelector('#cfType').value.trim() === typeWord; if (!ok) toast('اكتب كلمة التأكيد كما هي', 'warn'); return ok; },
    },
  ]);
  return r === true;
}

// Saving files. iPhone/iPad browsers built on WebKit's in-app view (Bluefy and others) ignore
// "download" links to in-memory files, so there the share sheet is used (→ «حفظ في الملفات»).
// Results: 'shared' | 'cancelled' | 'downloaded' — callers report what really happened.
const IOS = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
async function viaShareSheet(name, content, type) {
  let file;
  try { file = new File([content], name, { type }); } catch { return null; }
  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) return null;
  try { await navigator.share({ files: [file], title: name }); return 'shared'; }
  catch (e) { return e.name === 'AbortError' ? 'cancelled' : null; }
}
function viaLink(href, name) { const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
export async function download(name, content, type = 'text/html') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type + ';charset=utf-8' });
  if (IOS) {
    const r = await viaShareSheet(name, content, type);
    if (r) return r;
    // no share sheet: a data: link is the form those in-app views do accept
    const url = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
    if (url) { viaLink(url, name); return 'downloaded'; }
  }
  const href = URL.createObjectURL(blob);
  viaLink(href, name);
  setTimeout(() => URL.revokeObjectURL(href), 4000);
  return 'downloaded';
}
export async function shareFile(name, content, type = 'text/html') {
  const r = await viaShareSheet(name, content, type);
  return r || download(name, content, type);
}

// Keep the screen on while something is being recorded (a locked phone suspends the page and the
// Bluetooth link). Uses the Screen Wake Lock API where the browser offers it; where it does not
// (older iOS browsers such as Bluefy) a tiny silent video plays in a loop, which keeps iOS awake.
export function keepAwake() {
  let lock = null, on = true, vid = null;
  const video = () => {
    try {
      if (!vid) {
        vid = document.createElement('video');
        vid.setAttribute('playsinline', ''); vid.setAttribute('webkit-playsinline', ''); vid.setAttribute('aria-hidden', 'true');
        vid.muted = true; vid.loop = true; vid.preload = 'auto';
        vid.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.01;pointer-events:none;z-index:-1';
        vid.src = 'car-tech/nosleep.mp4';
        document.body.appendChild(vid);
      }
      vid.play()?.catch?.(() => {});
    } catch {}
  };
  const get = async () => {
    if (!on || document.visibilityState !== 'visible') return;
    if (navigator.wakeLock) { try { lock = await navigator.wakeLock.request('screen'); return; } catch {} }
    video();
  };
  const vis = () => { if (document.visibilityState === 'visible') get(); };
  get(); document.addEventListener('visibilitychange', vis);
  return { supported: !!navigator.wakeLock, release: () => { on = false; document.removeEventListener('visibilitychange', vis); try { lock?.release()?.catch?.(() => {}); } catch {} lock = null; try { vid?.pause(); vid?.remove(); } catch {} vid = null; } };
}

// Linear regression → {slope, intercept, r2}
export function linreg(xs, ys) {
  const n = xs.length; if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (!sxx) return null;
  const slope = sxy / sxx, intercept = my - slope * mx;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : 1;
  return { slope, intercept, r2 };
}
