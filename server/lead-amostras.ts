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
// NF: o lead precisa ter NOTA FISCAL de amostra grátis (CFOP 5911), igual ao cliente. Por isso o pedido exige o
// CNPJ (lupa da Receita) e, na APROVAÇÃO, o Integra cria um cadastro de cliente "em prospecção" (is_lead = true,
// inativo), um card de venda com operação 'amostra' e o joga no Pipeline de Faturamento — o mesmo caminho da
// amostra de cliente. Quando o lead é convertido, esse cadastro é reaproveitado (não duplica CNPJ).
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { storage } from './storage';
import { receitaService } from './receitaIntegration';

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
  // Dados fiscais (NF de amostra grátis): no pedido (snapshot) e no lead (reaproveitado na conversão)
  for (const c of ['cnpj varchar(20)', 'company_name varchar(200)', 'fiscal jsonb', 'customer_id varchar', 'sales_card_id varchar', 'pipeline_item_id varchar'])
    await db.execute(sql.raw(`ALTER TABLE lead_sample_orders ADD COLUMN IF NOT EXISTS ${c}`));
  for (const c of ['cnpj varchar(20)', 'company_name varchar(200)', 'fiscal_address text', 'fiscal_neighborhood varchar(120)', 'fiscal_city varchar(120)', 'fiscal_state varchar(2)', 'fiscal_zip varchar(12)', 'state_registration varchar(30)', 'email varchar(160)'])
    await db.execute(sql.raw(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS ${c}`));
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
    cnpj: r.cnpj || null, companyName: r.company_name || null, fiscal: r.fiscal || null,
    customerId: r.customer_id || null, salesCardId: r.sales_card_id || null, pipelineItemId: r.pipeline_item_id || null,
  };
}

async function registrarVisitaLead(leadId: string, texto: string, user: any) {
  try {
    await db.execute(sql`INSERT INTO lead_visits (lead_id, user_id, user_name, observation, visit_date)
      VALUES (${leadId}, ${user?.id || 'sistema'}, ${nome(user) || 'Sistema'}, ${texto}, now())`);
  } catch { /* tabela/colunas podem variar — histórico é complementar */ }
}

// Cria/reaproveita o cadastro em prospecção (is_lead=true, inativo) pelo CNPJ, monta o card 'amostra' com os
// preços de tabela dos produtos e envia ao Pipeline de Faturamento (skipDebtCheck: a aprovação do admin É a liberação).
async function emitirAmostraNoPipeline(a: any, user: any): Promise<{ ok: boolean; message?: string }> {
  const cnpjDig = String(a.cnpj || '').replace(/\D/g, '');
  if (cnpjDig.length !== 14) return { ok: false, message: 'Este pedido não tem CNPJ. Peça ao vendedor para refazer com o CNPJ do lead.' };
  const f: any = a.fiscal || {};
  const lr: any = await db.execute(sql`SELECT * FROM leads WHERE id = ${a.lead_id} LIMIT 1`);
  const lead: any = lr.rows?.[0];
  if (!lead) return { ok: false, message: 'Lead não encontrado.' };
  // 1) cliente pelo CNPJ (qualquer um existente serve — evita duplicar); senão cria em prospecção
  let customerId: string | null = null;
  const ex: any = await db.execute(sql`SELECT id, is_active, is_lead FROM customers WHERE regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g') = ${cnpjDig} ORDER BY is_active DESC LIMIT 1`);
  if (ex.rows?.[0]) customerId = String(ex.rows[0].id);
  else {
    const sellerId = a.seller_id || lead.assigned_to || user.id;
    const c: any = await storage.createCustomer({
      name: f.razaoSocial || a.company_name || lead.fantasy_name,
      fantasyName: lead.fantasy_name,
      companyName: f.razaoSocial || a.company_name || null,
      customerType: 'pessoa_juridica',
      cnpj: receitaService.formatarCNPJ(cnpjDig),
      stateRegistration: f.ie || null,
      phone: lead.phone || '(00) 00000-0000',
      email: f.email || lead.email || null,
      address: f.endereco || lead.fiscal_address || 'Endereço não informado',
      neighborhood: f.bairro || lead.neighborhood || null,
      city: f.cidade || lead.city || null,
      state: f.uf || 'GO',
      zipCode: f.cep || null,
      sellerId,
      weekdays: JSON.stringify(['Seg']),
      visitPeriodicity: 'semanal',
      latitude: lead.latitude != null ? String(lead.latitude) : null,
      longitude: lead.longitude != null ? String(lead.longitude) : null,
      isActive: false,   // em prospecção: não é cliente ativo, não entra em agenda/positivação/comissão
      isLead: true,
    } as any);
    customerId = String(c.id);
    try { await db.execute(sql.raw("ALTER TABLE customers ADD COLUMN IF NOT EXISTS origin_lead_id varchar")); await db.execute(sql`UPDATE customers SET origin_lead_id = ${a.lead_id} WHERE id = ${customerId}`); } catch {}
  }
  // 2) produtos com preço de tabela (a NF de amostra grátis carrega o valor do produto)
  const items: any[] = Array.isArray(a.items) ? a.items : [];
  const products: any[] = []; let saleValue = 0;
  for (const it of items) {
    let pd: any = null;
    try { pd = it.productId ? await storage.getProduct(String(it.productId)) : null; } catch {}
    if (!pd) { try { const pr: any = await db.execute(sql`SELECT * FROM products WHERE name = ${it.name} LIMIT 1`); pd = pr.rows?.[0] || null; if (pd && pd.retail_price) pd.retailPrice = pd.retail_price; } catch {} }
    const unit = Number(pd?.retailPrice ?? pd?.price ?? it.unitValue ?? 0) || 0;
    const qty = Number(it.qty) || 1;
    products.push({ productId: pd?.id || it.productId || null, id: pd?.id || it.productId || null, name: pd?.name || it.name, quantity: qty, unitPrice: unit, totalPrice: Math.round(unit * qty * 100) / 100 });
    saleValue += unit * qty;
  }
  if (!(saleValue > 0)) return { ok: false, message: 'Produtos sem preço de tabela — não dá para emitir a NF de amostra.' };
  // 3) card de venda com operação 'amostra' (concluído) → pipeline
  const card: any = await storage.createSalesCard({
    customerId, sellerId: a.seller_id || lead.assigned_to || user.id, status: 'completed', isPermanent: false, isRecurring: false,
    routeDay: 'Seg', recurrenceType: 'semanal', scheduledDate: new Date(), completedDate: new Date(),
    saleValue: saleValue.toFixed(2), products: products as any, paymentMethod: 'a_vista', operationType: 'amostra', boletoDays: 0,
    customerLatitude: lead.latitude != null ? String(lead.latitude) : null, customerLongitude: lead.longitude != null ? String(lead.longitude) : null,
    notes: `Amostra grátis para LEAD #A-${a.id} (${lead.fantasy_name}) — aprovada por ${nome(user)}`, source: 'integra',
  } as any);
  const { finalizarPedidoParaPipeline } = await import('./billing-pipeline-routes.js');
  const r = await finalizarPedidoParaPipeline(card, user.email || 'system', { skipDebtCheck: true, skipHistoryGuard: true });
  if (!r?.item) return { ok: false, message: 'A amostra não entrou no Pipeline de Faturamento (veja Pedidos Bloqueados / duplicidade).' };
  await db.execute(sql`UPDATE lead_sample_orders SET customer_id = ${customerId}, sales_card_id = ${String(card.id)}, pipeline_item_id = ${String(r.item.id)}, updated_at = now() WHERE id = ${a.id}`);
  console.log(`🧾 [AMOSTRA] #A-${a.id} → pipeline item ${r.item.id} (NF amostra grátis) cliente ${customerId}`);
  return { ok: true };
}

export function registerLeadAmostras(app: any, authenticateUser: any) {
  // Config visível ao app (limites)
  app.get('/api/amostras/config', authenticateUser, async (_req: Req, res: Res) => {
    res.json({ maxUnidades: 0, maxPorSabor: 1, somente350: true, maxPedidosLead: await setting('amostra_max_pedidos_lead', 1) });
  });

  // Dados fiscais já conhecidos do lead (pré-preenche o CNPJ no formulário)
  app.get('/api/leads/:id/fiscal', authenticateUser, async (req: Req, res: Res) => {
    try {
      await ensureTabela();
      const r: any = await db.execute(sql`SELECT cnpj, company_name, fiscal_address, fiscal_neighborhood, fiscal_city, fiscal_state, fiscal_zip, state_registration, email FROM leads WHERE id = ${String(req.params.id)} LIMIT 1`);
      const l = r.rows?.[0] || {};
      res.json({ ok: true, cnpj: l.cnpj || '', fiscal: l.cnpj ? { razaoSocial: l.company_name || '', endereco: l.fiscal_address || '', bairro: l.fiscal_neighborhood || '', cidade: l.fiscal_city || '', uf: l.fiscal_state || '', cep: l.fiscal_zip || '', ie: l.state_registration || '', email: l.email || '' } : null });
    } catch (e: any) { res.status(500).json({ ok: false, message: e?.message }); }
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
      // NF de amostra grátis exige CNPJ + dados fiscais (vêm da lupa da Receita no formulário)
      const cnpjDig = String(b.cnpj || '').replace(/\D/g, '');
      if (cnpjDig.length !== 14 || !receitaService.validarCNPJ(cnpjDig)) return res.status(400).json({ ok: false, message: 'Informe um CNPJ válido (a amostra gera nota fiscal de amostra grátis).' });
      const f = (b.fiscal && typeof b.fiscal === 'object') ? b.fiscal : {};
      const fiscal = {
        razaoSocial: String(f.razaoSocial || '').slice(0, 200), endereco: String(f.endereco || '').slice(0, 300), bairro: String(f.bairro || '').slice(0, 120),
        cidade: String(f.cidade || '').slice(0, 120), uf: String(f.uf || '').slice(0, 2).toUpperCase(), cep: String(f.cep || '').replace(/\D/g, '').slice(0, 8),
        ie: String(f.ie || '').slice(0, 30), email: String(f.email || '').slice(0, 160), situacao: String(f.situacao || '').slice(0, 40),
      };
      if (!fiscal.razaoSocial || !fiscal.endereco || !fiscal.cidade || !fiscal.uf) return res.status(400).json({ ok: false, message: 'Use a lupa do CNPJ para puxar razão social e endereço da Receita.' });
      // guarda no lead (reaproveitado na conversão em cliente)
      try {
        await db.execute(sql`UPDATE leads SET cnpj = ${receitaService.formatarCNPJ(cnpjDig)}, company_name = ${fiscal.razaoSocial}, fiscal_address = ${fiscal.endereco}, fiscal_neighborhood = ${fiscal.bairro || null},
          fiscal_city = ${fiscal.cidade}, fiscal_state = ${fiscal.uf}, fiscal_zip = ${fiscal.cep || null}, state_registration = ${fiscal.ie || null}, email = COALESCE(NULLIF(${fiscal.email}, ''), email), updated_at = now() WHERE id = ${leadId}`);
      } catch (e: any) { console.warn('[amostra] gravar fiscal no lead:', e?.message); }
      const ins: any = await db.execute(sql`INSERT INTO lead_sample_orders
        (lead_id, seller_id, requested_by, requested_by_name, status, items, total_units, total_value, delivery_mode, delivery_date, receiver, objective, return_date, observation, cnpj, company_name, fiscal)
        VALUES (${leadId}, ${lead.assigned_to || (user.role === 'vendedor' ? user.id : null)}, ${user.id}, ${nome(user)}, 'solicitado', ${JSON.stringify(items)}::jsonb, ${totalUnits}, ${totalValue.toFixed(2)},
                ${deliveryMode}, ${dOk(b.deliveryDate)}, ${String(b.receiver || '').slice(0, 120) || null}, ${String(b.objective || '').slice(0, 120) || null}, ${dOk(b.returnDate)}, ${String(b.observation || '').slice(0, 2000) || null},
                ${receitaService.formatarCNPJ(cnpjDig)}, ${fiscal.razaoSocial}, ${JSON.stringify(fiscal)}::jsonb)
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
      // APROVAÇÃO → NF de amostra grátis pelo mesmo caminho do cliente (cadastro em prospecção + card 'amostra' + pipeline)
      if (novo === 'aprovado' && !a.pipeline_item_id) {
        const r2 = await emitirAmostraNoPipeline(a, user);
        if (!r2.ok) return res.status(400).json({ ok: false, message: r2.message });
      }
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
