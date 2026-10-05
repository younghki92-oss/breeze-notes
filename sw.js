// Offline shell. Online: always load the latest files (so old and new files never mix), falling back to
// the cache if the network is slow or gone. Offline: served entirely from the cache.
const CACHE = 'breeze-v13';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const NET_TIMEOUT = 2500;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips GitHub Pages' 10-minute HTTP cache, so a new version never stores stale files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.hostname === 'cdn.jsdelivr.net') { // versioned library files: cache first
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      return hit || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    }));
    return;
  }
  if (u.origin !== location.origin) return; // Supabase API goes straight to network
  // every page (including ?note=… windows) is the same index.html
  const key = e.request.mode === 'navigate' ? './' : u.pathname.endsWith('/') ? './' : e.request;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    try {
      const r = await Promise.race([
        fetch(e.request, { cache: 'no-cache' }),
        new Promise((_, reject) => setTimeout(reject, NET_TIMEOUT)),
      ]);
      if (!r.ok) throw new Error(r.status);
      c.put(key, r.clone());
      return r;
    } catch {
      return (await c.match(key, { ignoreSearch: true })) || Response.error();
    }
  }));
});
