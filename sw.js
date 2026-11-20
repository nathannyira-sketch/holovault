// Service worker : appli utilisable hors ligne + cache des images de cartes
const VERSION = 'holovault-v2';
const SHELL = [
  './', './index.html', './css/styles.css', './manifest.webmanifest',
  './js/app.js', './js/api.js', './js/db.js', './js/i18n.js', './js/icons.js', './js/charts.js', './js/scanner.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];
const IMG_CACHE = 'holovault-img';
const IMG_HOSTS = ['assets.tcgdex.net', 'cards.scryfall.io', 'images.ygoprodeck.com', 'fonts.gstatic.com', 'fonts.googleapis.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== IMG_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fichiers de l'appli : réseau d'abord (mises à jour), cache si hors ligne
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
    return;
  }

  // Images de cartes, polices et moteur OCR : cache d'abord
  if (IMG_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(IMG_CACHE).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
  }
  // APIs de prix : toujours le réseau (pas de cache)
});
