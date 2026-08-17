const CACHE_VERSION = 'v1.0.2';
const CACHE_NAME = `wage-workbench-${CACHE_VERSION}`;
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/db.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon-180.png',
  './icons/startup-320x568.png',
  './icons/startup-750x1334.png',
  './icons/startup-1125x2436.png',
  './icons/startup-1170x2532.png',
  './icons/startup-1290x2796.png',
  './icons/startup-1206x2622.png',
  './icons/startup-1320x2868.png',
  'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;500;600;700;800&display=swap'
];

// Install: precache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use addAll but tolerate font CDN failure (offline-first, fonts are progressive enhancement)
      return Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[SW] Precache skip: ${url}`, err.message);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: cache-first, fallback to network, offline fallback to cached index.html
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET
  if (request.method !== 'GET') return;

  // Skip non-http(s) requests (e.g. chrome-extension)
  if (!request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          // Cache successful responses for future offline use
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Navigation fallback to cached index.html (SPA offline shell)
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          // Font CDN fallback: return empty
          return new Response('', { status: 504 });
        });
    })
  );
});

// Handle messages from page (e.g. skipWaiting trigger)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
