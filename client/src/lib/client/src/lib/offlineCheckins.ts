// ============================================================================
// INTEGRA 2.0 — FILA DE CHECK-IN OFFLINE (out/2026)
// Regra de km: sem check-in, sem km. Esta fila existe para que FALTA DE REDE
// nunca vire falta de check-in — o GPS do aparelho funciona sem internet, entao
// o check-in e gravado no proprio celular e sobe sozinho quando a conexao volta.
//
// Android: o envio tambem acontece em segundo plano (Background Sync, registrado
// no sw.js). iOS/Safari NAO tem Background Sync — la o envio e oportunista, nos
// gatilhos online/visibilitychange/focus/pageshow e num timer enquanto a tela
// esta visivel. Por isso a tela avisa quando ha pendencia.
//
// Idempotencia: cada check-in nasce com um clientUuid; reenviar o mesmo uuid NAO
// duplica no servidor. Ver ESPEC_Checkin_Offline_iOS_Android.md.
// ============================================================================

const DB_NAME = 'integra-offline';
const DB_VERSION = 1;
const STORE = 'checkin_queue';
const MAX_IDADE_MS = 48 * 60 * 60 * 1000; // 48h: depois disso exige justificativa

export type CheckinPendente = {
  clientUuid: string;
  cardId: string;
  customerId?: string | null;
  customerNome?: string | null;
  deviceTime: string;      // ISO com offset, relogio do aparelho
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  notes: string;
  photo: Blob | null;
  tentativas: number;
  ultimoErro: string | null;
  criadoEm: number;
};

function abrirDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'clientUuid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function comStore<T>(modo: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await abrirDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, modo);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export function novoUuid(): string {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch { /* fallback */ }
  return 'cu-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export async function enfileirar(item: Omit<CheckinPendente, 'tentativas' | 'ultimoErro' | 'criadoEm'>): Promise<void> {
  const reg: CheckinPendente = { ...item, tentativas: 0, ultimoErro: null, criadoEm: Date.now() };
  await comStore('readwrite', (s) => s.put(reg));
  avisar();
  // Android: pede o envio em segundo plano. Em iOS isso simplesmente nao existe.
  try {
    const sw = await navigator.serviceWorker?.ready;
    if (sw && 'sync' in sw) await (sw as any).sync.register('checkin-sync');
  } catch { /* sem background sync: o flush oportunista resolve */ }
}

export async function listar(): Promise<CheckinPendente[]> {
  try { return (await comStore<CheckinPendente[]>('readonly', (s) => s.getAll())) || []; } catch { return []; }
}

export async function contar(): Promise<number> {
  try { return (await listar()).length; } catch { return 0; }
}

async function remover(uuid: string) {
  try { await comStore('readwrite', (s) => s.delete(uuid)); } catch { /* ignora */ }
}

async function marcarErro(item: CheckinPendente, erro: string) {
  try { await comStore('readwrite', (s) => s.put({ ...item, tentativas: item.tentativas + 1, ultimoErro: erro })); } catch { /* ignora */ }
}

// Pendencias com mais de 48h: param de tentar (viram caso de justificativa).
export function expirado(item: CheckinPendente): boolean {
  return Date.now() - item.criadoEm > MAX_IDADE_MS;
}

let enviando = false;

/** Envia tudo que esta na fila. Seguro chamar a qualquer momento. */
export async function enviarPendentes(): Promise<{ enviados: number; restantes: number }> {
  if (enviando || !navigator.onLine) return { enviados: 0, restantes: await contar() };
  enviando = true;
  let enviados = 0;
  try {
    const fila = await listar();
    for (const item of fila) {
      if (expirado(item)) continue;
      try {
        const fd = new FormData();
        if (item.photo) fd.append('photo', item.photo, 'checkin.jpg');
        if (item.lat !== null && item.lng !== null) {
          fd.append('latitude', String(item.lat));
          fd.append('longitude', String(item.lng));
        }
        if (item.accuracyM !== null) fd.append('accuracy', String(item.accuracyM));
        if (item.notes) fd.append('notes', item.notes);
        fd.append('clientUuid', item.clientUuid);
        fd.append('deviceTime', item.deviceTime);
        fd.append('source', 'offline');
        const r = await fetch(`/api/sales-cards/${item.cardId}/check-in`, { method: 'POST', credentials: 'include', body: fd });
        // 2xx = aceito. 409/422 = o servidor ja tem este check-in (idempotencia) ou
        // recusou por regra de negocio: sair da fila evita reenvio eterno.
        if (r.ok || r.status === 409 || r.status === 422) { await remover(item.clientUuid); enviados++; }
        else if (r.status >= 500) { await marcarErro(item, 'servidor ' + r.status); }
        else { await marcarErro(item, 'http ' + r.status); }
      } catch (e: any) {
        await marcarErro(item, String(e?.message || 'rede'));
        break; // rede caiu de novo: para e tenta no proximo gatilho
      }
    }
  } finally {
    enviando = false;
    avisar();
  }
  return { enviados, restantes: await contar() };
}

// ── aviso para a interface ──────────────────────────────────────────────────
const ouvintes = new Set<(n: number) => void>();
export function assinarPendencias(fn: (n: number) => void): () => void {
  ouvintes.add(fn);
  contar().then(fn).catch(() => fn(0));
  return () => { ouvintes.delete(fn); };
}
async function avisar() {
  const n = await contar();
  ouvintes.forEach((fn) => { try { fn(n); } catch { /* ignora */ } });
}

// ── gatilhos de envio ───────────────────────────────────────────────────────
// iOS depende inteiramente destes: sem app aberto, nao ha envio.
let iniciado = false;
export function iniciarFilaCheckins() {
  if (iniciado || typeof window === 'undefined') return;
  iniciado = true;
  try { navigator.storage?.persist?.(); } catch { /* opcional */ }
  const tentar = () => { enviarPendentes().catch(() => {}); };
  window.addEventListener('online', tentar);
  window.addEventListener('focus', tentar);
  window.addEventListener('pageshow', tentar);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tentar(); });
  setInterval(() => { if (document.visibilityState === 'visible') tentar(); }, 30_000);
  tentar();
}
