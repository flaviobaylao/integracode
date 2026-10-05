// Integra 2.0 Service Worker
// Estratégia: Cache-first para assets, Network-first para API, offline fallback para navegação

const CACHE_VERSION = 'v26';
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

  // Dispara a rede SEM abortar por tempo. Uma resposta lenta (mobile/cold-start)
  // NÃO deve virar "offline" — só falha de rede real (fetch rejeitado) cai no fallback.
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  const cached = await cache.match(request);

  if (cached) {
    // Há cópia em cache: entrega rápido se a rede passar de timeoutMs (UX ágil),
    // mas ainda atualiza o cache em segundo plano quando a rede responder.
    const timeoutFallback = new Promise((resolve) =>
      setTimeout(() => resolve(cached), timeoutMs)
    );
    const winner = await Promise.race([networkPromise, timeoutFallback]);
    return winner || cached;
  }

  // Sem cache (1º acesso no aparelho): ESPERA a resposta real da rede.
  // É o caso da tela de venda no celular — a lista de produtos chegava a demorar
  // mais que 8s e o SW abortava, devolvendo 503 → "Nenhum produto disponível".
  const netResp = await networkPromise;
  if (netResp) return netResp;

  return new Response(JSON.stringify({ error: 'offline', cached: false }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
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

// ── Background Sync: fila de check-in offline (out/2026) ─────────────────────
// Android/Chrome envia a fila mesmo com o app FECHADO. iOS nao suporta: la o
// envio acontece com o app aberto (ver client/src/lib/offlineCheckins.ts).
const OFF_DB = 'integra-offline';
const OFF_STORE = 'checkin_queue';

function abrirFila() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFF_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFF_STORE)) db.createObjectStore(OFF_STORE, { keyPath: 'clientUuid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function filaTodos(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(OFF_STORE, 'readonly').objectStore(OFF_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function filaRemover(db, uuid) {
  return new Promise((resolve) => {
    const req = db.transaction(OFF_STORE, 'readwrite').objectStore(OFF_STORE).delete(uuid);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  });
}

async function enviarFilaCheckins() {
  const db = await abrirFila();
  const itens = await filaTodos(db);
  for (const item of itens) {
    if (Date.now() - (item.criadoEm || 0) > 48 * 60 * 60 * 1000) continue; // expirado
    const fd = new FormData();
    if (item.photo) fd.append('photo', item.photo, 'checkin.jpg');
    if (item.lat !== null && item.lat !== undefined) fd.append('latitude', String(item.lat));
    if (item.lng !== null && item.lng !== undefined) fd.append('longitude', String(item.lng));
    if (item.accuracyM !== null && item.accuracyM !== undefined) fd.append('accuracy', String(item.accuracyM));
    if (item.notes) fd.append('notes', item.notes);
    fd.append('clientUuid', item.clientUuid);
    fd.append('deviceTime', item.deviceTime);
    fd.append('source', 'offline');
    const r = await fetch('/api/sales-cards/' + item.cardId + '/check-in', { method: 'POST', credentials: 'include', body: fd });
    if (r.ok || r.status === 409 || r.status === 422) await filaRemover(db, item.clientUuid);
    else if (r.status >= 500) throw new Error('servidor indisponivel'); // reagenda
  }
  db.close();
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'checkin-sync') event.waitUntil(enviarFilaCheckins());
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'checkin-periodic') event.waitUntil(enviarFilaCheckins().catch(() => {}));
});
