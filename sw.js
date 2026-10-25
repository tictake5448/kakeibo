/* オフラインで開けるようにするための Service Worker。
   アプリ本体はネット接続があれば最新を取得し、つながらないときは保存済みを使う。
   文字認識の部品（vendor/）は大きいので、初回に1度だけ保存して以後はそのまま使う。 */
const VERSION = 'kakeibo-app-v1.4.0';
const OCR_CACHE = 'kakeibo-ocr-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'ocr-worker.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== OCR_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.includes('/vendor/')) {
    e.respondWith((async () => {
      const cache = await caches.open(OCR_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  e.respondWith((async () => {
    try {
      const res = await withTimeout(fetch(req, {cache: 'no-cache'}), 4000);   // 配信元の10分キャッシュに頼らず、毎回新しさを確認する
      if (res.ok) { const c = await caches.open(VERSION); c.put(req, res.clone()); }
      return res;
    } catch (err) {
      const hit = await caches.match(req, {ignoreSearch: true});
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await caches.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
