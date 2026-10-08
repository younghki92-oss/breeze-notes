// Offline shell. Online: always load the latest files (so old and new files never mix), falling back to
// the cache if the network is slow or gone. Offline: served entirely from the cache.
const CACHE = 'breeze-v20';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const NET_TIMEOUT = 2500;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips GitHub Pages' 10-minute HTTP cache, so a new version never stores stale files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  // 같은 사이트(younghki92-oss.github.io)의 다른 앱 저장분은 건드리지 않고, 이 앱의 옛 버전만 지움
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('breeze-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  // Android share sheet → "Breeze 노트": keep what was shared, then open the app to turn it into a note
  if (e.request.method === 'POST' && new URL(e.request.url).pathname.endsWith('/share')) {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const item = { at: Date.now(), title: fd.get('title') || '', text: fd.get('text') || '', url: fd.get('url') || '', files: fd.getAll('files').filter((f) => f && f.size) };
      await inboxPut(item);
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
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

// Shared items wait here until the app picks them up (a separate database, so the app's own schema is untouched).
function inboxPut(item) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('breeze-inbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { autoIncrement: true });
    r.onsuccess = () => { const t = r.result.transaction('items', 'readwrite'); t.objectStore('items').add(item); t.oncomplete = resolve; t.onerror = () => reject(t.error); };
    r.onerror = () => reject(r.error);
  });
}
