// Offline cache so the app keeps working courtside with a weak connection.
// Bump with each release so old caches are dropped.
const CACHE = 'stroke-match-v4';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/app.js', 'js/analysis.js', 'js/shotmodel.js', 'js/capture.js', 'js/demo.js', 'js/pose.js', 'js/shots.js', 'js/store.js', 'js/viewer.js',
  'vendor/tf-4.22.0.min.js',
];
// The pose models (5 MB and 12 MB) are cached the first time they're used.

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for the app code (so updates arrive), cache first for the
// large model files, which never change under the same name.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isModel = url.pathname.includes('/models/') || url.pathname.includes('/vendor/');
  if (isModel) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })));
    return;
  }
  // 'no-cache' checks with the server every time (cheap when unchanged), so
  // a new release shows on the next load instead of after the HTTP cache expires.
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
