"use strict";

const CACHE_NAME = 'file-publisher-v2';
// This Cache Storage belongs to the managed video's presentation layer, not
// to the service worker's versioned static assets. Activation must preserve it.
const VIDEO_PREVIEW_CACHE_NAME = 'cividge-video-previews-v1';
const urlsToCache = [];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(urlsToCache.map(url => cache.add(url).catch(err => console.warn(`Failed to cache ${url}:`, err)))))
  );
});

self.addEventListener('activate', (event) => {
  // 古いキャッシュをクリーンアップしてv2へ移行する
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== VIDEO_PREVIEW_CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. 画面遷移（navigate）や API リクエストの場合は、キャッシュを使用せずネットワークを優先（Network Only）する。
  // これにより、Cloudflare Access のセッション切れ時に通常リロードでも自動的にログイン画面へリダイレクトされるようになります。
  if (event.request.mode === 'navigate' || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        if (url.pathname.startsWith('/api/')) {
          return new Response(JSON.stringify({ error: 'ネットワーク接続がありません。' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        // ネットワークがオフラインの時、万が一キャッシュがあれば画面のロードを試みる
        return caches.match(event.request);
      })
    );
  } else {
    // 2. それ以外の静的アセット（JS, CSS, WASM, 画像など）は、キャッシュを優先（Cache First）する
    event.respondWith(caches.match(event.request).then((response) => response || fetch(event.request)));
  }
});
