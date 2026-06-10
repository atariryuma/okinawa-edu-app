// 沖縄県 教育法規アプリ — Service Worker（オフライン対応）
const CACHE = 'okinawa-edu-v105';
const ASSETS = ['./', './index.html', './questions.json', './privacy.html', './about.html', './terms.html', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  // cache:'reload' でブラウザHTTPキャッシュをバイパスし、デプロイ直後に必ず「最新実体」をプリキャッシュする。
  // （GitHub Pages の max-age により古い index.html / questions.json を焼き直す事故を防ぐ）
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
  // 自動 skipWaiting はしない：更新の適用はページ側の通知→ユーザー操作で行う（旧HTML＋新データの世代ズレ防止）。
});

// ページから「更新を今すぐ適用」と指示されたら待機を解除（待機中の新SWが activate される）。
self.addEventListener('message', e => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // 同一オリジンの GET のみ扱う。Google API 等の外部はそのままネットワークへ（素通し）。
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(req);
    // stale-while-revalidate：キャッシュを即返しつつ、裏でネットワーク取得してキャッシュを更新する。
    // → 次回起動で新版が反映され、CACHE バンプを忘れても questions.json 等のデータ更新に追従できる。
    const net = fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => {
      // オフライン時のフォールバックはページ遷移(ナビゲーション)のみ index.html を返す。
      // questions.json 等のデータ取得失敗時に HTML を返さない（boot() の JSON パース誤動作を防ぐ）。
      if (req.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    });
    // キャッシュヒットで即応答した後も、裏の再取得→cache.put が完了するまでSWを延命する
    // （waitUntil なしだと応答直後にSWが終了し、その回の更新が反映されないことがある）
    e.waitUntil(net.then(() => {}).catch(() => {}));
    return hit || net;
  })());
});
