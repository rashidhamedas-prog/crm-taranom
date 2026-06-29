// CRM ترنم - service worker: network-first for HTML, cache-first for assets
const CACHE = 'crm-taranom-v6';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.url.includes('/api/')) return;

  const isHTML = req.headers.get('accept')?.includes('text/html') ||
                 req.url.endsWith('/') || req.url.endsWith('.html');

  if (isHTML) {
    // Network-first for HTML: always get the latest app, fall back to cache offline
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            caches.open(CACHE).then((c) => c.put(req, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  } else {
    // Cache-first for static assets (images, icons, manifest)
    e.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            caches.open(CACHE).then((c) => c.put(req, res.clone()));
          }
          return res;
        });
      })
    );
  }
});
