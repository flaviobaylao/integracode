// Service Worker para PWA - Sistema Integra
const CACHE_NAME = 'integra-v3-2025-10-28';
const urlsToCache = [
  '/manifest.json'
];

// Instalar e limpar caches antigos
self.addEventListener('install', (event) => {
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
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Estratégia: Network First (sempre tenta buscar do servidor primeiro)
self.addEventListener('fetch', (event) => {
  // NÃO INTERFERIR com requisições que não são GET
  // Deixa passar direto para o servidor sem cache
  if (event.request.method !== 'GET') {
    // Não faz nada, deixa a requisição passar normalmente
    return;
  }

  // Não cacheia requisições de API (para evitar dados desatualizados)
  if (event.request.url.includes('/api/')) {
    // Sempre busca do servidor, sem cache
    event.respondWith(fetch(event.request));
    return;
  }

  // Para outras requisições GET (assets estáticos), usa Network First
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Se conseguiu do servidor, salva no cache e retorna
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Se falhou (offline), tenta buscar do cache
        return caches.match(event.request);
      })
  );
});
