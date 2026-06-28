/* Triple service worker.
 * NETWORK-FIRST by design: every load fetches fresh from the network, so a new
 * index.html paste-deploy shows up immediately with no stale-cache trap. The
 * cache is only a fallback for when the device is offline. Cross-origin requests
 * (Supabase, Google Fonts, jsDelivr CDN) are not intercepted at all.
 * Bump CACHE_VERSION any time you want to wipe old offline copies. */
const CACHE_VERSION = 'portal-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  // Only manage same-origin GETs; let everything else (API, fonts, CDN) pass through.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Stash a copy for offline use.
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      // Offline: serve the cached copy if we have one.
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const root = await caches.match('/');
        if (root) return root;
      }
      throw err;
    }
  })());
});
