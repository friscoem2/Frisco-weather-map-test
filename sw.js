const AW_CACHE = 'aw-weather-shell-v5';
const AW_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/frisco/frisco-layers.js',
  './js/pwa.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(AW_CACHE)
      .then(cache => cache.addAll(AW_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key.startsWith('aw-weather-shell-') && key !== AW_CACHE)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Keep live radar, NWS, GIS, camera, basemap, and other external requests fresh.
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Network-first for local files so GitHub Pages updates show quickly.
  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(AW_CACHE).then(cache => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
  );
});
