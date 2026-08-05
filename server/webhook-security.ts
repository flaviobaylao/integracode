import { db } from './db';
import { sql } from 'drizzle-orm';

// FASE 1c - Validacao de webhooks por segredo compartilhado (modo suave).
// So EXIGE o token quando ele estiver configurado (env WEBHOOK_TOKEN ou
// system_settings chave 'webhook_token'). Sem token configurado, apenas
// registra alerta no log e deixa passar (evita quebrar notificacoes do BB
// antes de as URLs serem atualizadas com ?token=...).
let cache: { token: string | null; at: number } = { token: null, at: 0 };

async function getWebhookToken(): Promise<string | null> {
  const env = process.env.WEBHOOK_TOKEN;
  if (env && env.trim()) return env.trim();
  const now = Date.now();
  if (now - cache.at < 60000) return cache.token;
  try {
    const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='webhook_token' LIMIT 1"));
    const rows = r && r.rows ? r.rows : (Array.isArray(r) ? r : []);
    const v = rows[0] ? String(rows[0].value || '').trim() : '';
    cache = { token: v || null, at: now };
  } catch {
    cache = { token: null, at: now };
  }
  return cache.token;
}

// ---------------------------------------------------------------------------
// SENTINELA DO WEBHOOK — a caixa-preta da porta de entrada.
//
// POR QUE EXISTE: o log de payload (webhook_debug_log) so e escrito DEPOIS
// deste guard. Quando o guard RECUSA a chamada, ela nao deixa rastro nenhum —
// o sistema fica indistinguivel de "o BB parou de mandar". Foi esse ponto cego
// que escondeu um webhook rejeitado por token: o dinheiro entrava no extrato,
// o titulo nunca baixava, e nenhum alarme tocava porque, do lado de dentro,
// simplesmente nao havia o que olhar.
//
// A sentinela grava o DESFECHO de cada chamada (aceito / token invalido / sem
// token configurado) em system_settings.webhook_sentinela. NUNCA guarda o
// token recebido — so o tamanho e se veio por query ou header, o suficiente
// para separar "a URL cadastrada nao tem ?token=" de "o token esta errado".
//
// Escrita agregada em memoria e descarregada no banco no maximo a cada 15s:
// webhook em rajada nao pode virar uma escrita por chamada.
// ---------------------------------------------------------------------------
type Desfecho = 'aceito' | 'rejeitadoToken' | 'semConfig';
type Marca = { n: number; ultimo: string | null; detalhe?: string | null };

const CHAVE_SENTINELA = 'webhook_sentinela';
const inicioProcesso = new Date().toISOString();
let sentinela: Record<string, Partial<Record<Desfecho, Marca>>> = {};
let sentinelaCarregada = false;
let flushAgendado: NodeJS.Timeout | null = null;
let sujo = false;

async function carregarSentinela(): Promise<void> {
  if (sentinelaCarregada) return;
  sentinelaCarregada = true; // marca antes: se falhar, comeca do zero em vez de tentar a cada request
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${CHAVE_SENTINELA} LIMIT 1`);
    const rows = r && r.rows ? r.rows : (Array.isArray(r) ? r : []);
    if (rows[0] && rows[0].value) {
      const v = JSON.parse(String(rows[0].value));
      if (v && typeof v === 'object' && v.rotas) sentinela = v.rotas;
    }
  } catch { /* sentinela e diagnostico: nunca derruba o webhook */ }
}

async function descarregar(): Promise<void> {
  flushAgendado = null;
  if (!sujo) return;
  sujo = false;
  const corpo = JSON.stringify({ desde: inicioProcesso, atualizadoEm: new Date().toISOString(), rotas: sentinela });
  try {
    await db.execute(sql`
      INSERT INTO system_settings (key, value, updated_by)
      VALUES (${CHAVE_SENTINELA}, ${corpo}, 'webhook-security')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  } catch { /* idem */ }
}

function registrar(rota: string, desfecho: Desfecho, detalhe?: string): void {
  const r = (sentinela[rota] ||= {});
  const m = (r[desfecho] ||= { n: 0, ultimo: null });
  m.n += 1;
  m.ultimo = new Date().toISOString();
  if (detalhe !== undefined) m.detalhe = detalhe;
  sujo = true;
  if (!flushAgendado) {
    flushAgendado = setTimeout(() => { void descarregar(); }, 15000);
    if (typeof flushAgendado.unref === 'function') flushAgendado.unref();
  }
}

/** Leitura da sentinela para o painel de saude (somente leitura, sem efeito colateral). */
export async function lerSentinelaWebhook(): Promise<{ desde: string; atualizadoEm: string | null; rotas: Record<string, any> }> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${CHAVE_SENTINELA} LIMIT 1`);
    const rows = r && r.rows ? r.rows : (Array.isArray(r) ? r : []);
    if (rows[0] && rows[0].value) {
      const v = JSON.parse(String(rows[0].value));
      // o que esta em memoria pode ser mais novo que o ultimo flush
      return { desde: v.desde || inicioProcesso, atualizadoEm: v.atualizadoEm || null, rotas: sujo ? sentinela : (v.rotas || {}) };
    }
  } catch { /* segue com o que houver em memoria */ }
  return { desde: inicioProcesso, atualizadoEm: null, rotas: sentinela };
}

export async function webhookTokenGuard(req: any, res: any, next: any) {
  const rota = String(req.baseUrl || '') + String(req.path || req.originalUrl || '');
  try {
    await carregarSentinela();
    const expected = await getWebhookToken();
    if (!expected) {
      // FIX: aceitar sem validacao quando o token some deixa qualquer POST anonimo
      // liquidar boleto e dar baixa. O token esta configurado em producao, entao
      // falhar FECHADO e seguro: se ele sumir, o webhook para (e o problema fica
      // visivel) em vez de virar porta aberta em silencio.
      console.error('[webhook-security] token NAO configurado - webhook RECUSADO. Defina system_settings.webhook_token.');
      registrar(rota, 'semConfig');
      return res.status(503).json({ error: 'webhook nao configurado' });
    }
    const viaQuery = !!(req.query && req.query.token);
    const got = String((req.query && req.query.token) || req.headers['x-webhook-token'] || '');
    // FASE 3.2 - rotacao de token sem janela: aceita lista separada por virgula
    // (mantenha o token antigo + novo durante a troca das URLs no portal do BB).
    const validos = expected.split(',').map((t) => t.trim()).filter(Boolean);
    if (got && validos.includes(got)) { registrar(rota, 'aceito'); return next(); }
    console.warn('[webhook-security] webhook REJEITADO (token invalido) de', req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?');
    // O detalhe separa os dois diagnosticos, que pedem acoes diferentes:
    // "chamada SEM token" = a URL cadastrada no portal do BB nao tem ?token=;
    // "token de N caracteres" = a URL tem token, mas errado ou vencido.
    registrar(rota, 'rejeitadoToken', got ? `token de ${got.length} caracteres via ${viaQuery ? 'query' : 'header'}` : 'chamada SEM token');
    return res.status(401).json({ message: 'unauthorized' });
  } catch (e: any) {
    // Falha na leitura da config nao derruba o webhook em modo suave.
    console.error('[webhook-security] erro na checagem (deixando passar):', e?.message || e);
    try { registrar(rota, 'aceito', 'passou por falha na checagem'); } catch {}
    return next();
  }
}
