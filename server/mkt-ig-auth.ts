// ============================================================================
// CENTRAL DE MARKETING — CONEXAO INSTAGRAM (Instagram API com login do Instagram)
// ----------------------------------------------------------------------------
// Substitui o "gera token na mao e cola no Railway" por um botao "Conectar
// Instagram": o gestor loga como @bebahonest, clica Permitir e o token de longa
// duracao (60 dias) cai em system_settings. Um cron renova antes de vencer.
//
// Fluxo (documentacao "Instagram API with Instagram Login"):
//   1. GET /api/mkt/ig/conectar   -> redireciona para instagram.com/oauth/authorize
//   2. GET /api/mkt/ig/callback   -> troca code por token curto (api.instagram.com/oauth/access_token),
//                                    converte em longo (graph.instagram.com/access_token?grant_type=ig_exchange_token),
//                                    le /me (user_id, username) e guarda tudo em system_settings.
//   3. cron semanal               -> refresh_access_token quando faltar < 20 dias.
//
// ENV:
//   IG_APP_ID       id do app Instagram (pagina "Configuracao da API com login do Instagram")
//   IG_APP_SECRET   segredo do app Instagram (mesma pagina). Sem ele o callback nao troca o code.
//   APP_URL         base publica do Integra (default: producao no Railway)
//
// Quem consome: credenciais() — devolve token + id + base da Graph. Preferencia:
// token conectado por aqui (graph.instagram.com) > IG_PAGE_TOKEN do env (graph.facebook.com).
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import crypto from 'crypto';

const APP_URL = () => String(process.env.APP_URL || 'https://integracode-production.up.railway.app').replace(/\/+$/, '');
const GRAPH_VERSION = () => process.env.GRAPH_VERSION || 'v21.0';
export const REDIRECT_PATH = '/api/mkt/ig/callback';
export const ESCOPOS = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_insights',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
];

const K = {
  token: 'ig_token', userId: 'ig_user_id', username: 'ig_username', expira: 'ig_token_expira',
  permissoes: 'ig_permissoes', conectadoEm: 'ig_conectado_em', renovadoEm: 'ig_renovado_em', state: 'ig_oauth_state', erro: 'ig_ultimo_erro',
};

async function get(key: string): Promise<string | null> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    if (v === undefined || v === null) return null;
    return String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/^"|"$/g, '');
  } catch { return null; }
}
async function set(key: string, value: string | null): Promise<void> {
  if (value === null) { await db.execute(sql`DELETE FROM system_settings WHERE key = ${key}`); return; }
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, ${'mkt-ig'})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
}

export type CredenciaisIg = {
  ok: boolean;
  origem: 'instagram_login' | 'env' | 'nenhuma';
  token: string;
  userId: string | null;
  username?: string | null;
  base: string;           // ex.: https://graph.instagram.com/v21.0
  expiraEm?: string | null;
  diasRestantes?: number | null;
  permissoes?: string[];
};

/** Token + conta + base da Graph. Nunca expor o token em rota. */
export async function credenciais(): Promise<CredenciaisIg> {
  const token = await get(K.token);
  if (token) {
    const expira = await get(K.expira);
    const dias = expira ? Math.floor((new Date(expira).getTime() - Date.now()) / 86400000) : null;
    const perms = (await get(K.permissoes)) || '';
    return {
      ok: dias === null || dias > 0, origem: 'instagram_login', token,
      userId: await get(K.userId), username: await get(K.username),
      base: 'https://graph.instagram.com/' + GRAPH_VERSION(), expiraEm: expira, diasRestantes: dias,
      permissoes: perms.split(',').map(s => s.trim()).filter(Boolean),
    };
  }
  const env = String(process.env.IG_PAGE_TOKEN || '');
  if (env) {
    return {
      ok: true, origem: 'env', token: env, userId: process.env.IG_BUSINESS_ID || null,
      base: (process.env.IG_GRAPH_BASE || 'https://graph.facebook.com') + '/' + GRAPH_VERSION(),
    };
  }
  return { ok: false, origem: 'nenhuma', token: '', userId: null, base: 'https://graph.instagram.com/' + GRAPH_VERSION() };
}

/** Estado para a tela — sem o token. */
export async function status(): Promise<any> {
  const c = await credenciais();
  const falta: string[] = [];
  if (!process.env.IG_APP_ID) falta.push('IG_APP_ID');
  if (!process.env.IG_APP_SECRET) falta.push('IG_APP_SECRET');
  return {
    conectado: c.origem === 'instagram_login' && c.ok,
    origem: c.origem, username: c.username || null, userId: c.userId,
    expiraEm: c.expiraEm || null, diasRestantes: c.diasRestantes ?? null,
    permissoes: c.permissoes || [],
    podePublicar: (c.permissoes || []).includes('instagram_business_content_publish'),
    podeInsights: (c.permissoes || []).includes('instagram_business_manage_insights'),
    conectadoEm: await get(K.conectadoEm), renovadoEm: await get(K.renovadoEm), ultimoErro: await get(K.erro),
    redirectUri: APP_URL() + REDIRECT_PATH, faltaEnv: falta,
  };
}

/** URL de autorizacao (com state anti-CSRF guardado em system_settings). */
export async function urlConectar(): Promise<{ ok: boolean; url?: string; erro?: string }> {
  const appId = process.env.IG_APP_ID;
  if (!appId) return { ok: false, erro: 'IG_APP_ID ausente no Railway' };
  if (!process.env.IG_APP_SECRET) return { ok: false, erro: 'IG_APP_SECRET ausente no Railway (o callback precisa dele)' };
  const state = crypto.randomBytes(16).toString('hex') + '.' + Date.now();
  await set(K.state, state);
  const qs = new URLSearchParams({
    client_id: appId, redirect_uri: APP_URL() + REDIRECT_PATH, scope: ESCOPOS.join(','),
    response_type: 'code', state, force_reauth: 'true',
  });
  return { ok: true, url: 'https://www.instagram.com/oauth/authorize?' + qs.toString() };
}

async function postForm(url: string, form: Record<string, string>): Promise<{ ok: boolean; corpo: any; erro?: string }> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j?.error || j?.error_type) return { ok: false, corpo: j, erro: j?.error_message || j?.error?.message || ('HTTP ' + r.status) };
    return { ok: true, corpo: j };
  } catch (e: any) { return { ok: false, corpo: null, erro: String(e?.message || e) }; }
}
async function getJson(url: string): Promise<{ ok: boolean; corpo: any; erro?: string }> {
  try {
    const r = await fetch(url);
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) return { ok: false, corpo: j, erro: j?.error?.message || ('HTTP ' + r.status) };
    return { ok: true, corpo: j };
  } catch (e: any) { return { ok: false, corpo: null, erro: String(e?.message || e) }; }
}

/** Callback do OAuth: code -> token curto -> longo -> /me -> system_settings. */
export async function concluirCallback(code: string, state: string): Promise<{ ok: boolean; username?: string; permissoes?: string[]; expiraEm?: string; erro?: string }> {
  const esperado = await get(K.state);
  if (!esperado || esperado !== state) return { ok: false, erro: 'state inválido ou expirado — clique em Conectar Instagram de novo' };
  const idade = Date.now() - Number(esperado.split('.')[1] || 0);
  if (idade > 15 * 60 * 1000) return { ok: false, erro: 'login demorou mais de 15 minutos — comece de novo' };
  await set(K.state, null);

  const appId = String(process.env.IG_APP_ID || ''), secret = String(process.env.IG_APP_SECRET || '');
  if (!appId || !secret) return { ok: false, erro: 'IG_APP_ID/IG_APP_SECRET ausentes' };

  // 1. code -> token curto (1h) + user_id + permissoes concedidas
  const curto = await postForm('https://api.instagram.com/oauth/access_token', {
    client_id: appId, client_secret: secret, grant_type: 'authorization_code',
    redirect_uri: APP_URL() + REDIRECT_PATH, code: String(code || '').replace(/#_$/, ''),
  });
  if (!curto.ok) { await set(K.erro, 'troca do code: ' + curto.erro); return { ok: false, erro: 'troca do code: ' + curto.erro }; }
  const tokenCurto = String(curto.corpo?.access_token || '');
  const perms: string[] = Array.isArray(curto.corpo?.permissions) ? curto.corpo.permissions.map(String)
    : String(curto.corpo?.permissions || '').split(',').map((s: string) => s.trim()).filter(Boolean);

  // 2. curto -> longo (60 dias)
  const longo = await getJson('https://graph.instagram.com/access_token?' + new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: secret, access_token: tokenCurto }).toString());
  if (!longo.ok) { await set(K.erro, 'token longo: ' + longo.erro); return { ok: false, erro: 'token longo: ' + longo.erro }; }
  const token = String(longo.corpo?.access_token || '');
  const expiraEm = new Date(Date.now() + (Number(longo.corpo?.expires_in) || 60 * 86400) * 1000).toISOString();

  // 3. quem sou eu
  const me = await getJson('https://graph.instagram.com/' + GRAPH_VERSION() + '/me?' + new URLSearchParams({ fields: 'user_id,username,account_type', access_token: token }).toString());
  const userId = String(me.corpo?.user_id || curto.corpo?.user_id || '');
  const username = String(me.corpo?.username || '');

  await set(K.token, token);
  await set(K.userId, userId || null);
  await set(K.username, username || null);
  await set(K.expira, expiraEm);
  await set(K.permissoes, perms.join(','));
  await set(K.conectadoEm, new Date().toISOString());
  await set(K.erro, null);
  console.log('[MKT-IG] conectado como @' + username + ' · ' + perms.length + ' permissão(ões) · vence ' + expiraEm.slice(0, 10));
  return { ok: true, username, permissoes: perms, expiraEm };
}

/** Renova o token longo (a Meta exige token com > 24h e ainda válido). */
export async function renovar(opts: { forcar?: boolean } = {}): Promise<{ ok: boolean; renovou?: boolean; diasRestantes?: number | null; erro?: string }> {
  const c = await credenciais();
  if (c.origem !== 'instagram_login') return { ok: true, renovou: false, diasRestantes: null };
  const dias = c.diasRestantes ?? null;
  if (!opts.forcar && dias !== null && dias > 20) return { ok: true, renovou: false, diasRestantes: dias };
  if (dias !== null && dias <= 0) { await set(K.erro, 'token vencido — reconectar'); return { ok: false, erro: 'token vencido: precisa clicar em Conectar Instagram de novo', diasRestantes: dias }; }
  const r = await getJson('https://graph.instagram.com/refresh_access_token?' + new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: c.token }).toString());
  if (!r.ok) { await set(K.erro, 'renovação: ' + r.erro); return { ok: false, erro: r.erro, diasRestantes: dias }; }
  const novo = String(r.corpo?.access_token || '');
  if (!novo) return { ok: false, erro: 'resposta sem token', diasRestantes: dias };
  const expiraEm = new Date(Date.now() + (Number(r.corpo?.expires_in) || 60 * 86400) * 1000).toISOString();
  await set(K.token, novo); await set(K.expira, expiraEm); await set(K.renovadoEm, new Date().toISOString()); await set(K.erro, null);
  console.log('[MKT-IG] token renovado · vence ' + expiraEm.slice(0, 10));
  return { ok: true, renovou: true, diasRestantes: Math.floor((new Date(expiraEm).getTime() - Date.now()) / 86400000) };
}

export async function desconectar(): Promise<void> {
  for (const k of [K.token, K.userId, K.username, K.expira, K.permissoes, K.conectadoEm, K.renovadoEm, K.state, K.erro]) await set(k, null);
}

/** Testa a conexao: /me + media_count. Sem escrever nada. */
export async function testar(): Promise<{ ok: boolean; username?: string; mediaCount?: number; erro?: string; origem?: string }> {
  const c = await credenciais();
  if (!c.ok) return { ok: false, erro: c.origem === 'nenhuma' ? 'sem token' : 'token vencido', origem: c.origem };
  const alvo = c.origem === 'instagram_login' ? 'me' : String(c.userId || 'me');
  const r = await getJson(c.base + '/' + alvo + '?' + new URLSearchParams({ fields: 'id,username,media_count', access_token: c.token }).toString());
  if (!r.ok) return { ok: false, erro: r.erro, origem: c.origem };
  return { ok: true, username: r.corpo?.username, mediaCount: Number(r.corpo?.media_count) || 0, origem: c.origem };
}

function paginaHtml(titulo: string, corpo: string, ok: boolean): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.c{background:#fff;border-radius:16px;padding:32px 36px;max-width:460px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center}
h1{font-size:20px;margin:0 0 8px;color:${ok ? '#15803d' : '#b91c1c'}}p{color:#374151;line-height:1.5}a{color:#2563eb}</style></head>
<body><div class="c"><h1>${titulo}</h1><p>${corpo}</p><p><a href="/marketing">Voltar para a Central de Marketing</a></p></div></body></html>`;
}

export function registerMktIgAuth(app: any, authenticateUser: any, requireRole: any) {
  app.get('/api/mkt/ig/status', authenticateUser, async (_req: any, res: any) => {
    try { res.json(await status()); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.get('/api/mkt/ig/conectar', authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      const r = await urlConectar();
      if (!r.ok) return res.status(400).json({ error: r.erro });
      res.json({ url: r.url });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  // Volta do Instagram: sem sessao do Integra (o navegador vem do instagram.com). O state e a prova.
  app.get(REDIRECT_PATH, async (req: any, res: any) => {
    const code = String(req.query.code || ''), state = String(req.query.state || '');
    if (req.query.error) return res.status(400).send(paginaHtml('Instagram não conectado', 'O Instagram devolveu: ' + String(req.query.error_description || req.query.error_reason || req.query.error), false));
    if (!code) return res.status(400).send(paginaHtml('Instagram não conectado', 'Faltou o código de autorização.', false));
    try {
      const r = await concluirCallback(code, state);
      if (!r.ok) return res.status(400).send(paginaHtml('Instagram não conectado', String(r.erro), false));
      res.send(paginaHtml('Instagram conectado ✅', 'Conta <b>@' + r.username + '</b> · ' + (r.permissoes || []).length + ' permissões · token válido até ' + String(r.expiraEm).slice(0, 10) + '. A Central renova sozinha antes de vencer.', true));
    } catch (e: any) { res.status(500).send(paginaHtml('Erro', String(e?.message || e), false)); }
  });
  app.post('/api/mkt/ig/renovar', authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { res.json(await renovar({ forcar: true })); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/mkt/ig/testar', authenticateUser, async (_req: any, res: any) => {
    try { res.json(await testar()); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/mkt/ig/desconectar', authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { await desconectar(); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
}
