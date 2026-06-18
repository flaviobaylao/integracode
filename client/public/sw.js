// Integra 2.0 Service Worker
// Estratégia: Cache-first para assets, Network-first para API, offline fallback para navegação

const CACHE_VERSION = 'v22';
const SHELL_CACHE  = `integra-shell-${CACHE_VERSION}`;
const API_CACHE    = `integra-api-${CACHE_VERSION}`;
const ALL_CACHES   = [SHELL_CACHE, API_CACHE];

// Assets do app shell que sempre devem estar em cache
const SHELL_ASSETS = ['/', '/index.html'];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando', CACHE_VERSION);
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[SW] Falha ao pré-cachear shell:', err))
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Ativando', CACHE_VERSION);
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => !ALL_CACHES.includes(name))
            .map((name) => {
              console.log('[SW] Deletando cache antigo:', name);
              return caches.delete(name);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Ignora requisições cross-origin
  if (url.origin !== self.location.origin) return;

  // API: Network-first com cache de curto prazo (5 min)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(event.request, API_CACHE, 8000));
    return;
  }

  // Assets estáticos compilados (Vite): Cache-first (hash no nome = imutável)
  if (url.pathname.match(/\.(js|css|woff2?|png|jpg|jpeg|svg|gif|webp|ico)$/)) {
    event.respondWith(cacheFirst(event.request, SHELL_CACHE));
    return;
  }

  // Navegação SPA: Network-first, fallback para /index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          return cached || caches.match('/index.html') || caches.match('/');
        })
    );
    return;
  }
});

// ── Estratégias de cache ──────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 503 });
  }
}

async function networkFirst(request, cacheName, timeoutMs = 5000) {
  const cache = await caches.open(cacheName);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    // Cacheia apenas respostas bem-sucedidas que não sejam muito grandes
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── Push notifications (futuro) ───────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Integra', {
      body: data.body || '',
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      data: data.url ? { url: data.url } : undefined,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.notification.data?.url) {
    event.waitUntil(clients.openWindow(event.notification.data.url));
  }
});
