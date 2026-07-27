const CACHE = 'mysyncnote-v27';
const SHELL = [
  './', './index.html', './styles.css?v=27', './manifest.webmanifest', './icon.svg',
  './js/app.js?v=27', './js/storage.js?v=19', './js/markdown.js', './js/live-editor.js', './js/graph.js', './js/canvas.js?v=17', './js/timeline.js?v=24', './js/timeline-daw.js?v=27'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const network = fetch(event.request);
  event.waitUntil(network.then(async response => {
    if (!response.ok) return;
    const copy = response.clone();
    const cache = await caches.open(CACHE);
    await cache.put(event.request, copy);
  }).catch(() => {}));
  event.respondWith(network.catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    if (event.request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    return new Response('離線且沒有可用的快取', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
