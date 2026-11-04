// ============================================================================
// INTEGRA 2.0 — Pedido de AMOSTRA para LEAD (degustação antes de virar cliente) — 04/11/2026
//
// Um lead ainda não é cliente: não tem cadastro no Omie, não fatura, não conta comissão nem
// positivação. Mas precisa receber amostras para degustar e fechar. Este módulo guarda o
// "Pedido de Amostra" ligado ao LEAD (tabela lead_sample_orders), com fluxo:
//   solicitado → aprovado (administrativo) → separado → entregue → degustado   (ou recusado/cancelado)
// Regras (Flavio, 04/11/2026): 1 unidade de cada sabor, SOMENTE 350 ml, 1 pedido por lead
// (amostra_max_pedidos_lead em system_settings, padrão 1). A data de retorno vira o próximo contato do lead.
// Custo: as garrafas cedidas entram no mesmo relatório de trocas/amostras da Indústria (sem diferenciar lead/cliente).
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

type Req = any; type Res = any;

const STATUS = ['solicitado', 'aprovado', 'recusado', 'separado', 'entregue', 'degustado', 'cancelado'] as const;
type Status = typeof STATUS[number];
const ADMIN = ['admin', 'coordinator', 'administrative'];
const PODE_PEDIR = ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing'];

let _tabela = false;
async function ensureTabela() {
  if (_tabela) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS lead_sample_orders (
    id serial PRIMARY KEY,
    lead_id varchar NOT NULL,
    seller_id varchar,
    requested_by varchar,
    requested_by_name varchar,
    status varchar(20) NOT NULL DEFAULT 'solicitado',
    items jsonb NOT NULL DEFAULT '[]'::jsonb,
    total_units integer NOT NULL DEFAULT 0,
    total_value numeric(10,2) NOT NULL DEFAULT 0,
    delivery_mode varchar(20) NOT NULL DEFAULT 'rota',
    delivery_date date,
    receiver varchar,
    objective varchar,
    return_date date,
    observation text,
    approved_by varchar, approved_by_name varchar, approved_at timestamptz,
    rejected_reason text,
    delivered_at timestamptz, delivered_by_name varchar,
    tasting_result varchar(20), tasting_notes text, tasted_at timestamptz,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lead_sample_orders_lead ON lead_sample_orders (lead_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lead_sample_orders_status ON lead_sample_orders (status)`);
  _tabela = true;
}

async function setting(key: string, def: number): Promise<number> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = Number(String(r.rows?.[0]?.value ?? '').replace(/"/g, ''));
    return isFinite(v) && v > 0 ? v : def;
  } catch { return def; }
}

const nome = (u: any) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() || u?.email || u?.id || '';
const rotulo: Record<string, string> = {
  solicitado: 'Solicitado', aprovado: 'Aprovado', recusado: 'Recusado', separado: 'Separado',
  entregue: 'Entregue', degustado: 'Degustação registrada', cancelado: 'Cancelado',
};

function serial(r: any) {
  return {
    id: Number(r.id), leadId: r.lead_id, sellerId: r.seller_id, requestedBy: r.requested_by, requestedByName: r.requested_by_name,
    status: r.status, statusLabel: rotulo[r.status] || r.status,
    items: Array.isArray(r.items) ? r.items : [], totalUnits: Number(r.total_units || 0), totalValue: Number(r.total_value || 0),
    deliveryMode: r.delivery_mode, deliveryDate: r.delivery_date, receiver: r.receiver, objective: r.objective, returnDate: r.return_date,
    observation: r.observation, approvedByName: r.approved_by_name, approvedAt: r.approved_at, rejectedReason: r.rejected_reason,
    deliveredAt: r.delivered_at, deliveredByName: r.delivered_by_name,
    tastingResult: r.tasting_result, tastingNotes: r.tasting_notes, tastedAt: r.tasted_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
    leadName: r.lead_name || null, leadPhone: r.lead_phone || null, leadContact: r.lead_contact || null, leadCity: r.lead_city || null, leadNeighborhood: r.lead_neighborhood || null,
  };
}

async function registrarVisitaLead(leadId: string, texto: string, user: any) {
  try {
    await db.execute(sql`INSERT INTO lead_visits (lead_id, user_id, user_name, observation, visit_date)
      VALUES (${leadId}, ${user?.id || 'sistema'}, ${nome(user) || 'Sistema'}, ${texto}, now())`);
  } catch { /* tabela/colunas podem variar — histórico é complementar */ }
}

export function registerLeadAmostras(app: any, authenticateUser: any) {
  // Config visível ao app (limites)
  app.get('/api/amostras/config', authenticateUser, async (_req: Req, res: Res) => {
    res.json({ maxUnidades: 0, maxPorSabor: 1, somente350: true, maxPedidosLead: await setting('amostra_max_pedidos_lead', 1) });
  });

  // Lista de amostras de um lead
  app.get('/api/leads/:id/amostras', authenticateUser, async (req: Req, res: Res) => {
    try {
      await ensureTabela();
      const r: any = await db.execute(sql`SELECT * FROM lead_sample_orders WHERE lead_id = ${String(req.params.id)} ORDER BY created_at DESC`);
      res.json({ ok: true, amostras: (r.rows || []).map(serial) });
    } catch (e: any) { res.status(500).json({ ok: false, message: e?.message }); }
  });

  // Criar pedido de amostra para o lead
  app.post('/api/leads/:id/amostras', authenticateUser, async (req: Req, res: Res) => {
    try {
      await ensureTabela();
      const user = req.currentUser;
      if (!PODE_PEDIR.includes(user?.role)) return res.status(403).json({ ok: false, message: 'Sem permissão para pedir amostra.' });
      const leadId = String(req.params.id);
      const lr: any = await db.execute(sql`SELECT id, fantasy_name, assigned_to, status FROM leads WHERE id = ${leadId} LIMIT 1`);
      const lead = lr.rows?.[0];
      if (!lead) return res.status(404).json({ ok: false, message: 'Lead não encontrado.' });
      if (['converted', 'discarded'].includes(String(lead.status))) return res.status(400).json({ ok: false, message: 'Este lead já foi convertido ou descartado.' });
      if (user.role === 'vendedor' && lead.assigned_to && lead.assigned_to !== user.id) return res.status(403).json({ ok: false, message: 'Este lead está com outro vendedor.' });

      const b = req.body || {};
      // Regra: 1 unidade de cada sabor, só 350 ml (sem exceção para admin)
      const vistos = new Set<string>();
      const items = (Array.isArray(b.items) ? b.items : []).map((it: any) => ({
        productId: String(it.productId || ''), name: String(it.name || '').slice(0, 120), qty: Math.max(0, Math.floor(Number(it.qty) || 0)), unitValue: Math.max(0, Number(it.unitValue) || 0),
      })).filter((it: any) => it.qty > 0 && it.name && !vistos.has(it.productId || it.name) && vistos.add(it.productId || it.name));
      if (!items.length) return res.status(400).json({ ok: false, message: 'Escolha ao menos um sabor.' });
      const fora350 = items.filter((it: any) => !/350/.test(it.name));
      if (fora350.length) return res.status(400).json({ ok: false, message: `Amostra só de 350 ml: ${fora350.map((i: any) => i.name).join(', ')}.` });
      const maisDeUm = items.filter((it: any) => it.qty > 1);
      if (maisDeUm.length) return res.status(400).json({ ok: false, message: 'Amostra é 1 unidade de cada sabor.' });
      const totalUnits = items.reduce((s: number, i: any) => s + i.qty, 0);
      const totalValue = items.reduce((s: number, i: any) => s + i.qty * i.unitValue, 0);
      const maxPed = await setting('amostra_max_pedidos_lead', 1);

      const ant: any = await db.execute(sql`SELECT status FROM lead_sample_orders WHERE lead_id = ${leadId} AND status NOT IN ('recusado','cancelado') ORDER BY created_at DESC`);
      const anteriores = (ant.rows || []) as any[];
      if (anteriores.length >= maxPed) return res.status(400).json({ ok: false, message: maxPed === 1 ? 'Este lead já teve a sua amostra (1 por lead).' : `Este lead já tem ${anteriores.length} pedido(s) de amostra (limite ${maxPed}).` });

      const deliveryMode = b.deliveryMode === 'vendedor' ? 'vendedor' : 'rota';
      const dOk = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null;
      const ins: any = await db.execute(sql`INSERT INTO lead_sample_orders
        (lead_id, seller_id, requested_by, requested_by_name, status, items, total_units, total_value, delivery_mode, delivery_date, receiver, objective, return_date, observation)
        VALUES (${leadId}, ${lead.assigned_to || (user.role === 'vendedor' ? user.id : null)}, ${user.id}, ${nome(user)}, 'solicitado', ${JSON.stringify(items)}::jsonb, ${totalUnits}, ${totalValue.toFixed(2)},
                ${deliveryMode}, ${dOk(b.deliveryDate)}, ${String(b.receiver || '').slice(0, 120) || null}, ${String(b.objective || '').slice(0, 120) || null}, ${dOk(b.returnDate)}, ${String(b.observation || '').slice(0, 2000) || null})
        RETURNING *`);
      const row = ins.rows[0];
      // Retorno combinado vira o próximo contato do lead (agendado)
      if (dOk(b.returnDate)) {
        try { await db.execute(sql`UPDATE leads SET next_contact_date = ${dOk(b.returnDate)}::date, status = CASE WHEN status = 'pending' THEN 'scheduled' ELSE status END, updated_at = now() WHERE id = ${leadId}`); } catch {}
      }
      await registrarVisitaLead(leadId, `Pedido de amostra #A-${row.id}: ${totalUnits} un. (${items.map((i: any) => `${i.qty}× ${i.name}`).join(', ')}) — aguardando aprovação`, user);
      console.log(`🧃 [AMOSTRA] #${row.id} lead ${lead.fantasy_name} · ${totalUnits} un. · por ${nome(user)}`);
      res.json({ ok: true, amostra: serial(row) });
    } catch (e: any) { console.error('[amostra] criar', e); res.status(500).json({ ok: false, message: e?.message }); }
  });

  // Mudar status (aprovar/recusar/separar/entregar/cancelar)
  app.post('/api/amostras/:id/status', authenticateUser, async (req: Req, res: Res) => {
    try {
      await ensureTabela();
      const user = req.currentUser;
      const id = Number(req.params.id);
      const novo = String(req.body?.status || '') as Status;
      const motivo = String(req.body?.motivo || '').trim();
      if (!STATUS.includes(novo)) return res.status(400).json({ ok: false, message: 'Status inválido.' });
      const r: any = await db.execute(sql`SELECT * FROM lead_sample_orders WHERE id = ${id} LIMIT 1`);
      const a = r.rows?.[0];
      if (!a) return res.status(404).json({ ok: false, message: 'Pedido de amostra não encontrado.' });
      const isAdmin = ADMIN.includes(user?.role);
      const dono = a.requested_by === user?.id || a.seller_id === user?.id;
      // Permissões: aprovar/recusar/separar = administrativo; entregue = admin ou (vendedor leva e é o dono); cancelar = admin ou dono enquanto solicitado
      if (['aprovado', 'recusado', 'separado'].includes(novo) && !isAdmin) return res.status(403).json({ ok: false, message: 'Só o administrativo aprova, recusa ou separa amostras.' });
      if (novo === 'entregue' && !isAdmin && !(a.delivery_mode === 'vendedor' && dono)) return res.status(403).json({ ok: false, message: 'Entrega só pode ser confirmada pelo administrativo ou pelo vendedor que leva a amostra.' });
      if (novo === 'cancelado' && !isAdmin && !(dono && a.status === 'solicitado')) return res.status(403).json({ ok: false, message: 'Só dá para cancelar enquanto está solicitado.' });
      if (novo === 'recusado' && motivo.length < 3) return res.status(400).json({ ok: false, message: 'Informe o motivo da recusa.' });
      if (novo === 'degustado') return res.status(400).json({ ok: false, message: 'Use o registro de degustação.' });
      const ordem: Record<string, number> = { solicitado: 0, aprovado: 1, separado: 2, entregue: 3, degustado: 4 };
      if (ordem[novo] != null && ordem[a.status] != null && ordem[novo] < ordem[a.status]) return res.status(400).json({ ok: false, message: `Pedido já está em "${rotulo[a.status]}".` });
      const up: any = await db.execute(sql`UPDATE lead_sample_orders SET status = ${novo}, updated_at = now(),
          approved_by = CASE WHEN ${novo} = 'aprovado' THEN ${user.id} ELSE approved_by END,
          approved_by_name = CASE WHEN ${novo} = 'aprovado' THEN ${nome(user)} ELSE approved_by_name END,
          approved_at = CASE WHEN ${novo} = 'aprovado' THEN now() ELSE approved_at END,
          rejected_reason = CASE WHEN ${novo} = 'recusado' THEN ${motivo} ELSE rejected_reason END,
          delivered_at = CASE WHEN ${novo} = 'entregue' THEN now() ELSE delivered_at END,
          delivered_by_name = CASE WHEN ${novo} = 'entregue' THEN ${nome(user)} ELSE delivered_by_name END
        WHERE id = ${id} RETURNING *`);
      const txt = novo === 'recusado' ? `Amostra #A-${id} recusada: ${motivo}` : `Amostra #A-${id}: ${rotulo[novo]} por ${nome(user)}`;
      await registrarVisitaLead(a.lead_id, txt, user);
      res.json({ ok: true, amostra: serial(up.rows[0]) });
    } catch (e: any) { res.status(500).json({ ok: false, message: e?.message }); }
  });

  // Registrar degustação
  app.post('/api/amostras/:id/degustacao', authenticateUser, async (req: Req, res: Res) => {
    try {
      await ensureTabela();
      const user = req.currentUser;
      const id = Number(req.params.id);
      const resultado = String(req.body?.resultado || '');
      if (!['gostou', 'pensar', 'nao_gostou'].includes(resultado)) return res.status(400).json({ ok: false, message: 'Resultado inválido.' });
      const r: any = await db.execute(sql`SELECT * FROM lead_sample_orders WHERE id = ${id} LIMIT 1`);
      const a = r.rows?.[0];
      if (!a) return res.status(404).json({ ok: false, message: 'Pedido de amostra não encontrado.' });
      if (!['entregue', 'degustado', 'separado', 'aprovado'].includes(a.status)) return res.status(400).json({ ok: false, message: 'A amostra ainda não foi entregue.' });
      const notas = String(req.body?.observacao || '').slice(0, 2000) || null;
      const up: any = await db.execute(sql`UPDATE lead_sample_orders SET status = 'degustado', tasting_result = ${resultado}, tasting_notes = ${notas}, tasted_at = now(),
        delivered_at = COALESCE(delivered_at, now()), updated_at = now() WHERE id = ${id} RETURNING *`);
      const lbl: Record<string, string> = { gostou: 'gostou', pensar: 'vai pensar', nao_gostou: 'não gostou' };
      await registrarVisitaLead(a.lead_id, `Degustação da amostra #A-${id}: ${lbl[resultado]}${notas ? ` — ${notas}` : ''}`, user);
      res.json({ ok: true, amostra: serial(up.rows[0]) });
    } catch (e: any) { res.status(500).json({ ok: false, message: e?.message }); }
  });

  // Painel do administrativo: todos os pedidos (filtro por status) + resumo
  app.get('/api/admin/amostras', authenticateUser, async (req: Req, res: Res) => {
    try {
      await ensureTabela();
      if (!ADMIN.includes(req.currentUser?.role)) return res.status(403).json({ ok: false, message: 'Acesso restrito ao administrativo.' });
      const st = String(req.query.status || '');
      const r: any = await db.execute(sql`
        SELECT a.*, l.fantasy_name AS lead_name, l.phone AS lead_phone, l.contact AS lead_contact, l.city AS lead_city, l.neighborhood AS lead_neighborhood,
               COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), a.requested_by_name) AS vendedor
        FROM lead_sample_orders a
        LEFT JOIN leads l ON l.id = a.lead_id
        LEFT JOIN users u ON u.id = a.seller_id
        WHERE (${st} = '' OR a.status = ${st})
        ORDER BY CASE a.status WHEN 'solicitado' THEN 0 WHEN 'aprovado' THEN 1 WHEN 'separado' THEN 2 WHEN 'entregue' THEN 3 ELSE 9 END, a.created_at DESC
        LIMIT 500`);
      const tot: any = await db.execute(sql`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_value),0)::float AS valor FROM lead_sample_orders GROUP BY status`);
      res.json({ ok: true, amostras: (r.rows || []).map((x: any) => ({ ...serial(x), vendedor: x.vendedor })), resumo: tot.rows || [] });
    } catch (e: any) { res.status(500).json({ ok: false, message: e?.message }); }
  });

  // Resumo por lead (status da amostra mais recente) — p/ selo no card da rota
  app.post('/api/amostras/resumo', authenticateUser, async (req: Req, res: Res) => {
    try {
      await ensureTabela();
      const ids = (Array.isArray(req.body?.leadIds) ? req.body.leadIds : []).map((x: any) => String(x)).filter(Boolean).slice(0, 500);
      if (!ids.length) return res.json({ ok: true, porLead: {} });
      const r: any = await db.execute(sql`SELECT DISTINCT ON (lead_id) lead_id, id, status, tasting_result FROM lead_sample_orders
        WHERE lead_id IN (${sql.join(ids.map((x: string) => sql`${x}`), sql`, `)}) ORDER BY lead_id, created_at DESC`);
      const porLead: Record<string, any> = {};
      for (const x of (r.rows || []) as any[]) porLead[String(x.lead_id)] = { id: Number(x.id), status: x.status, statusLabel: rotulo[x.status] || x.status, tastingResult: x.tasting_result };
      res.json({ ok: true, porLead });
    } catch (e: any) { res.status(500).json({ ok: false, message: e?.message }); }
  });

  console.log('[AMOSTRAS] módulo de amostras para leads registrado');
}
