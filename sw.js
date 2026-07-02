/* KINGSTON Comptoir - Service Worker (installable iPad/borne + shell resilient).
   REGLE D'OR : ne met JAMAIS /api/ en cache (donnees toujours fraiches),
   ne met jamais les POST en cache (aucun risque de rejouer une vente).
   Ne fait PAS de vente hors-ligne (chantier back-end distinct).
   Doit etre servi a la racine (/sw.js) pour le scope "/". */

const CACHE = 'kt-shell-v1';   // incremente en v2, v3... a chaque deploiement du shell
const SHELL = ['/'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
                      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                             .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);

  if (req.method !== 'GET') return;                 // POST/PUT/DELETE -> toujours reseau
  if (url.pathname.indexOf('/api/') === 0) return;  // API -> toujours reseau, jamais de cache

  // Document / navigation -> reseau d'abord, cache en secours (hors-ligne)
  if (req.mode === 'navigate' || url.pathname === '/') {
    e.respondWith(
      fetch(req).then(function (r) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put('/', copy); });
        return r;
      }).catch(function () { return caches.match('/'); })
    );
    return;
  }

  // Ressources statiques (polices, images, css, js) -> cache d'abord, reseau en secours
  if (/\.(?:woff2?|ttf|otf|png|jpe?g|svg|webp|gif|ico|css|js)$/.test(url.pathname) ||
      url.host.indexOf('fonts.g') !== -1) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) {
          var copy = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return r;
        });
      })
    );
  }
});
