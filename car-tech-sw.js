// Offline support for «فني السيارة»: network first, cached copy when offline.
const CACHE = 'car-tech-v6';
const FILES = ['index.html', 'car-tech/app.css', 'car-tech/icon.svg', 'car-tech/manifest.webmanifest',
  ...['app', 'util', 'nav', 'store', 'transport', 'elm', 'obd', 'dtcdb', 'network', 'diag', 'ai', 'core', 'widgets', 'report', 'views-core', 'views-live', 'views-tools', 'views-wiring', 'wiring-gm', 'views-analyst', 'analyst', 'session', 'session-report'].map(f => `car-tech/js/${f}.js`)];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname === 'api.anthropic.com') return;
  const own = u.origin === location.origin;
  // the app's own files are revalidated with the server every time (no stale mix of old and new
  // modules after an update); the cached copy is used only when offline
  const req = own && e.request.mode !== 'navigate' ? new Request(e.request, { cache: 'no-cache' }) : e.request;
  e.respondWith(fetch(req).then(r => { if (r.ok && (own || /fonts\.(googleapis|gstatic)\.com/.test(u.hostname))) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined))));
});
