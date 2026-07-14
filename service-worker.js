/* ============================================================
   ArboMap · service-worker.js
   ------------------------------------------------------------
   Estratégia de cache:
     - "App shell" (HTML/CSS/JS/ícones/bibliotecas CDN usadas):
       cache-first, com atualização em segundo plano (stale-while
       revalidate) — garante abertura instantânea mesmo offline.
     - Tiles de mapa (OSM/Esri/OpenTopoMap): cache-first também,
       para que áreas já visitadas fiquem disponíveis sem internet
       (os mapas carregados pelo próprio usuário, como GeoPDF/
       GeoTIFF/MBTiles, ficam em IndexedDB via offline.js, não aqui).
     - Requisições de API/dados dinâmicos: network-first com
       fallback para cache.
============================================================ */

const CACHE_VERSION = 'arbomap-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/map.js',
  './js/gps.js',
  './js/georef.js',
  './js/pdf.js',
  './js/drawing.js',
  './js/export.js',
  './js/offline.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const isTile = /tile\.(openstreetmap|opentopomap)\.org|arcgisonline\.com/.test(request.url);
  const isAppShellOrLib = APP_SHELL.some((path) => request.url.endsWith(path.replace('./', '/')))
    || request.url.includes('unpkg.com') || request.url.includes('jsdelivr.net') || request.url.includes('googleapis.com') || request.url.includes('gstatic.com');

  if (isTile || isAppShellOrLib) {
    // Cache-first: responde do cache imediatamente; atualiza em segundo plano.
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          if (response && response.status === 200) {
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        }).catch(() => cached);
        return cached || network;
      })
    );
  } else {
    // Network-first para o restante, com fallback ao cache quando offline.
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
  }
});
