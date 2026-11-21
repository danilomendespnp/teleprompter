/* Service worker do Teleprompter.
 * - HTML, CSS, JS e manifest: rede primeiro (com tempo-limite), cache como reserva offline.
 *   Assim o usuário nunca fica preso numa versão velha quando há internet.
 * - Ícones: cache primeiro, atualizando em segundo plano.
 * Ao publicar uma versão nova, aumente VERSION para limpar o cache antigo. */
'use strict';

const VERSION = '1.0.0';
const CACHE = 'teleprompter-v' + VERSION;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('teleprompter-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, './index.html'));
    return;
  }
  if (/\.(png|ico|svg)$/i.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, req));
    return;
  }
  event.respondWith(networkFirst(req));
});

function putInCache(cache, req, res) {
  if (res && res.ok && res.type === 'basic') {
    return cache.put(req, res.clone()).catch(() => {});
  }
  return Promise.resolve();
}

async function networkFirst(req, fallbackUrl) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then((res) => { putInCache(cache, req, res); return res; });
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS); });
  try {
    const res = await Promise.race([net, timeout]);
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    const hit = (await cache.match(req, { ignoreSearch: true })) ||
      (fallbackUrl ? await cache.match(fallbackUrl) : undefined);
    if (hit) return hit;
    return net; // sem cache: espera a rede (ou falha de verdade)
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => { putInCache(cache, req, res); return res; });
  if (hit) {
    event.waitUntil(net.catch(() => {}));
    return hit;
  }
  return net;
}
