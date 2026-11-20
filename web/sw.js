// Offline-Unterstützung: App-Dateien werden zwischengespeichert.
// Bei Änderungen an den Dateien VERSION erhöhen, damit alle Geräte die neue Fassung laden.
const VERSION = 'berichte-v9';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Netzwerk zuerst (damit Updates sofort ankommen), offline aus dem Zwischenspeicher
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    // cache: 'no-cache' → immer beim Server nachfragen, damit nie alte und neue Dateien gemischt werden
    fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then(hit => hit || (event.request.mode === 'navigate' ? caches.match('index.html') : undefined)))
      .then(r => r || Response.error())
  );
});
