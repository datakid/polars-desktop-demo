const VERSION = 'floe-1.1.0-dev';
const SHARE_CACHE = 'floe-share';
const CORE = [
  './',
  './index.html',
  './demo.html',
  './manifest.webmanifest',
  './css/app.css',
  './vendor/fontawesome/css/all.min.css',
  './vendor/xlsx.full.min.js',
  './vendor/alasql.min.js',
  './vendor/arrow.es2015.min.js',
  './vendor/hyparquet.min.js',
  './vendor/hyparquet-compressors.min.js',
  './vendor/hyparquet-writer.min.js',
  './js/demo.js',
  './js/plan.js',
  './js/util.js',
  './js/storage.js',
  './js/expr.js',
  './js/io.js',
  './js/steps.js',
  './js/engine.js',
  './js/engine-ext.js',
  './js/host.js',
  './js/worker.js',
  './js/platform.js',
  './js/ui/core.js',
  './js/ui/grid.js',
  './js/ui/formula-editor.js',
  './js/ui/step-dialogs.js',
  './js/ui/dialogs.js',
  './js/ui/features.js',
  './js/ui/app.js',
  './images/floe-mark.svg',
  './images/floe-icon.svg',
  './images/floe-icon-maskable.svg',
  './images/floe-mark.jpg',
  './images/floe-icon.jpg',
  './images/floe-icon-maskable.jpg',
  './images/floe-icon-rounded.jpg',
  './fonts/instrument-sans.woff2',
  './fonts/source-serif-4.woff2',
  './fonts/jetbrains-mono.woff2',
  './vendor/fontawesome/webfonts/fa-solid-900.woff2',
  './vendor/fontawesome/webfonts/fa-brands-400.woff2',
  './vendor/fontawesome/webfonts/fa-regular-400.woff2',
  './vendor/fontawesome/webfonts/fa-v4compatibility.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(CORE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size);
    let i = 0;
    for (const f of files) {
      await cache.put(new Request('./__shared/' + Date.now() + '-' + (i++) + '/' + encodeURIComponent(f.name)), new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name) } }));
    }
    const text = form.get('text');
    if (!files.length && typeof text === 'string' && text.trim()) await cache.put(new Request('./__shared/' + Date.now() + '/pasted.txt'), new Response(text, { headers: { 'content-type': 'text/plain', 'x-name': 'pasted.txt', 'x-text': '1' } }));
  } catch (err) { }
  return Response.redirect('./index.html?shared=1', 303);
}

const longLived = (url) => /\/(vendor|fonts|images)\//.test(url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
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
