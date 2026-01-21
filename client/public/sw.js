// Service Worker para PWA - Sistema Integra
const CACHE_NAME = 'integra-v17-stable';
const urlsToCache = [
  '/manifest.json'
];

// Flag para evitar logs repetitivos
let isInstalled = false;

// Instalar
self.addEventListener('install', (event) => {
  if (!isInstalled) {
    console.log('[SW] Instalando versão:', CACHE_NAME);
    isInstalled = true;
  }
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

// Ativar e limpar caches antigos
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

// Estratégia: Network First - NUNCA cacheia navegação ou HTML/JS
self.addEventListener('fetch', (event) => {
  // NÃO INTERFERIR com requisições que não são GET
  if (event.request.method !== 'GET') {
    return;
  }

  const url = event.request.url;
  const isNavigationRequest = event.request.mode === 'navigate';
  const isHTMLRequest = event.request.headers.get('accept')?.includes('text/html');
  const isScriptRequest = event.request.destination === 'script' || 
                          event.request.headers.get('accept')?.includes('javascript') ||
                          url.includes('/src/') || // Vite dev modules
                          url.endsWith('.js') || 
                          url.endsWith('.jsx') || 
                          url.endsWith('.ts') || 
                          url.endsWith('.tsx');
  
  // NUNCA cacheia: Navegação, API, HTML, ou JavaScript (incluindo módulos Vite /src/)
  if (isNavigationRequest || 
      isHTMLRequest ||
      isScriptRequest ||
      url.includes('/api/') || 
      url.endsWith('.html')) {
    // Sempre busca do servidor, SEM CACHE
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => {
        // Se offline e for navegação, retorna index.html do cache
        if (isNavigationRequest || isHTMLRequest) {
          return caches.match('/index.html').then(response => {
            return response || new Response('Offline - Recarregue quando online', { 
              status: 503,
              headers: { 'Content-Type': 'text/html' }
            });
          });
        }
        // Para outros, retorna erro
        return new Response('Offline', { 
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      })
    );
    return;
  }

  // Para CSS, imagens, fontes: usa Network First com cache
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
