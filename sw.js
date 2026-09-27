const VERSION = 'floe-v3';
const CORE = [
  './',
  './index.html',
  './demo.html',
  './manifest.webmanifest',
  './css/app.css',
  './vendor/fontawesome/css/all.min.css',
  './vendor/xlsx.full.min.js',
  './vendor/alasql.min.js',
  './js/util.js',
  './js/expr.js',
  './js/io.js',
  './js/steps.js',
  './js/engine.js',
  './js/host.js',
  './js/worker.js',
  './js/platform.js',
  './js/native-engine.js',
  './js/ui/core.js',
  './js/ui/grid.js',
  './js/ui/formula-editor.js',
  './js/ui/step-dialogs.js',
  './js/ui/dialogs.js',
  './js/ui/app.js',
  './images/floe-mark.svg',
  './images/floe-icon.svg',
  './fonts/instrument-sans.woff2',
  './fonts/source-serif-4.woff2',
  './fonts/jetbrains-mono.woff2',
  './vendor/fontawesome/webfonts/fa-solid-900.woff2',
  './vendor/fontawesome/webfonts/fa-brands-400.woff2',
  './vendor/fontawesome/webfonts/fa-regular-400.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(CORE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const longLived = (url) => /\/(vendor|fonts|images)\//.test(url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (longLived(url)) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  e.respondWith(fetch(req).then((r) => {
    if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return r;
  }).catch(async () => {
    const c = await caches.open(VERSION);
    return (await c.match(req, { ignoreSearch: req.mode === 'navigate' })) || (req.mode === 'navigate' ? c.match('./index.html') : Response.error());
  }));
});
