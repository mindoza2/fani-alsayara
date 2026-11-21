// Visual widgets: circular gauges, glowing charts, network map, wiring diagrams.
import { esc, fmtNum, conf } from './util.js';
import { PIDS, rangeStatus } from './obd.js';

/* ---------------- circular gauge ---------------- */
const CX = 100, CY = 100, R = 78, A0 = 150, SW = 240;
const pt = (a, r = R) => [CX + r * Math.cos(a * Math.PI / 180), CY + r * Math.sin(a * Math.PI / 180)];
function arc(a1, a2, r = R) {
  const [x1, y1] = pt(a1, r), [x2, y2] = pt(a2, r);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
let gid = 0;
export function gaugeEl({ name, unit, min, max, ok, warn, removable }) {
  const id = 'g' + (++gid);
  const ang = v => A0 + SW * Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
  let zones = `<path d="${arc(A0, A0 + SW)}" stroke="rgba(255,84,104,.22)" stroke-width="7" fill="none"/>`;
  if (warn) zones += `<path d="${arc(ang(warn[0]), ang(warn[1]))}" stroke="rgba(255,181,71,.55)" stroke-width="7" fill="none"/>`;
  if (ok) zones += `<path d="${arc(ang(ok[0]), ang(ok[1]))}" stroke="rgba(51,227,155,.7)" stroke-width="7" fill="none"/>`;
  if (!ok && !warn) zones = `<path d="${arc(A0, A0 + SW)}" stroke="rgba(120,170,255,.18)" stroke-width="7" fill="none"/>`;
  let ticks = '';
  for (let i = 0; i <= 10; i++) { const a = A0 + SW * i / 10; const [x1, y1] = pt(a, 64), [x2, y2] = pt(a, i % 5 ? 68 : 71); ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(180,200,230,${i % 5 ? .25 : .5})" stroke-width="${i % 5 ? 1 : 2}"/>`; }
  const div = document.createElement('div');
  div.className = 'card gauge';
  div.innerHTML = `${removable ? '<button class="rm" title="إزالة">✕</button>' : ''}
  <svg viewBox="0 0 200 170">
    <defs><linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="#2f7bff"/><stop offset="1" stop-color="#3de0ff"/></linearGradient>
    <filter id="${id}f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <path d="${arc(A0, A0 + SW, 90)}" stroke="rgba(120,170,255,.08)" stroke-width="14" fill="none" stroke-linecap="round"/>
    ${zones}${ticks}
    <path class="val" d="${arc(A0, A0 + 0.01, 90)}" stroke="url(#${id})" stroke-width="10" fill="none" stroke-linecap="round" filter="url(#${id}f)"/>
    <circle class="ndl" cx="${pt(A0, 90)[0]}" cy="${pt(A0, 90)[1]}" r="5" fill="#fff" filter="url(#${id}f)"/>
    <text x="30" y="160" fill="#6b7d98" font-size="10" font-family="Chakra Petch" text-anchor="middle">${fmtNum(min)}</text>
    <text x="170" y="160" fill="#6b7d98" font-size="10" font-family="Chakra Petch" text-anchor="middle">${fmtNum(max)}</text>
  </svg>
  <div class="g-val num">--</div>
  <div class="g-name">${esc(name)} <span class="g-unit">${esc(unit || '')}</span></div>
  <div class="g-state dim">—</div>`;
  const valP = div.querySelector('.val'), ndl = div.querySelector('.ndl'), vt = div.querySelector('.g-val'), st = div.querySelector('.g-state');
  div.update = (v, dec = 0, status) => {
    if (v == null || Number.isNaN(v)) { vt.textContent = '--'; return; }
    const a = ang(v);
    valP.setAttribute('d', arc(A0, Math.max(A0 + 0.01, a), 90));
    const [x, y] = pt(a, 90); ndl.setAttribute('cx', x); ndl.setAttribute('cy', y);
    vt.textContent = Number(v).toFixed(dec);
    div.classList.remove('st-ok', 'st-warn', 'st-bad');
    if (status?.st && status.st !== 'na') div.classList.add('st-' + status.st);
    st.innerHTML = status?.st === 'ok' ? '<span style="color:var(--gr)">● ضمن الطبيعي</span>' : status?.st === 'warn' ? '<span style="color:var(--am)">● قرب الحد</span>' : status?.st === 'bad' ? '<span style="color:var(--rd)">● خارج الطبيعي</span>' : `<span class="dim">${esc(status?.note || 'لا يوجد نطاق مرجعي')}</span>`;
  };
  return div;
}
export function pidGauge(pid, removable) {
  const d = PIDS[pid] || ['PID ' + pid, '', 0, null, 0, 255, 0];
  const hl = d[7];
  return gaugeEl({ name: d[0], unit: d[1], min: d[4] ?? 0, max: d[5] ?? 100, ok: hl?.ok, warn: hl?.warn, removable });
}
export function updatePidGauge(g, pid, v, ctx) { g.update(v, PIDS[pid]?.[6] ?? 0, rangeStatus(pid, v, ctx)); }

/* ---------------- line chart (canvas, glow) ---------------- */
export function drawChart(cv, series, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, hgt = cv.clientHeight;
  if (!w || !hgt) return;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = hgt * dpr; }
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, hgt);
  const pad = { l: 42, r: 10, t: 10, b: 22 };
  const all = series.flatMap(s => s.data.map(p => p[1])).filter(v => v != null && !Number.isNaN(v));
  if (!all.length) { c.fillStyle = '#6b7d98'; c.font = '13px IBM Plex Sans Arabic'; c.textAlign = 'center'; c.fillText(opts.empty || 'لا توجد بيانات بعد', w / 2, hgt / 2); return; }
  let mn = opts.min ?? Math.min(...all), mx = opts.max ?? Math.max(...all);
  if (opts.band) { mn = Math.min(mn, opts.band[0]); mx = Math.max(mx, opts.band[1]); }
  if (mx - mn < 1e-6) { mx += 1; mn -= 1; }
  const span = mx - mn; mn -= span * 0.06; mx += span * 0.06;
  const ts = series.flatMap(s => s.data.map(p => p[0]));
  const t1 = Math.max(...ts), t0 = opts.tspan ? t1 - opts.tspan : Math.min(...ts);
  const X = t => pad.l + (w - pad.l - pad.r) * ((t - t0) / ((t1 - t0) || 1));
  const Y = v => pad.t + (hgt - pad.t - pad.b) * (1 - (v - mn) / (mx - mn));
  if (opts.band) { c.fillStyle = 'rgba(51,227,155,.07)'; c.fillRect(pad.l, Y(opts.band[1]), w - pad.l - pad.r, Y(opts.band[0]) - Y(opts.band[1])); c.strokeStyle = 'rgba(51,227,155,.25)'; c.setLineDash([4, 4]); [opts.band[0], opts.band[1]].forEach(v => { c.beginPath(); c.moveTo(pad.l, Y(v)); c.lineTo(w - pad.r, Y(v)); c.stroke(); }); c.setLineDash([]); }
  c.strokeStyle = 'rgba(120,170,255,.08)'; c.fillStyle = '#6b7d98'; c.font = '10px Chakra Petch'; c.textAlign = 'right';
  for (let i = 0; i <= 4; i++) { const v = mn + (mx - mn) * i / 4; const y = Y(v); c.beginPath(); c.moveTo(pad.l, y); c.lineTo(w - pad.r, y); c.stroke(); c.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1), pad.l - 6, y + 3); }
  (opts.events || []).forEach(e => { if (e.t < t0) return; const x = X(e.t); c.strokeStyle = e.kind === 'bad' ? 'rgba(255,84,104,.6)' : 'rgba(255,181,71,.5)'; c.beginPath(); c.moveTo(x, pad.t); c.lineTo(x, hgt - pad.b); c.stroke(); });
  for (const s of series) {
    const d = s.data.filter(p => p[0] >= t0 && p[1] != null);
    if (!d.length) continue;
    c.save(); c.shadowColor = s.color; c.shadowBlur = 10; c.strokeStyle = s.color; c.lineWidth = 2; c.lineJoin = 'round';
    c.beginPath(); d.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))); c.stroke(); c.restore();
    if (series.length === 1) {
      const g = c.createLinearGradient(0, pad.t, 0, hgt - pad.b); g.addColorStop(0, s.color + '33'); g.addColorStop(1, s.color + '00');
      c.fillStyle = g; c.beginPath(); d.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))); c.lineTo(X(d.at(-1)[0]), hgt - pad.b); c.lineTo(X(d[0][0]), hgt - pad.b); c.closePath(); c.fill();
    }
  }
  if (series.length > 1) { c.textAlign = 'left'; c.font = '11px IBM Plex Sans Arabic'; let x = pad.l + 6; series.forEach(s => { c.fillStyle = s.color; c.fillRect(x, 6, 10, 3); c.fillStyle = '#9fb0c9'; c.fillText(s.name, x + 14, 11); x += c.measureText(s.name).width + 34; }); }
}
export function sparkline(values, color = '#3de0ff', w = 120, h = 34) {
  const v = values.filter(x => x != null); if (v.length < 2) return '<span class="dim small">—</span>';
  const mn = Math.min(...v), mx = Math.max(...v), sp = mx - mn || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1) * (w - 4) + 2).toFixed(1)},${(h - 3 - (x - mn) / sp * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" style="filter:drop-shadow(0 0 3px ${color})"/></svg>`;
}

/* ---------------- network map ---------------- */
export const NODE_COLORS = { ok: ['#33e39b', 'سليم'], fault: ['#ff5468', 'فيه عطل'], noresp: ['#8a96a8', 'لا يرد'], unreach: ['#a57bff', 'خارج الوصول'], partial: ['#ffb547', 'يرد — قراءة محدودة'] };
export function netmapSvg(nodes, { busName = 'شبكة CAN' } = {}) {
  const main = nodes.filter(n => n.status !== 'unreach'), out = nodes.filter(n => n.status === 'unreach');
  const per = Math.max(1, Math.ceil(main.length / 2));
  const W = Math.max(760, 200 * per + 220), H = out.length ? 430 : 330, busY = 165;
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans Arabic" style="direction:ltr"><style>text{direction:rtl}</style>
  <defs><filter id="nglow" filterUnits="userSpaceOnUse" x="-50" y="-50" width="${W + 100}" height="${H + 100}"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <linearGradient id="busg" x1="0" x2="1"><stop offset="0" stop-color="#2f7bff"/><stop offset="1" stop-color="#3de0ff"/></linearGradient></defs>
  <line x1="150" y1="${busY}" x2="${W - 30}" y2="${busY}" stroke="url(#busg)" stroke-width="5" stroke-linecap="round" filter="url(#nglow)"/>
  <line x1="150" y1="${busY + 9}" x2="${W - 30}" y2="${busY + 9}" stroke="#1f6fb8" stroke-width="2" opacity=".6"/>
  <text x="16" y="${busY + 56}" fill="#6b7d98" font-size="10.5" text-anchor="end">${esc(busName)}</text>
  <g class="node" data-key="__adapter"><rect x="16" y="${busY - 34}" width="124" height="68" rx="14" fill="rgba(61,224,255,.12)" stroke="#3de0ff" stroke-width="1.5" filter="url(#nglow)"/>
  <text x="78" y="${busY - 6}" fill="#e6eefb" font-size="13" text-anchor="middle" font-weight="600">قطعة الفحص</text><text x="78" y="${busY + 15}" fill="#9fb0c9" font-size="11" text-anchor="middle">فيش OBD</text></g>`;
  main.forEach((n, i) => {
    const col = Math.floor(i / 2), up = i % 2 === 0;
    const x = 190 + col * 200, y = up ? 28 : 222, w = 184, h = 82;
    const [c] = NODE_COLORS[n.status] || NODE_COLORS.noresp;
    const ly = up ? y + h : y;
    s += `<line x1="${x + w / 2}" y1="${ly}" x2="${x + w / 2}" y2="${busY + (up ? 0 : 9)}" stroke="${c}" stroke-width="2" ${n.status === 'noresp' ? 'stroke-dasharray="5 5"' : ''} opacity=".8"/>
    <circle cx="${x + w / 2}" cy="${busY + (up ? 0 : 9)}" r="4" fill="${c}"/>
    <g class="node" data-key="${esc(n.key)}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${c}1f" stroke="${c}" stroke-width="1.6" ${n.status === 'noresp' ? 'stroke-dasharray="6 4"' : ''} filter="url(#nglow)"/>
    <text x="${x + w / 2}" y="${y + 24}" fill="#e6eefb" font-size="12" text-anchor="middle" font-weight="600">${esc(trunc(n.name, 27))}</text>
    <text x="${x + w / 2}" y="${y + 44}" fill="#9fb0c9" font-size="11" text-anchor="middle" font-family="Chakra Petch">${esc(n.addr || '')}</text>
    <text x="${x + w / 2}" y="${y + 66}" fill="${c}" font-size="11.5" text-anchor="middle">${esc(n.badge || NODE_COLORS[n.status]?.[1] || '')}</text></g>`;
  });
  if (out.length) {
    const y2 = 360;
    s += `<line x1="150" y1="${y2}" x2="${W - 30}" y2="${y2}" stroke="#a57bff" stroke-width="3" stroke-dasharray="10 8" opacity=".7"/>
    <text x="${W - 34}" y="${y2 - 10}" fill="#a57bff" font-size="12" text-anchor="start">شبكة لا تصلها هذه القطعة</text>`;
    out.forEach((n, i) => {
      const x = 190 + i * 250;
      s += `<g class="node" data-key="${esc(n.key)}"><rect x="${x}" y="${y2 + 14}" width="240" height="48" rx="12" fill="rgba(165,123,255,.12)" stroke="#a57bff" stroke-dasharray="6 4"/>
      <text x="${x + 120}" y="${y2 + 43}" fill="#d6c4ff" font-size="12" text-anchor="middle">${esc(trunc(n.name, 38))}</text></g>`;
    });
  }
  return s + '</svg>';
}
const trunc = (s, n) => (s = String(s || ''), s.length > n ? s.slice(0, n - 1) + '…' : s);

/* ---------------- wiring diagram ---------------- */
export const ROLE = { ref5: ['#ffb547', 'مرجع 5V'], sig: ['#3de0ff', 'إشارة'], gnd: ['#8a96a8', 'أرضي'], 'b+': ['#ff5468', 'تغذية +12V'], ctrl: ['#a57bff', 'تحكم'], can: ['#33e39b', 'شبكة'], air: ['#9fd8ff', 'هواء'], fuel: ['#ffd166', 'وقود'] };
export function wiringSvg(c, { live = {}, checks = [], selected = null } = {}) {
  const comps = Object.fromEntries(c.comps.map(x => [x.id, x]));
  const W = 800, H = Math.max(360, ...c.comps.map(x => x.y + x.h + 40));
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans Arabic" style="direction:ltr"><style>text{direction:rtl}</style>
  <defs><filter id="wglow" filterUnits="userSpaceOnUse" x="-50" y="-50" width="${W + 100}" height="${H + 100}"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  const n = c.wires.length;
  let labels = '';
  c.wires.forEach((w, k) => {
    const a = comps[w.a || 'ecm'], b = comps[w.b || 'c'];
    if (!a || !b) return;
    let x1, y1, x2, y2;
    const aLeft = a.x < b.x;
    if (!w.a && !w.b) { x1 = a.x + a.w; y1 = a.y + 34 + w.i * 40; x2 = b.x; y2 = b.y + 34 + w.i * 40; }
    else {
      x1 = aLeft ? a.x + a.w : a.x; x2 = aLeft ? b.x : b.x + b.w;
      const off = (k - (n - 1) / 2) * 10;
      y1 = a.y + a.h / 2 + off; y2 = b.y + b.h / 2 + off;
      if (Math.abs(a.x - b.x) < 60) { x1 = a.x + a.w / 2 + off; y1 = a.y < b.y ? a.y + a.h : a.y; x2 = b.x + b.w / 2 + off; y2 = a.y < b.y ? b.y : b.y + b.h; }
      if (w.y != null) { y1 = y2 = +w.y; } // a fixed straight run (one row per wire)
    }
    const [col] = ROLE[w.role] || ROLE.sig;
    const chk = checks.find(x => x.wire === k);
    const stc = chk ? { ok: '#33e39b', warn: '#ffb547', bad: '#ff5468' }[chk.st] : null;
    const mx = (x1 + x2) / 2;
    const d = Math.abs(y1 - y2) < 1 ? `M${x1} ${y1} H${x2}` : Math.abs(a.x - b.x) < 60 ? `M${x1} ${y1} V${(y1 + y2) / 2} H${x2} V${y2}` : `M${x1} ${y1} H${mx} V${y2} H${x2}`;
    const sel = selected === 'w' + k;
    s += `<g class="wire" data-w="${k}"><path d="${d}" stroke="transparent" stroke-width="16" fill="none"/>
      <path d="${d}" stroke="${col}" stroke-width="${sel ? 5 : 3}" fill="none" filter="url(#wglow)" ${chk?.st === 'bad' ? 'stroke-dasharray="10 6"' : ''} ${w.conf === 'est' ? 'stroke-opacity=".7"' : ''}/>`;
    s += '</g>';
    const vert = Math.abs(a.x - b.x) < 60 && (w.a || w.b);
    const ly = vert ? (y1 + y2) / 2 : Math.abs(y1 - y2) < 1 ? y1 - 8 : y2 - 8;
    const lx = vert ? x1 + 12 : Math.abs(y1 - y2) < 1 ? mx : (mx + x2) / 2;
    const anc = vert ? 'end' : 'middle'; // svg text is rtl: "end" = grows to the right of x
    // quiet wires (a bus drawn as many segments) show their label only when picked
    labels += `<g class="wire" data-w="${k}">${w.quiet && !sel ? '' : `<text x="${lx}" y="${ly}" fill="${col}" font-size="11.5" text-anchor="${anc}" paint-order="stroke" stroke="#0a101a" stroke-width="4">${esc(w.label)}</text>`}`;
    const lv = w.pid != null ? live[w.pid] : w.vlive ? live.__volt : null;
    if (lv != null || chk) {
      const txt = lv != null ? (typeof lv === 'number' ? lv.toFixed(Math.abs(lv) < 20 ? 2 : 0) : lv) : '';
      const cw = 66, bx = vert ? lx : lx - cw / 2, by = ly + 6;
      labels += `<rect x="${bx}" y="${by}" width="${cw}" height="20" rx="6" fill="rgba(5,9,15,.92)" stroke="${stc || col}"/><text x="${bx + cw / 2}" y="${by + 14}" fill="${stc || '#fff'}" font-size="11" text-anchor="middle" font-family="Chakra Petch">${chk?.st === 'bad' ? '✕ ' : chk?.st === 'ok' ? '✓ ' : ''}${esc(String(txt))}</text>`;
    }
    labels += '</g>';
  });
  for (const x of c.comps) {
    const isEcm = x.kind === 'ecm';
    const fill = isEcm ? 'rgba(47,123,255,.16)' : x.kind === 'fuse' || x.kind === 'relay' ? 'rgba(255,181,71,.10)' : x.kind === 'batt' ? 'rgba(255,84,104,.10)' : x.kind === 'dlc' ? 'rgba(51,227,155,.1)' : 'rgba(61,224,255,.08)';
    const st = isEcm ? '#2f7bff' : x.kind === 'fuse' || x.kind === 'relay' ? '#ffb547' : x.kind === 'batt' ? '#ff5468' : x.kind === 'dlc' ? '#33e39b' : '#3de0ff';
    const sel = selected === 'c' + x.id;
    s += `<g class="wcomp" data-c="${esc(x.id)}"><rect x="${x.x}" y="${x.y}" width="${x.w}" height="${x.h}" rx="12" fill="${fill}" stroke="${st}" stroke-width="${sel ? 2.6 : 1.4}"/>
    <text x="${x.x + x.w / 2}" y="${x.y + 22}" fill="#e6eefb" font-size="12.5" font-weight="600" text-anchor="middle">${esc(x.label)}</text>${x.sub ? `<text x="${x.x + x.w / 2}" y="${x.y + 40}" fill="#9fb0c8" font-size="10.5" text-anchor="middle">${esc(x.sub)}</text>` : ''}</g>`;
  }
  return s + labels + '</svg>';
}
export function confBadge(level) { return conf(level); }
