const CACHE_NAME = 'integra-v18-stable';
const urlsToCache = [];

let isInstalled = false;

self.addEventListener('install', (event) => {
  if (!isInstalled) {
    console.log('[SW] Instalando versão:', CACHE_NAME);
    isInstalled = true;
  }
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = event.request.url;
  const isNavigationRequest = event.request.mode === 'navigate';
  const isHTMLRequest = event.request.headers.get('accept')?.includes('text/html');
  const isScriptRequest = event.request.destination === 'script' || 
                          event.request.headers.get('accept')?.includes('javascript') ||
                          url.includes('/src/') ||
                          url.endsWith('.js') || 
                          url.endsWith('.jsx') || 
                          url.endsWith('.ts') || 
                          url.endsWith('.tsx');
  
  if (isNavigationRequest || 
      isHTMLRequest ||
      isScriptRequest ||
      url.includes('/api/') || 
      url.endsWith('.html')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => {
        if (isNavigationRequest || isHTMLRequest) {
          return caches.match('/index.html').then(response => {
            return response || new Response('Offline - Recarregue quando online', { 
              status: 503,
              headers: { 'Content-Type': 'text/html' }
            });
          });
        }
        return new Response('Offline', { 
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
