// Service worker : appli utilisable hors ligne + cache des images de cartes
const VERSION = 'holovault-v7';
const SHELL = [
  './', './index.html', './css/styles.css', './manifest.webmanifest',
  './js/app.js', './js/api.js', './js/db.js', './js/i18n.js', './js/icons.js', './js/charts.js', './js/scanner.js', './js/match.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];
const IMG_CACHE = 'holovault-img-v2';
const IMG_MAX = 2500; // nombre max d'images gardées
// Hôtes qui autorisent le CORS : on les télécharge en mode « cors » pour obtenir une réponse lisible.
// (Une réponse « opaque » compte pour ~7 Mo dans le quota du navigateur : quelques centaines
//  de miniatures suffisaient à saturer le stockage et à ralentir tout le téléphone.)
const CORS_HOSTS = ['assets.tcgdex.net', 'cards.scryfall.io', 'svgs.scryfall.io', 'fonts.gstatic.com', 'fonts.googleapis.com', 'cdn.jsdelivr.net'];
const OTHER_IMG_HOSTS = ['images.ygoprodeck.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // supprime les anciens caches, dont l'ancien cache d'images rempli de réponses opaques
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== IMG_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

let puts = 0;
async function trim() {
  const cache = await caches.open(IMG_CACHE);
  const keys = await cache.keys();
  if (keys.length > IMG_MAX) await Promise.all(keys.slice(0, keys.length - IMG_MAX).map(k => cache.delete(k)));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fichiers de l'appli : réponse immédiate depuis le cache, mise à jour en arrière-plan
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req, { ignoreSearch: true });
      const update = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
      if (hit) { e.waitUntil(update.catch(() => {})); return hit; }
      return update.catch(() => cache.match('./index.html'));
    })());
    return;
  }

  const cors = CORS_HOSTS.includes(url.hostname);
  if (!cors && !OTHER_IMG_HOSTS.includes(url.hostname)) return; // APIs de prix : toujours le réseau

  // Images de cartes, polices et moteur OCR : cache d'abord
  e.respondWith((async () => {
    const cache = await caches.open(IMG_CACHE);
    const hit = await cache.match(req.url);
    if (hit) return hit;
    let res;
    if (cors) {
      try { res = await fetch(req.url, { mode: 'cors', credentials: 'omit' }); } catch { res = null; }
    }
    if (!res) res = await fetch(req);
    if (res.ok && res.type !== 'opaque') { // jamais de réponse opaque en cache
      cache.put(req.url, res.clone());
      if (++puts % 200 === 0) e.waitUntil(trim());
    }
    return res;
  })());
});
