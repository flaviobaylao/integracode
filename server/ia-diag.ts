// ============================================================================
// INTEGRA 2.0 — Diagnóstico de webhooks de RECEBIMENTO (Umbler Talk)
// Mostra, dos últimos eventos gravados em webhook_debug_log, QUAL canal enviou
// (Channel.Id), o telefone do contato, a direção (Source) e o tipo — sem máscara —
// para diagnosticar por que o 1841 (canal oficial) não chega ao ChatCenter.
// Wiring em server/index.ts:
//   import { registerIaDiag } from "./ia-diag";
//   registerIaDiag(app);
// Acesso: /api/admin/ia-atendimento/diag-webhooks?k=SENHA (se OFICIAL_ADMIN_KEY setada)
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

// IDs conhecidos de canais (para rotular). 1841 oficial = ajqNf-Vjp4yjcaJf (UMBLER_OFFICIAL_CHANNEL_ID).
const CHANNEL_LABELS: Record<string, string> = {
  'ajqNf-Vjp4yjcaJf': '1841 (HONESTAPI oficial)',
};

export function registerIaDiag(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  app.get('/api/admin/ia-atendimento/diag-webhooks', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const n = Math.min(200, Math.max(5, parseInt(String(req.query.n || '80'), 10) || 80));
    let rows: any[] = [];
    try {
      const r: any = await db.execute(sql`SELECT id, created_at, LEFT(raw_payload, 40000) AS raw
        FROM webhook_debug_log ORDER BY created_at DESC LIMIT ${n}`);
      rows = r.rows || [];
    } catch (e: any) { return res.status(500).json({ error: e?.message || String(e) }); }

    const porCanal: Record<string, number> = {};
    const amostra: any[] = [];
    for (const row of rows) {
      let p: any = null;
      try { p = JSON.parse(row.raw); } catch { continue; }
      const content = (p.Payload && p.Payload.Content) || (p.payload && p.payload.content) || null;
      if (!content) continue;
      const ch = content.Channel || content.channel || {};
      const chId = ch.Id || ch.id || null;
      const chPhone = ch.PhoneNumber || ch.phoneNumber || ch.Phone || null;
      const contact = content.Contact || content.contact || {};
      const phone = contact.PhoneNumber || contact.phoneNumber || contact.Phone || null;
      const lm = content.LastMessage || content.lastMessage || {};
      const source = lm.Source || lm.source || null;
      const mtype = lm.MessageType || lm.messageType || null;
      const key = (chId || 'sem-canal') + (chPhone ? ' / ' + chPhone : '');
      porCanal[key] = (porCanal[key] || 0) + 1;
      if (amostra.length < 25) {
        amostra.push({
          at: row.created_at,
          canalId: chId,
          canalLabel: (chId && CHANNEL_LABELS[chId]) || null,
          canalPhone: chPhone,
          contatoPhone: phone,
          source,
          type: p.Type || null,
          msgType: mtype,
        });
      }
    }
    res.json({ analisados: rows.length, porCanal, amostra });
  });

  console.log('[IA-DIAG] registrado (/api/admin/ia-atendimento/diag-webhooks)');
}
