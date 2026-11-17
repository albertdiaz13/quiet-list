// Offline shell for the installed app. Caches only the app's own static files; never
// requests to /api, /oauth or /mcp, so no list data or sign-in traffic is stored here.
const CACHE = 'quiet-list-shell-v4';
const SHELL = ['./', 'style.css', 'app.js', 'model.js', 'store.js', 'sync.js', 'sound.js', 'manifest.webmanifest',
  'fonts/bricolage-grotesque-latin.woff2', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|oauth|mcp|\.well-known)(\/|$)/.test(url.pathname)) return;
  // Network first so a new version shows up at once; the cache answers when offline.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(event.request);
      if (fresh.ok) cache.put(event.request, fresh.clone());
      return fresh;
    } catch {
      return (await cache.match(event.request, { ignoreSearch: true })) || (event.request.mode === 'navigate' ? cache.match('./') : Response.error());
    }
  })());
});
