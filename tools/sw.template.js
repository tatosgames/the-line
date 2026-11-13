// The service worker, filled in by tools/pwa.ts at build time. It precaches the game
// and fetches new versions in the background for the next time the game is opened.

const CACHE = 'the-line-__VERSION__';
const FILES = __FILES__;
const OPTIONAL_SOUNDS = new Set(__OPTIONAL_SOUNDS__.map((path) => new URL(path, self.registration.scope).href));
/** The title font comes from here. Kept as it is used, since it can't be listed in advance. */
const FONTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('the-line-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const font = FONTS.includes(url.origin);
  if (url.origin !== location.origin && !font) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: !font }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then(async (res) => {
        if ((font && res.type === 'opaque') || (res.ok && (font || OPTIONAL_SOUNDS.has(url.href)))) {
          try { await (await caches.open(CACHE)).put(e.request, res.clone()); } catch { /* Keep serving the response if the cache is full. */ }
        }
        return res;
      });
    }),
  );
});
