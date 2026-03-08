const CACHE_NAME = 'integra-v21';

self.addEventListener('install', (event) => {
  console.log('[SW] Instalando versão:', CACHE_NAME);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  
  const url = event.request.url;
  
  if (event.request.mode === 'navigate' ||
      url.includes('/api/') ||
      url.endsWith('.html') ||
      url.endsWith('.js') ||
      url.endsWith('.jsx') ||
      url.endsWith('.ts') ||
      url.endsWith('.tsx') ||
      url.endsWith('.css')) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
