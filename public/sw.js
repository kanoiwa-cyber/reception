/* Service Worker
 * 方針:
 *  1. 画面・JSは「ネットワーク優先」。通信できる限り常に最新を表示し、圏外のときだけ前回の内容を出す
 *  2. APIレスポンスは一切キャッシュしない
 *  3. プッシュ通知の受信と、タップ時のアプリ起動
 * 更新時は下の CACHE_VERSION を上げると、古いキャッシュが自動で消える
 */
const CACHE_VERSION = 'v29'; // 職員番号0なし・PW数字4桁
const CACHE_NAME = `staff-notice-${CACHE_VERSION}`;
const OFFLINE_FALLBACK = ['/', '/index.html', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/img/logo_mark.png', '/img/logo_jp.png', '/img/logo_full.png', '/img/wave_main.png', '/img/wave_pink.png', '/img/wave_yellow.png', '/img/wave_salmon.png', '/img/wanko/face_circle.png', '/img/wanko/ganbaru.png', '/img/wanko/arigatou.png', '/img/wanko/makasete.png', '/img/wanko/tanoshii.png', '/img/wanko/mirai.png', '/img/wanko/main.jpg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_FALLBACK)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // APIはブラウザに直接任せる（no-store）

  // ネットワーク優先。成功したらキャッシュを更新、失敗したら前回のキャッシュ
  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined)))
  );
});

// ---- プッシュ通知の受信 --------------------------------------------------
self.addEventListener('push', (event) => {
  let data = { title: 'お知らせ', body: '新しいお知らせがあります', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag || 'notice',
      renotify: true,
      requireInteraction: !!data.urgent, // 緊急連絡・安否確認は、タップするまで消えない
      vibrate: data.urgent ? [300, 100, 300, 100, 300] : undefined,
      data: { url: data.url || '/' },
    })
  );
});

// 通知をタップしたら、開いている画面があればそれを前面に、なければ新しく開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate ? client.navigate(target) : null;
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// ブラウザ側で購読が更新されたとき、サーバーにも反映する
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    fetch('/api/push/public-key')
      .then((r) => r.json())
      .then(({ publicKey }) =>
        self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
      )
      .then((subscription) =>
        fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription }),
        })
      )
  );
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}