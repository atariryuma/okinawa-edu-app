// 沖縄県 教育法規アプリ — Service Worker（オフライン対応）
const CACHE = 'okinawa-edu-v13';
const ASSETS = ['./', './index.html', './questions.json', './privacy.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // 同一オリジンの GET のみキャッシュ対象。Google API 等の外部はそのままネットワークへ。
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => {
      // オフライン時のフォールバックはページ遷移(ナビゲーション)のみ index.html を返す。
      // questions.json 等のデータ取得失敗時に HTML を返さない（boot() の JSON パース誤動作を防ぐ）。
      if (req.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    }))
  );
});
