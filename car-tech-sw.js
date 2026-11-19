// Offline support for «فني السيارة»: network first, cached copy when offline.
const CACHE = 'car-tech-v1';
const FILES = ['index.html', 'car-tech/app.css', 'car-tech/icon.svg', 'car-tech/manifest.webmanifest',
  ...['app', 'util', 'nav', 'store', 'transport', 'elm', 'obd', 'dtcdb', 'network', 'diag', 'ai', 'core', 'widgets', 'report', 'views-core', 'views-live', 'views-tools'].map(f => `car-tech/js/${f}.js`)];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname === 'api.anthropic.com') return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok && (u.origin === location.origin || /fonts\.(googleapis|gstatic)\.com/.test(u.hostname))) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request)));
});
