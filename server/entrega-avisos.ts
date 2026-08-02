// ============================================================================
// INTEGRA 2.0 — Aviso de ENTREGA NÃO REALIZADA para quem vendeu
// O cliente recebe o template; o vendedor precisa saber pelo canal em que ele
// trabalha. Mesma divisao ja usada na repescagem:
//   telemarketing (interno, logado no sistema) -> alerta EM TELA ao abrir o app
//   vendedor externo (rua)                     -> WhatsApp
//
// Nao reaproveita a automacao 'pedido.bloqueado': aquele texto fala de faturamento
// retido, e mandaria a mensagem errada para o vendedor.
//
// Wiring: chamado por registerOfficialDispatch(app) em ./official-dispatch.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { authenticateUser } from './authMiddleware';

let _pronta = false;
async function ensureTabela(): Promise<void> {
  if (_pronta) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS entrega_falha_avisos (
    id serial PRIMARY KEY,
    sales_card_id varchar(64) NOT NULL,
    user_id varchar(64) NOT NULL,
    canal varchar(16) NOT NULL,
    mensagem text,
    criado_at timestamptz DEFAULT now(),
    visto_at timestamptz,
    enviado_ok boolean
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_efa_user ON entrega_falha_avisos (user_id, visto_at)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_efa_card_user ON entrega_falha_avisos (sales_card_id, user_id)`);
  _pronta = true;
}

// Quem vendeu. O seller_id do card ora e o id do usuario, ora o codigo do vendedor no
// Omie ('omie-vendor-123') — a mesma tripla usada nas telas de bloqueados.
async function vendedorDoPedido(salesCardId: string): Promise<any | null> {
  try {
    const r: any = await db.execute(sql`
      SELECT u.id, u.first_name, u.last_name, u.role::text AS role, u.phone, COALESCE(u.is_active, true) AS ativo
      FROM sales_cards sc
      LEFT JOIN users u ON (u.id = sc.seller_id
                            OR u.omie_vendor_code = sc.seller_id
                            OR u.omie_vendor_code = replace(sc.seller_id, 'omie-vendor-', ''))
      WHERE sc.id = ${salesCardId} LIMIT 1`);
    const u = r.rows?.[0];
    return u && u.id ? u : null;
  } catch { return null; }
}

/**
 * Registra (e envia, quando for o caso) o aviso de entrega nao realizada.
 * Idempotente por (pedido, vendedor): a varredura pode repetir sem duplicar aviso.
 */
export async function avisarFalhaDeEntrega(info: {
  salesCardId: string; numeroPedido: string; cliente: string; motivo: string;
}): Promise<{ ok: boolean; canal?: string; motivo?: string }> {
  try {
    await ensureTabela();
    const u = await vendedorDoPedido(info.salesCardId);
    if (!u) return { ok: false, motivo: 'vendedor nao identificado' };
    if (u.ativo === false) return { ok: false, motivo: 'vendedor inativo' };

    const ja: any = await db.execute(sql`SELECT 1 FROM entrega_falha_avisos
      WHERE sales_card_id = ${info.salesCardId} AND user_id = ${u.id} LIMIT 1`);
    if (ja.rows?.length) return { ok: false, motivo: 'ja avisado' };

    const nome = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
    const msg = `🚚 Entrega não realizada — pedido ${info.numeroPedido}\n`
      + `Cliente: ${info.cliente}\n`
      + `Motivo: ${info.motivo}\n`
      + `O cliente já foi avisado. Combine a nova data com ele.`;

    // Telemarketing trabalha logado no sistema: alerta em tela quando abrir o app.
    // Vendedor externo esta na rua: WhatsApp.
    const canal = String(u.role) === 'telemarketing' ? 'app' : 'whatsapp';
    let enviadoOk: boolean | null = null;

    if (canal === 'whatsapp') {
      const fone = String(u.phone || '').replace(/\D/g, '');
      if (!fone) return { ok: false, motivo: 'vendedor externo sem telefone cadastrado' };
      try {
        const { sendUmblerTalkText } = await import('./chat-routes');
        const r = await sendUmblerTalkText(fone, msg);
        enviadoOk = !!(r as any)?.success;
      } catch { enviadoOk = false; }
    }

    await db.execute(sql`INSERT INTO entrega_falha_avisos (sales_card_id, user_id, canal, mensagem, enviado_ok)
      VALUES (${info.salesCardId}, ${u.id}, ${canal}, ${msg}, ${enviadoOk})
      ON CONFLICT (sales_card_id, user_id) DO NOTHING`);

    console.log(`[ENTREGA-AVISO] pedido=${info.numeroPedido} vendedor=${nome || u.id} canal=${canal} enviado=${enviadoOk}`);
    return { ok: true, canal };
  } catch (e: any) {
    console.error('[ENTREGA-AVISO]', e?.message || e);
    return { ok: false, motivo: e?.message || String(e) };
  }
}

export function registerEntregaAvisos(app: any) {
  // Alerta em tela: o app consulta ao logar. Devolve o que ainda nao foi visto e marca
  // como visto na mesma chamada — o vendedor nao leva o mesmo aviso duas vezes.
  app.get('/api/vendedor/avisos-entrega', authenticateUser, async (req: any, res: any) => {
    try {
      await ensureTabela();
      const uid = req.currentUser?.id;
      if (!uid) return res.json({ count: 0, avisos: [] });
      const r: any = await db.execute(sql`SELECT id, mensagem FROM entrega_falha_avisos
        WHERE user_id = ${uid} AND canal = 'app' AND visto_at IS NULL
        ORDER BY criado_at DESC LIMIT 20`);
      const avisos = r.rows || [];
      if (avisos.length) {
        await db.execute(sql`UPDATE entrega_falha_avisos SET visto_at = now()
          WHERE user_id = ${uid} AND canal = 'app' AND visto_at IS NULL`);
      }
      res.json({ count: avisos.length, avisos: avisos.map((a: any) => String(a.mensagem || '')) });
    } catch (e: any) { res.json({ count: 0, avisos: [], erro: e?.message }); }
  });

  console.log('[ENTREGA-AVISOS] registrado (/api/vendedor/avisos-entrega)');
}
