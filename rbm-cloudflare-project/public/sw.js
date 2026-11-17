/*
 * EXPHONE VIP MEMBER — PWA service worker
 * Cache only the public application shell and static assets.
 * Member cards, admin pages, QR tokens and API responses are never cached.
 */
const CACHE_NAME = 'exphone-hero-responsive-blue-20261117-v14';
const APP_SHELL = [
  '/',
  '/?source=pwa',
  '/manifest.webmanifest',
  '/styles.css?v=exp-responsive-20261116-v2',
  '/electric-editorial.css?v=exp-responsive-20261116-v2',
  '/exphone-refinements.css?v=exp-refine-20261116-v4',
  '/assets/logo-exphone-exp.svg',
  '/assets/logo-exphone-white.svg',
  '/app.js?v=exp-history-spa-20261117-v7',
  '/exp-responsive-fix.css?v=exp-responsive-20261116-v2',
  '/hero-floating-visual.css?v=exp-hero-20261116-v2',
  '/mobile-stability.css?v=exp-mobile-20261116-v2',
  '/home-access-polish.css?v=exp-home-access-20261117-v2',
  '/site-final-fixes.css?v=exp-hero-responsive-blue-20261117-v14',
  '/icons/icon-192-cobalt.png',
  '/icons/icon-512-cobalt.png',
  '/icons/icon-512-maskable-cobalt.png',
  '/icons/apple-touch-icon-cobalt.png',
  '/icons/favicon-cobalt.png',
  '/icons/exphone-electric.svg'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) { return cache.addAll(APP_SHELL); })
      .then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(keys.map(function(key) {
          if (key.startsWith('exphone-') && key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return Promise.resolve(false);
        }));
      })
      .then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API traffic, card URLs, login, registration, or admin pages.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    const queryKeys = Array.from(url.searchParams.keys());
    const isPublicHome = url.pathname === '/' &&
      queryKeys.every(function(key) { return key === 'source'; });

    if (!isPublicHome) return;

    event.respondWith(
      fetch(request)
        .then(function(response) {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put('/?source=pwa', copy);
            });
          }
          return response;
        })
        .catch(async function() {
          return (await caches.match('/?source=pwa')) ||
            (await caches.match('/')) ||
            Response.error();
        })
    );
    return;
  }

  // Cache-first for same-origin static files, with a network update in background.
  if (/\.(?:css|js|png|webmanifest|svg|ico)$/i.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async function(cache) {
        const cached = await cache.match(request);
        const networkRequest = fetch(request).then(function(response) {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        }).catch(function() {
          return cached || Response.error();
        });
        return cached || networkRequest;
      })
    );
  }
});
