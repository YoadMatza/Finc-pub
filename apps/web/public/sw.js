/*
 * Minimal service worker: caches the app shell so the PWA opens instantly; API calls always go to the network.
 * The cache name carries the build (stamped by vite.config.ts), so a new build drops the old shell and assets.
 * Only an HTML page answer is kept as the shell: a download (the APK) or anything else is never stored as "/"
 * (security research P3-02).
 */
const SHELL = 'finc-shell-dev';
const isHtml = (r) => (r.headers.get('content-type') || '').toLowerCase().startsWith('text/html');
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/health') return;
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.open(SHELL).then(async (c) => (await c.match(e.request)) ?? fetch(e.request).then((r) => (r.ok && c.put(e.request, r.clone()), r))));
    return;
  }
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).then((r) => (r.ok && isHtml(r) && caches.open(SHELL).then((c) => c.put('/', r.clone())), r)).catch(() => caches.match('/')));
});
