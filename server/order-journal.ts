// ============================================================================
// 📓 ORDER JOURNAL — diário IMUTÁVEL de todo pedido que entra pela loja online
// ----------------------------------------------------------------------------
// POR QUE EXISTE (28/jul/2026):
// O pedido WEB-1785189596269 (27/jul 18:59 BRT) foi criado, o número foi devolvido
// ao cliente e confirmado por WhatsApp — e depois a linha em `sales_cards`
// desapareceu. Não sobrou NADA: nem card, nem item de pipeline, nem bloqueado, nem
// título, nem payload. O carrinho era irrecuperável porque o único lugar onde o
// pedido existia era a própria linha apagada.
//
// A partir daqui, o payload COMPLETO é gravado ANTES de qualquer coisa ser criada.
// Nada mais se perde: qualquer pedido — pago ou não — pode ser reconstruído.
//
// Regras:
//  - grava no primeiro instante do POST /api/public/orders, antes de resolver
//    cliente, gerar número ou criar card;
//  - NUNCA quebra a criação do pedido (todo erro é engolido e logado);
//  - a tabela é append-only na prática: só o vínculo (sales_card_id, order_number,
//    status) é atualizado depois.
// ============================================================================

import type { Express, Request, Response } from 'express';
import { db } from './db';
import { sql } from 'drizzle-orm';

let ensured = false;

export async function ensureOrderJournal(): Promise<void> {
  if (ensured) return;
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS order_journal (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
      order_number varchar,
      channel varchar,
      source varchar,
      customer_name varchar,
      customer_document varchar,
      customer_phone varchar,
      amount numeric(12,2),
      payload jsonb,
      sales_card_id varchar,
      status varchar NOT NULL DEFAULT 'received',
      error text,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS order_journal_created_idx ON order_journal (created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS order_journal_card_idx ON order_journal (sales_card_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS order_journal_number_idx ON order_journal (order_number)`);
    ensured = true;
  } catch (e: any) {
    console.error('[JOURNAL] ensure falhou (segue sem journal):', e?.message || e);
  }
}

const onlyDigits = (s: any) => String(s ?? '').replace(/\D/g, '');

/** Passo 1 — chamado no PRIMEIRO instante do POST /api/public/orders. Devolve o id da linha. */
export async function journalOrderReceived(body: any, channel = 'hotsite'): Promise<string | null> {
  try {
    await ensureOrderJournal();
    const c = body?.customer || {};
    const r: any = await db.execute(sql`
      INSERT INTO order_journal (channel, source, customer_name, customer_document, customer_phone, amount, payload, status)
      VALUES (${channel}, ${String(body?.source || channel)}, ${String(c.name || '') || null},
              ${onlyDigits(c.cpfCnpj) || null}, ${onlyDigits(c.phone) || null},
              ${Number(body?.totalAmount) || null}, ${JSON.stringify(body ?? {})}::jsonb, 'received')
      RETURNING id`);
    const id = ((r.rows || r) as any[])[0]?.id || null;
    if (id) console.log(`📓 [JOURNAL] pedido recebido ${id} (${c.name || 's/ nome'} · R$ ${body?.totalAmount})`);
    return id;
  } catch (e: any) {
    console.error('[JOURNAL] journalOrderReceived falhou (segue):', e?.message || e);
    return null;
  }
}

/** Passo 2 — o card nasceu: vincula número e sales_card_id. */
export async function journalOrderCreated(journalId: string | null, data: { orderNumber?: string; salesCardId?: string }): Promise<void> {
  if (!journalId) return;
  try {
    await db.execute(sql`UPDATE order_journal
      SET order_number = ${data.orderNumber || null}, sales_card_id = ${data.salesCardId || null},
          status = 'card_created', updated_at = now()
      WHERE id = ${journalId}`);
  } catch (e: any) { console.error('[JOURNAL] journalOrderCreated falhou:', e?.message || e); }
}

/** Passo 2b — o pedido falhou antes de virar card. O payload fica salvo para retentativa. */
export async function journalOrderFailed(journalId: string | null, err: any): Promise<void> {
  if (!journalId) return;
  try {
    await db.execute(sql`UPDATE order_journal
      SET status = 'failed', error = ${String(err?.message || err).slice(0, 500)}, updated_at = now()
      WHERE id = ${journalId}`);
  } catch (e: any) { console.error('[JOURNAL] journalOrderFailed falhou:', e?.message || e); }
}

/** Exclusão DELIBERADA de admin: marca no diário para o detector não ressuscitar o pedido. */
export async function journalMarkDeleted(salesCardId: string, by?: string): Promise<void> {
  try {
    await ensureOrderJournal();
    await db.execute(sql`UPDATE order_journal
      SET status = 'deleted_by_admin', error = ${'excluido por ' + String(by || 'admin')}, updated_at = now()
      WHERE sales_card_id = ${salesCardId}`);
  } catch (e: any) { console.error('[JOURNAL] journalMarkDeleted falhou:', e?.message || e); }
}

export type JournalAuditEntry = {
  id: string; orderNumber: string | null; salesCardId: string | null; status: string;
  customer: string | null; phone: string | null; amount: string | null; createdAt: any;
  hasCard: boolean; inPipeline: boolean; problema: string;
  recovered?: any; recoverError?: string; wouldRecover?: boolean;
};

/**
 * 🔎 DETECTOR — pedido que entrou pela loja e NÃO tem card nem item de pipeline.
 * dryRun por padrão. {apply:true} recria o pedido a partir do payload salvo (mesmo
 * método do recover-paid-orders) e o manda ao pipeline.
 */
export async function auditOrderJournal(opts?: { hours?: number; apply?: boolean }): Promise<{
  hours: number; apply: boolean; scanned: number; problemas: number; recuperados: number; entries: JournalAuditEntry[];
}> {
  const hours = Math.min(Math.max(Number(opts?.hours) || 72, 1), 2160);
  const apply = opts?.apply === true;
  await ensureOrderJournal();
  const INTERNAL_BASE = 'http://127.0.0.1:' + (process.env.PORT || '8080');
  const entries: JournalAuditEntry[] = [];
  let recuperados = 0;

  let rows: any[] = [];
  try {
    const r: any = await db.execute(sql.raw(
      `SELECT id, order_number, sales_card_id, status, customer_name, customer_phone, amount, payload, created_at
         FROM order_journal
        WHERE created_at > now() - interval '${hours} hours'
        ORDER BY created_at DESC LIMIT 500`));
    rows = (r.rows || r) as any[];
  } catch (e: any) {
    return { hours, apply, scanned: 0, problemas: 0, recuperados: 0, entries: [{ id: '-', orderNumber: null, salesCardId: null, status: 'erro', customer: null, phone: null, amount: null, createdAt: null, hasCard: false, inPipeline: false, problema: e?.message || String(e) }] };
  }

  for (const row of rows) {
    // Já resolvido ou excluído de propósito por um admin → não é "sumiço".
    if (['recovered', 'deleted_by_admin', 'cancelled'].includes(String(row.status))) continue;

    let hasCard = false, inPipeline = false;
    try {
      const c: any = await db.execute(sql`SELECT 1 FROM sales_cards WHERE id = ${row.sales_card_id || '-'} LIMIT 1`);
      hasCard = ((c.rows || c) as any[]).length > 0;
    } catch {}
    try {
      const p: any = await db.execute(sql`SELECT 1 FROM billing_pipeline WHERE sales_card_id = ${row.sales_card_id || '-'} LIMIT 1`);
      inPipeline = ((p.rows || p) as any[]).length > 0;
    } catch {}

    // Problema = pedido que entrou e hoje não existe em lugar nenhum.
    // (status 'failed' já é conhecido/logado, mas também entra: o payload permite retentar.)
    const problema = hasCard || inPipeline ? '' : (row.status === 'failed' ? 'pedido falhou na criacao' : 'PEDIDO SUMIU (sem card e sem pipeline)');
    if (!problema) continue;

    const e: JournalAuditEntry = {
      id: row.id, orderNumber: row.order_number || null, salesCardId: row.sales_card_id || null,
      status: row.status, customer: row.customer_name || null, phone: row.customer_phone || null,
      amount: row.amount != null ? String(row.amount) : null, createdAt: row.created_at,
      hasCard, inPipeline, problema,
    };

    if (apply) {
      try {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (!payload || !payload.items?.length) throw new Error('payload ausente/invalido');
        const resp = await fetch(`${INTERNAL_BASE}/api/public/orders`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const data: any = await resp.json();
        if (!resp.ok || !data?.orderId) throw new Error(data?.message || `HTTP ${resp.status}`);
        await db.execute(sql`UPDATE order_journal SET status='recovered', sales_card_id=${data.orderId}, updated_at=now() WHERE id=${row.id}`);
        try {
          await db.execute(sql`UPDATE sales_cards SET notes = COALESCE(notes,'') || ${'\n[RECUPERADO DO JOURNAL] pedido ' + String(row.order_number || row.id) + ' recriado automaticamente.'} WHERE id = ${data.orderId}`);
        } catch {}
        e.recovered = { newOrderId: data.orderId, newOrderNumber: data.orderNumber };
        recuperados++;
        console.log(`♻️ [JOURNAL] pedido recuperado: ${row.order_number || row.id} → ${data.orderNumber}`);
      } catch (err: any) { e.recoverError = err?.message || String(err); }
    } else {
      e.wouldRecover = true;
    }
    entries.push(e);
  }

  return { hours, apply, scanned: rows.length, problemas: entries.length, recuperados, entries };
}

// ---------------------------------------------------------------------------
// 🔔 ALERTA — ninguém mais descobre pelo cliente que um pedido sumiu.
// Config em system_settings: 'pedido_sumido_alerta_ativo' (on|off, default on)
// e 'pedido_sumido_alerta_fones' (lista separada por vírgula). Anti-spam de 3h.
// ---------------------------------------------------------------------------
async function getSetting(key: string, def = ''): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    return String(((r.rows || r) as any[])[0]?.value ?? def);
  } catch { return def; }
}

export async function runPedidoSumidoAlertaCron(): Promise<{ enviado: boolean; problemas: number; motivo?: string }> {
  try {
    if ((await getSetting('pedido_sumido_alerta_ativo', 'on')).toLowerCase() !== 'on') {
      return { enviado: false, problemas: 0, motivo: 'desligado' };
    }
    const r = await auditOrderJournal({ hours: 48, apply: false });
    if (!r.problemas) return { enviado: false, problemas: 0, motivo: 'nada a reportar' };

    // Anti-spam: no máximo 1 alerta a cada 3h.
    const last = await getSetting('pedido_sumido_alerta_last', '');
    if (last) {
      const t = Date.parse(last);
      if (Number.isFinite(t) && Date.now() - t < 3 * 60 * 60 * 1000) {
        console.warn(`🔔 [PEDIDO-SUMIDO] ${r.problemas} pedido(s) sem card — alerta suprimido (anti-spam 3h)`);
        return { enviado: false, problemas: r.problemas, motivo: 'anti-spam' };
      }
    }

    const fones = (await getSetting('pedido_sumido_alerta_fones', ''))
      .split(/[,;\s]+/).map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 10);

    const lista = r.entries.slice(0, 5)
      .map((e) => `• ${e.orderNumber || e.id} · ${e.customer || 's/ nome'} · R$ ${e.amount || '?'} · ${e.problema}`)
      .join('\n');
    const msg = `🚨 *PEDIDO SUMIDO NA LOJA*\n\n${r.problemas} pedido(s) entraram pela loja nas últimas 48h e hoje não têm card nem item no pipeline:\n\n${lista}` +
      (r.problemas > 5 ? `\n… e mais ${r.problemas - 5}.` : '') +
      `\n\nO carrinho está salvo no diário. Para recriar: POST /api/admin/orders/journal/audit {apply:true}`;

    if (!fones.length) {
      console.error(`🚨 [PEDIDO-SUMIDO] ${r.problemas} pedido(s) sem card — SEM telefone configurado ('pedido_sumido_alerta_fones'). Detalhe:\n${lista}`);
      return { enviado: false, problemas: r.problemas, motivo: 'sem destinatarios' };
    }

    let enviados = 0;
    try {
      const { sendUmblerTalkText } = await import('./chat-routes');
      for (const to of fones) {
        try { const s = await sendUmblerTalkText(to, msg); if ((s as any)?.success) enviados++; }
        catch (e: any) { console.error('[PEDIDO-SUMIDO] envio falhou', to, e?.message || e); }
      }
    } catch (e: any) { console.error('[PEDIDO-SUMIDO] WhatsApp indisponivel:', e?.message || e); }

    const stamp = new Date().toISOString();
    try {
      await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('pedido_sumido_alerta_last', ${stamp}, 'cron-pedido-sumido')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
    } catch {}

    console.warn(`🚨 [PEDIDO-SUMIDO] ${r.problemas} problema(s); alerta enviado a ${enviados}/${fones.length} numero(s).`);
    return { enviado: enviados > 0, problemas: r.problemas };
  } catch (e: any) {
    console.error('[PEDIDO-SUMIDO] cron erro:', e?.message || e);
    return { enviado: false, problemas: 0, motivo: e?.message || String(e) };
  }
}

export function registerOrderJournal(app: Express, authenticateUser: any, isAdminOnly: any) {
  void ensureOrderJournal();

  // Lista o diário (read-only). ?hours=72
  app.get('/api/admin/orders/journal', authenticateUser, isAdminOnly, async (req: Request, res: Response) => {
    try {
      await ensureOrderJournal();
      const hours = Math.min(Math.max(Number((req.query as any).hours) || 72, 1), 2160);
      const r: any = await db.execute(sql.raw(
        `SELECT id, order_number, sales_card_id, status, channel, source, customer_name, customer_phone,
                amount, error, created_at, updated_at
           FROM order_journal
          WHERE created_at > now() - interval '${hours} hours'
          ORDER BY created_at DESC LIMIT 500`));
      res.json({ ok: true, hours, rows: (r.rows || r) });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Detector + recuperação. Body: { hours?: 72, apply?: false }
  app.post('/api/admin/orders/journal/audit', authenticateUser, isAdminOnly, async (req: any, res: Response) => {
    try {
      const r = await auditOrderJournal({ hours: Number(req.body?.hours), apply: req.body?.apply === true });
      res.json({ ok: true, ...r });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Config do alerta (ativo + telefones) e disparo manual para conferência.
  app.get('/api/admin/orders/journal/alerta/config', authenticateUser, isAdminOnly, async (_req: Request, res: Response) => {
    try {
      res.json({
        ok: true,
        ativo: await getSetting('pedido_sumido_alerta_ativo', 'on'),
        fones: await getSetting('pedido_sumido_alerta_fones', ''),
        ultimoAlerta: await getSetting('pedido_sumido_alerta_last', ''),
      });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.post('/api/admin/orders/journal/alerta/config', authenticateUser, isAdminOnly, async (req: any, res: Response) => {
    try {
      const by = String(req.currentUser?.email || 'admin');
      if (typeof req.body?.ativo === 'string') {
        const v = req.body.ativo.toLowerCase() === 'on' ? 'on' : 'off';
        await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('pedido_sumido_alerta_ativo', ${v}, ${by})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      }
      if (typeof req.body?.fones === 'string') {
        await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('pedido_sumido_alerta_fones', ${req.body.fones}, ${by})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      }
      res.json({
        ok: true,
        ativo: await getSetting('pedido_sumido_alerta_ativo', 'on'),
        fones: await getSetting('pedido_sumido_alerta_fones', ''),
      });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.post('/api/admin/orders/journal/alerta/run', authenticateUser, isAdminOnly, async (_req: Request, res: Response) => {
    try { res.json({ ok: true, ...(await runPedidoSumidoAlertaCron()) }); }
    catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Payload completo de UM pedido (para reconstruir/atender manualmente).
  app.get('/api/admin/orders/journal/:id', authenticateUser, isAdminOnly, async (req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql`SELECT * FROM order_journal WHERE id = ${req.params.id} OR order_number = ${req.params.id} ORDER BY created_at DESC LIMIT 1`);
      const row = ((r.rows || r) as any[])[0];
      if (!row) return res.status(404).json({ ok: false, error: 'nao encontrado' });
      res.json({ ok: true, row });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
}
