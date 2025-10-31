// Service Worker para PWA - Sistema Integra
const CACHE_NAME = 'integra-v10-2025-10-31-nocache-headers';
const urlsToCache = [
  '/manifest.json'
];

// Instalar e FORÇAR atualização imediata
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando nova versão:', CACHE_NAME);
  self.skipWaiting(); // Força ativação imediata
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

// Ativar e APAGAR TODOS os caches antigos
self.addEventListener('activate', (event) => {
  console.log('[SW] Ativando e limpando caches antigos');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deletando cache antigo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Assumindo controle de todas as páginas');
      return self.clients.claim(); // Força controle imediato
    })
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
  
  // NUNCA cacheia: Navegação, API, HTML, ou JavaScript
  if (isNavigationRequest || 
      isHTMLRequest ||
      url.includes('/api/') || 
      url.endsWith('.html') || 
      (url.includes('/assets/') && url.endsWith('.js'))) {
    
    console.log('[SW] Bypass cache para:', url);
    
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
