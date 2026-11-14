// Vispecta service worker: makes the app work offline and start quickly.
// - The page itself (navigation requests) is fetched from the network first, so a new version is
//   picked up at once; the cached copy is used when offline.
// - Build assets have content hashes in their names and never change, so they are served from the
//   cache first. Other same-origin files (icons, manifest) use stale-while-revalidate.
// - Requests to other origins (map tiles, Pyodide, Python wheels) are not touched.
// IFC files are opened locally and never pass through here.
const CACHE = 'vispecta-v2'; // v2: other pages (about, 404) are no longer stored as the app page

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './manifest.webmanifest', './icons/icon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  // only the app itself is the cached "./" page; other pages (the about page) are cached under their own URL
  const scope = new URL(self.registration.scope).pathname;
  const path = new URL(req.url).pathname;
  const isApp = path === scope || path === `${scope}index.html`;
  try {
    const res = await fetch(req);
    if (res.ok && isApp) {
      const old = await cache.match('./');
      const html = await res.clone().text();
      if (old && (await old.text()) !== html) await pruneAssets(cache, html);
      await cache.put('./', res.clone());
    } else if (res.ok) {
      await cache.put(req, res.clone());
    }
    return res;
  } catch {
    return (isApp ? await cache.match('./') : await cache.match(req, { ignoreSearch: true })) || (await cache.match('./')) || Response.error();
  }
}

/** A new version was published: drop cached build assets the new page does not reference.
 * (Files loaded from scripts, like the wasm, are simply fetched and cached again when used.) */
async function pruneAssets(cache, html) {
  for (const r of await cache.keys()) {
    const path = new URL(r.url).pathname;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (path.includes('/assets/') && !html.includes(name)) await cache.delete(r);
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || update;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') event.respondWith(networkFirst(req));
  else if (url.pathname.includes('/assets/')) event.respondWith(cacheFirst(req));
  else event.respondWith(staleWhileRevalidate(req));
});
