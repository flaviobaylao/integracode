// Service Worker para PWA - Sistema Integra
const CACHE_NAME = 'integra-v6-2025-10-30-nocache';
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

// Estratégia: Network First - NUNCA cacheia HTML
self.addEventListener('fetch', (event) => {
  // NÃO INTERFERIR com requisições que não são GET
  if (event.request.method !== 'GET') {
    return;
  }

  // NUNCA cacheia: API, HTML, ou JavaScript
  const url = event.request.url;
  if (url.includes('/api/') || 
      url.endsWith('.html') || 
      url.endsWith('/') ||
      url.includes('/assets/') && url.endsWith('.js')) {
    // Sempre busca do servidor, SEM CACHE
    event.respondWith(
      fetch(event.request).catch(() => {
        // Se offline, retorna erro ao invés de cache
        return new Response('Offline - Recarregue quando online', { 
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
