// Offline shell. Deliberately conservative: the site's whole value is that its numbers are current,
// so pages are served network-first and the cache is only a fallback for a lost connection. Only the
// data files the calculators need are cached ahead of time, and every cached response carries the
// date it was stored so a stale page can say so rather than pretend.
const V = 'dpi-v1';
const PRECACHE = ['/', '/value/', '/tools/', '/credit/'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r).then(res => {
      if (res && res.status === 200) { const copy = res.clone(); caches.open(V).then(c => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match(r).then(hit => hit || caches.match('/')))
  );
});
