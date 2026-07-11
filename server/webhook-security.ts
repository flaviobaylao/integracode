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

export async function webhookTokenGuard(req: any, res: any, next: any) {
  try {
    const expected = await getWebhookToken();
    if (!expected) {
      console.warn('[webhook-security] token nao configurado - aceitando webhook SEM validacao (defina webhook_token para ativar)');
      return next();
    }
    const got = String((req.query && req.query.token) || req.headers['x-webhook-token'] || '');
    if (got && got === expected) return next();
    console.warn('[webhook-security] webhook REJEITADO (token invalido) de', req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?');
    return res.status(401).json({ message: 'unauthorized' });
  } catch (e: any) {
    // Falha na leitura da config nao derruba o webhook em modo suave.
    console.error('[webhook-security] erro na checagem (deixando passar):', e?.message || e);
    return next();
  }
}
