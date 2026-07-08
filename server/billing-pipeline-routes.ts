import { Express } from 'express';
import { storage } from './storage';
import { nowBrazil } from './brazilTimezone';
import { authenticateUser } from './authMiddleware';
import { INSTANCE_COMPANY_DATA } from './nfe-routes';
import { registrarBoleto } from './bb-boleto-service';
import { createImmediateCharge } from './bb-pix-service';
import { db } from './db';
import { sql, eq, and, gte, isNull } from 'drizzle-orm';
import { fiscalInvoices, salesCards } from '@shared/schema';

const BILLING_STAGES = ['pedido', 'a_faturar', 'faturado', 'impresso', 'aguardando_rota', 'em_rota', 'entregue'] as const;

let internalBillingModeActive = false;
let internalBillingActivatedBy: string | null = null;

export function isInternalBillingModeActive() {
  // Faturamento e SEMPRE pelo pipeline interno (Omie descontinuado para faturamento).
  // Todo pedido com venda registrada entra no pipeline, independente de toggle/Omie.
  return true;
}

// ============ Rede de seguranca: NENHUM pedido pode desaparecer ============
// Registra TODA tentativa de envio ao pipeline (created/skipped/failed) numa tabela imutavel
// (order_pipeline_audit, criada no boot do index.ts). Garante trilha mesmo se a insercao falhar.
async function logOrderAudit(salesCardId: string, outcome: string, error?: string) {
  try {
    await db.execute(sql`INSERT INTO order_pipeline_audit (id, sales_card_id, outcome, error, created_at)
      VALUES (gen_random_uuid(), ${salesCardId}, ${outcome}, ${error || null}, now())`);
  } catch (e) { /* nunca bloqueia o fluxo */ }
}

// Reconciliacao: garante que TODO sales_card com venda registrada (recente) tenha item no pipeline.
// Idempotente. E a rede de seguranca caso o envio ao vivo tenha falhado.
export async function reconcileOrphanOrders(days: number = 7): Promise<{ scanned: number; createdFromNf: number; createdFromCard: number; failed: number }> {
  // REDE DE SEGURANCA (08/jul): NENHUM pedido pode sumir do pipeline.
  // Regra do Flavio: um pedido so pode desaparecer do pipeline se foi CANCELADO antes do faturamento.
  // Portanto reconciliamos tudo que NAO esta cancelado e ficou sem card:
  //   (A) toda NF AUTORIZADA sem card -> cria card 'faturado' (com o numero da NF);
  //   (B) toda venda COMPLETADA (nao cancelada) sem NF e sem card -> cria card 'pedido'.
  // Idempotente: dedup por numero de NF, por sales_card_id e por cliente+valor recente.
  // NAO dispara automacoes (evita WhatsApp em massa retroativo). Cards marcados createdBy 'reconcile-*' (reversivel via remove-reconciled).
  const since = new Date(Date.now() - days * 86400000);
  let scanned = 0, createdFromNf = 0, createdFromCard = 0, failed = 0;

  const existing = await storage.getBillingPipelineItems();
  const haveInv = new Set(existing.map((i: any) => String(i.invoiceNumber || '').replace(/\D/g, '')).filter(Boolean));
  const haveCard = new Set(existing.map((i: any) => i.salesCardId).filter(Boolean));
  const recent = existing.filter((i: any) => i.createdAt && new Date(i.createdAt) >= since);
  const haveCustVal = new Set(recent.map((i: any) => `${i.customerId}|${Math.round(Number(i.saleValue || 0))}`));

  // (A) NFs autorizadas sem card -> 'faturado'
  try {
    const nfs = await db.select().from(fiscalInvoices)
      .where(and(gte(fiscalInvoices.createdAt, since), sql`${fiscalInvoices.status} IN ('authorized','rejected')`));
    for (const nf of nfs as any[]) {
      const num = String(nf.invoiceNumber || '').replace(/\D/g, '');
      if (!num || haveInv.has(num)) continue;
      const cv = `${nf.customerId}|${Math.round(Number(nf.totalInvoice || 0))}`;
      if (haveCustVal.has(cv)) continue; // ja existe card recente do mesmo cliente/valor
      scanned++;
      try {
        const customer = nf.customerId ? await storage.getCustomer(nf.customerId) : null;
        const seller = customer?.sellerId ? await storage.getUser(customer.sellerId) : null;
        await storage.createBillingPipelineItem({
          salesCardId: null,
          customerId: nf.customerId || null,
          customerName: nf.customerName || (customer as any)?.fantasyName || customer?.name || 'Cliente',
          customerDocument: nf.customerCnpjCpf || (customer as any)?.cnpj || (customer as any)?.cpf || null,
          sellerId: customer?.sellerId || null,
          sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
          stage: 'faturado',
          orderNumber: `NF-${nf.invoiceNumber}`,
          saleValue: nf.totalInvoice || null,
          invoiceNumber: `NF-${nf.invoiceNumber}`,
          omieInstanceId: nf.omieInstanceId || null,
          stageHistory: [{ stage: 'faturado', changedAt: (nf.emissionDate ? new Date(nf.emissionDate) : nowBrazil()).toISOString(), changedBy: 'reconcile-nf' }],
          notes: nf.status === 'rejected' ? 'NF REJEITADA na SEFAZ - preencher UF do cliente e re-transmitir (nao re-faturar, evita NF duplicada)' : null,
          createdBy: nf.status === 'rejected' ? 'reconcile-nf-rej' : 'reconcile-nf',
          ...(nf.emissionDate ? { createdAt: new Date(nf.emissionDate) } : {}),
        } as any);
        haveInv.add(num); haveCustVal.add(cv);
        createdFromNf++;
      } catch (e) { failed++; }
    }
  } catch (e) { console.error('[reconcile] parte A (NFs) erro:', (e as any)?.message); }

  // (B) vendas completadas (nao canceladas) sem NF e sem card -> 'pedido'
  try {
    const cards = await db.select().from(salesCards).where(and(
      gte(salesCards.createdAt, since),
      eq(salesCards.status, 'completed'),
      isNull(salesCards.invoiceNumber),
      sql`${salesCards.saleValue} IS NOT NULL AND ${salesCards.saleValue}::numeric > 0`,
    ));
    for (const sc of cards as any[]) {
      if (sc.isPermanent) continue;
      if (haveCard.has(sc.id)) continue;
      const cv = `${sc.customerId}|${Math.round(Number(sc.saleValue || 0))}`;
      if (haveCustVal.has(cv)) continue;
      scanned++;
      try {
        const customer = sc.customerId ? await storage.getCustomer(sc.customerId) : null;
        const seller = sc.sellerId ? await storage.getUser(sc.sellerId) : null;
        let omieInstanceName = '';
        if ((customer as any)?.omieInstanceId) { const inst = await storage.getOmieInstance((customer as any).omieInstanceId); omieInstanceName = (inst as any)?.displayName || ''; }
        await storage.createBillingPipelineItem({
          salesCardId: sc.id,
          customerId: sc.customerId,
          customerName: (customer as any)?.fantasyName || customer?.name || 'Cliente desconhecido',
          customerDocument: (customer as any)?.cnpj || (customer as any)?.cpf || null,
          sellerId: sc.sellerId || null,
          sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
          stage: 'pedido',
          orderNumber: `INT-${String(sc.id).substring(0, 8)}`,
          saleValue: sc.saleValue || null,
          paymentMethod: sc.paymentMethod || null,
          operationType: sc.operationType || null,
          products: (sc.products as any) || null,
          notes: sc.notes || null,
          omieInstanceId: (customer as any)?.omieInstanceId || null,
          omieInstanceName: omieInstanceName || null,
          stageHistory: [{ stage: 'pedido', changedAt: (sc.createdAt ? new Date(sc.createdAt) : nowBrazil()).toISOString(), changedBy: 'reconcile-card' }],
          createdBy: 'reconcile-card',
          ...(sc.createdAt ? { createdAt: new Date(sc.createdAt) } : {}),
        } as any);
        haveCard.add(sc.id); haveCustVal.add(cv);
        await logOrderAudit(sc.id, 'created');
        createdFromCard++;
      } catch (e) { await logOrderAudit(sc.id, 'failed', String((e as any)?.message || e)); failed++; }
    }
  } catch (e) { console.error('[reconcile] parte B (cards) erro:', (e as any)?.message); }

  return { scanned, createdFromNf, createdFromCard, failed };
}

import { fireAutomation } from './automation-engine';

export async function autoSendToBillingPipeline(salesCard: any, createdByEmail: string) {
  if (!isInternalBillingModeActive()) return null;
  // So cria item no pipeline para pedidos com venda registrada (evita cards vazios)
  if (!salesCard.saleValue || parseFloat(String(salesCard.saleValue)) === 0) { await logOrderAudit(salesCard.id, 'skipped_no_sale'); return null; }

  try {
    const existing = await storage.getBillingPipelineItems();
    if (existing.find(i => i.salesCardId === salesCard.id)) { await logOrderAudit(salesCard.id, 'skipped_duplicate'); return null; }

    const customer = salesCard.customerId ? await storage.getCustomer(salesCard.customerId) : null;
    const seller = salesCard.sellerId ? await storage.getUser(salesCard.sellerId) : null;

    let omieInstanceName = '';
    if (customer?.omieInstanceId) {
      const instance = await storage.getOmieInstance(customer.omieInstanceId);
      omieInstanceName = instance?.displayName || '';
    }

    const item = await storage.createBillingPipelineItem({
      salesCardId: salesCard.id,
      customerId: salesCard.customerId,
      customerName: customer?.fantasyName || customer?.name || 'Cliente desconhecido',
      customerDocument: customer?.cnpj || customer?.cpf || null,
      sellerId: salesCard.sellerId || null,
      sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
      stage: 'pedido',
      orderNumber: `INT-${salesCard.id.substring(0, 8)}`,
      saleValue: salesCard.saleValue || null,
      paymentMethod: salesCard.paymentMethod || null,
      operationType: salesCard.operationType || null,
      products: salesCard.products as any || null,
      notes: salesCard.notes || null,
      omieInstanceId: customer?.omieInstanceId || null,
      omieInstanceName: omieInstanceName || null,
      stageHistory: [{
        stage: 'pedido',
        changedAt: (salesCard.createdAt ? new Date(salesCard.createdAt) : nowBrazil()).toISOString(),
        changedBy: `auto (${internalBillingActivatedBy || createdByEmail})`
      }],
      createdBy: `auto (${internalBillingActivatedBy || createdByEmail})`,
      // DATA DE REGISTRO do pedido = quando o vendedor registrou (createdAt do sales_card), nao a hora da reconciliacao
      ...(salesCard.createdAt ? { createdAt: new Date(salesCard.createdAt) } : {}),
    });

    await logOrderAudit(salesCard.id, 'created');
    console.log(`✅ [BILLING-PIPELINE] Pedido ${salesCard.id} auto-enviado para faturamento interno (modo ativo)`);
    // Automacao: pedido.criado (fire-and-forget)
    void fireAutomation('pedido.criado', {
      customer: { name: customer?.fantasyName || customer?.name || 'Cliente' },
      order: { id: item.orderNumber, value: (Number(salesCard.saleValue) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) },
      seller: { name: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : '' },
      sellerPhone: (seller as any)?.phone || null,
    });
    return item;
  } catch (error) {
    await logOrderAudit(salesCard.id, 'failed', String((error as any)?.message || error));
    console.error(`❌ [BILLING-PIPELINE] Erro ao auto-enviar pedido:`, error);
    return null;
  }
}

function isAdminOnly(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user || !['admin', 'coordinator', 'administrative'].includes(user.role)) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
}

function isFlavioOnly(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user || user.email !== 'flavio@bebahonest.com.br') {
    return res.status(403).json({ message: 'Apenas FLAVIO pode realizar esta ação' });
  }
  next();
}

export function registerBillingPipelineRoutes(app: Express) {

  // Remove os itens criados pela reconciliacao (pedidos fantasmas: ja faturados/entregues no 1.0)
  app.post('/api/admin/pipeline/remove-reconciled', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const r: any = await db.execute(sql`DELETE FROM billing_pipeline WHERE created_by ILIKE '%reconcile%'`);
      res.json({ ok: true, removed: r?.rowCount ?? null });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Corrige a DATA DE CRIACAO dos itens ja reconciliados: usar a data de registro do pedido (sales_card.created_at)
  app.post('/api/admin/pipeline/fix-registration-dates', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const r: any = await db.execute(sql`
        UPDATE billing_pipeline bp
        SET created_at = sc.created_at
        FROM sales_cards sc
        WHERE bp.sales_card_id = sc.id
          AND sc.created_at IS NOT NULL
          AND bp.created_by ILIKE '%reconcile%'`);
      res.json({ ok: true, updated: r?.rowCount ?? null });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Rede de seguranca: reconciliar pedidos orfaos (com venda, sem item no pipeline)
  app.post('/api/admin/pipeline/reconcile-orphans', authenticateUser, isAdminOnly, async (req: any, res) => {
    try { const days = Number(req.body?.days) || 7; const r = await reconcileOrphanOrders(days); res.json({ ok: true, ...r }); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Forcar criacao de card 'faturado' p/ NFs ESPECIFICAS (sem dedup cliente+valor).
  // Recupera NF rejeitada/orfa que a rede de seguranca pulou por dedup. So evita duplicar pelo NUMERO exato da NF.
  app.post('/api/admin/pipeline/create-cards-for-nfs', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const numbers = (req.body?.numbers || []).map((n: any) => String(n).replace(/\D/g, '')).filter(Boolean);
      if (!numbers.length) return res.status(400).json({ error: 'informe numbers[]' });
      const existing = await storage.getBillingPipelineItems();
      const haveInv = new Set(existing.map((i: any) => String(i.invoiceNumber || '').replace(/\D/g, '')).filter(Boolean));
      let created = 0, skipped = 0; const errs: string[] = [];
      for (const num of numbers) {
        if (haveInv.has(num)) { skipped++; continue; }
        try {
          const rows: any = await db.select().from(fiscalInvoices).where(sql`${fiscalInvoices.invoiceNumber}::text = ${num}`).limit(1);
          const nf = rows?.[0];
          if (!nf) { errs.push(`NF ${num} nao encontrada`); continue; }
          const customer = nf.customerId ? await storage.getCustomer(nf.customerId) : null;
          const seller = (customer as any)?.sellerId ? await storage.getUser((customer as any).sellerId) : null;
          await storage.createBillingPipelineItem({
            salesCardId: null,
            customerId: nf.customerId || null,
            customerName: nf.customerName || (customer as any)?.fantasyName || (customer as any)?.name || 'Cliente',
            customerDocument: nf.customerCnpjCpf || (customer as any)?.cnpj || (customer as any)?.cpf || null,
            sellerId: (customer as any)?.sellerId || null,
            sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
            stage: 'faturado',
            orderNumber: `NF-${nf.invoiceNumber}`,
            saleValue: nf.totalInvoice || null,
            invoiceNumber: `NF-${nf.invoiceNumber}`,
            omieInstanceId: nf.omieInstanceId || null,
            notes: nf.status === 'rejected' ? 'NF REJEITADA na SEFAZ - preencher UF do cliente e re-transmitir (nao re-faturar, evita NF duplicada)' : null,
            stageHistory: [{ stage: 'faturado', changedAt: (nf.emissionDate ? new Date(nf.emissionDate) : nowBrazil()).toISOString(), changedBy: 'create-card-manual' }],
            createdBy: nf.status === 'rejected' ? 'reconcile-nf-rej' : 'reconcile-nf',
            ...(nf.emissionDate ? { createdAt: new Date(nf.emissionDate) } : {}),
          } as any);
          haveInv.add(num); created++;
        } catch (e: any) { errs.push(`${num}: ${e?.message || e}`); }
      }
      res.json({ ok: true, created, skipped, errs });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  // Monitor: quantos orfaos nos ultimos N dias + resumo da auditoria
  app.get('/api/admin/pipeline/orphans-status', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const days = Number(req.query?.days) || 7;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const o: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM sales_cards sc LEFT JOIN billing_pipeline bp ON bp.sales_card_id = sc.id WHERE bp.id IS NULL AND sc.sale_value IS NOT NULL AND sc.sale_value::numeric > 0 AND sc.created_at >= ${since}`);
      const a: any = await db.execute(sql`SELECT outcome, COUNT(*)::int AS n FROM order_pipeline_audit WHERE created_at >= ${since} GROUP BY outcome ORDER BY n DESC`);
      res.json({ days, orphans: o.rows?.[0]?.n ?? null, audit: a.rows });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Get internal billing mode status
  app.get('/api/billing-pipeline/mode', authenticateUser, isAdminOnly, async (req: any, res) => {
    res.json({ active: internalBillingModeActive, activatedBy: internalBillingActivatedBy });
  });

  // FLAVIO-ONLY: Toggle internal billing mode ON/OFF
  app.post('/api/billing-pipeline/mode', authenticateUser, isFlavioOnly, async (req: any, res) => {
    const { active } = req.body;
    const user = req.currentUser || req.user;
    internalBillingModeActive = !!active;
    internalBillingActivatedBy = active ? user.email : null;
    console.log(`🔄 [BILLING-PIPELINE] Modo faturamento interno ${internalBillingModeActive ? 'ATIVADO' : 'DESATIVADO'} por ${user.email}`);
    res.json({ active: internalBillingModeActive, activatedBy: internalBillingActivatedBy });
  });

  // Get all billing pipeline items (optionally filter by stage)
  app.get('/api/billing-pipeline', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const stage = req.query.stage as string | undefined;
      const items = await storage.getBillingPipelineItems(stage ? { stage } : undefined);
      res.json(items);
    } catch (error: any) {
      console.error('❌ [BILLING-PIPELINE] Error fetching items:', error);
      res.status(500).json({ message: error.message });
    }
  });

  // Get single billing pipeline item
  app.get('/api/billing-pipeline/:id', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const item = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ message: 'Item não encontrado' });
      res.json(item);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // FLAVIO-ONLY: Bypass order from Omie to internal billing pipeline
  app.post('/api/billing-pipeline/bypass', authenticateUser, isFlavioOnly, async (req: any, res) => {
    try {
      const { salesCardId } = req.body;
      if (!salesCardId) {
        return res.status(400).json({ message: 'salesCardId é obrigatório' });
      }

      const card = await storage.getSalesCard(salesCardId);
      if (!card) {
        return res.status(404).json({ message: 'Pedido não encontrado' });
      }

      const existing = await storage.getBillingPipelineItems();
      const alreadyExists = existing.find(i => i.salesCardId === salesCardId);
      if (alreadyExists) {
        return res.status(409).json({ message: 'Pedido já está no pipeline de faturamento', item: alreadyExists });
      }

      const user = req.currentUser || req.user;
      const customer = card.customerId ? await storage.getCustomer(card.customerId) : null;
      const seller = card.sellerId ? await storage.getUser(card.sellerId) : null;

      let omieInstanceName = '';
      if (customer?.omieInstanceId) {
        const instance = await storage.getOmieInstance(customer.omieInstanceId);
        omieInstanceName = instance?.displayName || '';
      }

      const item = await storage.createBillingPipelineItem({
        salesCardId,
        customerId: card.customerId,
        customerName: customer?.fantasyName || customer?.name || 'Cliente desconhecido',
        customerDocument: customer?.cnpj || customer?.cpf || null,
        sellerId: card.sellerId || null,
        sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
        stage: 'pedido',
        orderNumber: card.omieOrderId ? `WEB-${card.id.substring(0, 8)}` : null,
        saleValue: card.saleValue || null,
        paymentMethod: card.paymentMethod || null,
        operationType: card.operationType || null,
        products: card.products as any || null,
        notes: card.notes || null,
        omieInstanceId: customer?.omieInstanceId || null,
        omieInstanceName: omieInstanceName || null,
        stageHistory: [{
          stage: 'pedido',
          changedAt: nowBrazil().toISOString(),
          changedBy: user.email
        }],
        createdBy: user.email,
      });

      console.log(`✅ [BILLING-PIPELINE] Pedido ${salesCardId} bypassed para faturamento interno por ${user.email}`);

      res.json({ success: true, item });
    } catch (error: any) {
      console.error('❌ [BILLING-PIPELINE] Bypass error:', error);
      res.status(500).json({ message: error.message });
    }
  });

  // Move item to next/specific stage
  app.patch('/api/billing-pipeline/:id/stage', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const { stage } = req.body;
      if (!stage || !BILLING_STAGES.includes(stage)) {
        return res.status(400).json({ message: `Stage inválido. Valores aceitos: ${BILLING_STAGES.join(', ')}` });
      }

      const item = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ message: 'Item não encontrado' });

      const user = req.currentUser || req.user;
      const history = (item.stageHistory as any[]) || [];
      history.push({
        stage,
        changedAt: nowBrazil().toISOString(),
        changedBy: user.email
      });

      let invoiceNumber = item.invoiceNumber;
      let fiscalInvoiceId: string | null = null;

      if (stage === 'faturado' && item.stage !== 'faturado') {
        const stockCheck = await validateStockForBilling(item);
        if (!stockCheck.valid) {
          const shortageDetails = stockCheck.shortages.map(s =>
            `• ${s.productName}: necessário ${s.required}, disponível ${s.available}`
          ).join('\n');
          console.log(`🚫 [BILLING-PIPELINE] Faturamento bloqueado para item ${req.params.id} - estoque insuficiente`);
          return res.status(400).json({
            message: 'Faturamento bloqueado: estoque insuficiente',
            stockError: true,
            shortages: stockCheck.shortages,
            details: `Os seguintes produtos não possuem estoque suficiente para faturamento:\n${shortageDetails}`,
          });
        }

        let lotMap: Record<string, string[]> = {};
        try {
          lotMap = await deductStockForBilling(item, user);
          console.log(`📦 [BILLING-PIPELINE] Baixa de estoque realizada para item ${req.params.id}`);
        } catch (stockError: any) {
          console.error(`❌ [BILLING-PIPELINE] Erro ao dar baixa no estoque:`, stockError.message);
        }

        try {
          const invoiceResult = await createInvoiceFromPipelineItem(item, user, lotMap);
          if (invoiceResult) {
            invoiceNumber = `NF-${invoiceResult.invoiceNumber}`;
            fiscalInvoiceId = invoiceResult.id;
            console.log(`📄 [BILLING-PIPELINE] NF-e #${invoiceResult.invoiceNumber} criada automaticamente para item ${req.params.id}`);
          }
        } catch (invoiceError: any) {
          console.error(`❌ [BILLING-PIPELINE] Erro ao criar NF-e automática:`, invoiceError.message);
        }

        try {
          await createReceivableFromPipelineItem(item, fiscalInvoiceId, user);
          console.log(`💰 [BILLING-PIPELINE] Conta a receber criada para item ${req.params.id}`);
        } catch (recError: any) {
          console.error(`❌ [BILLING-PIPELINE] Erro ao criar conta a receber:`, recError.message);
        }
      }

      const updateData: any = { stage, stageHistory: history };
      if (invoiceNumber) updateData.invoiceNumber = invoiceNumber;

      const updated = await storage.updateBillingPipelineItem(req.params.id, updateData);

      console.log(`📦 [BILLING-PIPELINE] Item ${req.params.id} movido para ${stage} por ${user.email}`);
      res.json({ ...updated, fiscalInvoiceId });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Update item details (notes, invoice number, etc.)
  app.patch('/api/billing-pipeline/:id', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const { notes, invoiceNumber } = req.body;
      const updates: any = {};
      if (notes !== undefined) updates.notes = notes;
      if (invoiceNumber !== undefined) updates.invoiceNumber = invoiceNumber;

      const updated = await storage.updateBillingPipelineItem(req.params.id, updates);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Delete item from pipeline
  app.delete('/api/billing-pipeline/:id', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      await storage.deleteBillingPipelineItem(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Batch move items to a stage
  app.post('/api/billing-pipeline/batch/stage', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const { ids, stage } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'ids é obrigatório (array)' });
      }
      if (!stage || !BILLING_STAGES.includes(stage)) {
        return res.status(400).json({ message: `Stage inválido. Valores aceitos: ${BILLING_STAGES.join(', ')}` });
      }

      const user = req.currentUser || req.user;
      const results: Array<{ id: string; success: boolean; fiscalInvoiceId?: string; error?: string }> = [];

      for (const id of ids) {
        try {
          const item = await storage.getBillingPipelineItem(id);
          if (!item) {
            results.push({ id, success: false, error: 'Item não encontrado' });
            continue;
          }

          const history = (item.stageHistory as any[]) || [];
          history.push({
            stage,
            changedAt: nowBrazil().toISOString(),
            changedBy: user.email
          });

          let invoiceNumber = item.invoiceNumber;
          let fiscalInvoiceId: string | undefined;

          if (stage === 'faturado' && item.stage !== 'faturado') {
            let lotMap: Record<string, string[]> = {};
            try {
              lotMap = await deductStockForBilling(item, user);
            } catch (stockError: any) {
              console.error(`❌ [BATCH] Erro baixa estoque para ${id}:`, stockError.message);
            }

            try {
              const invoiceResult = await createInvoiceFromPipelineItem(item, user, lotMap);
              if (invoiceResult) {
                invoiceNumber = `NF-${invoiceResult.invoiceNumber}`;
                fiscalInvoiceId = invoiceResult.id;
              }
            } catch (invoiceError: any) {
              console.error(`❌ [BATCH] Erro NF-e para ${id}:`, invoiceError.message);
            }

            try {
              await createReceivableFromPipelineItem(item, fiscalInvoiceId || null, user);
            } catch (recError: any) {
              console.error(`❌ [BATCH] Erro conta a receber para ${id}:`, recError.message);
            }
          }

          const updateData: any = { stage, stageHistory: history };
          if (invoiceNumber) updateData.invoiceNumber = invoiceNumber;

          await storage.updateBillingPipelineItem(id, updateData);
          results.push({ id, success: true, fiscalInvoiceId });
        } catch (err: any) {
          results.push({ id, success: false, error: err.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      console.log(`📦 [BATCH] ${successCount}/${ids.length} itens movidos para ${stage} por ${user.email}`);
      res.json({ results, successCount, totalCount: ids.length });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Batch delete items
  app.post('/api/billing-pipeline/batch/delete', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'ids é obrigatório (array)' });
      }

      let successCount = 0;
      for (const id of ids) {
        try {
          await storage.deleteBillingPipelineItem(id);
          successCount++;
        } catch (err: any) {
          console.error(`❌ [BATCH-DELETE] Erro ao remover ${id}:`, err.message);
        }
      }

      const user = req.currentUser || req.user;
      console.log(`🗑️ [BATCH] ${successCount}/${ids.length} itens removidos por ${user?.email}`);
      res.json({ successCount, totalCount: ids.length });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
}

async function validateStockForBilling(item: any): Promise<{ valid: boolean; shortages: Array<{ productId: string; productName: string; required: number; available: number }> }> {
  const products = item.products as Array<{ id?: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  if (!products || products.length === 0) return { valid: true, shortages: [] };

  const instanceId = item.omieInstanceId;
  if (!instanceId) return { valid: true, shortages: [] };

  const shortages: Array<{ productId: string; productName: string; required: number; available: number }> = [];

  for (const product of products) {
    if (!product.id) continue;

    const lots = await storage.getInventoryLots({
      productId: product.id,
      instanceId,
      stockType: 'in_use',
      isActive: true,
    });

    let totalAvailable = 0;
    for (const lot of lots) {
      const qty = parseFloat(lot.quantity?.toString() || '0');
      if (qty > 0) totalAvailable += qty;
    }

    if (totalAvailable < product.quantity) {
      shortages.push({
        productId: product.id,
        productName: product.name,
        required: product.quantity,
        available: totalAvailable,
      });
    }
  }

  return { valid: shortages.length === 0, shortages };
}

async function deductStockForBilling(item: any, user: any): Promise<Record<string, string[]>> {
  const lotMap: Record<string, string[]> = {};
  const products = item.products as Array<{ id?: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  if (!products || products.length === 0) return lotMap;

  const instanceId = item.omieInstanceId;
  if (!instanceId) {
    console.log(`⚠️ [STOCK] Item ${item.id} sem omieInstanceId, não é possível dar baixa no estoque`);
    return lotMap;
  }

  for (const product of products) {
    if (!product.id) continue;

    const lots = await storage.getInventoryLots({
      productId: product.id,
      instanceId,
      stockType: 'in_use',
      isActive: true,
    });

    if (lots.length === 0) {
      console.log(`⚠️ [STOCK] Produto ${product.name} (${product.id}) sem lotes disponíveis na instância ${instanceId}`);
      continue;
    }

    let remaining = product.quantity;
    const consumedLots: string[] = [];

    for (const lot of lots) {
      if (remaining <= 0) break;

      const currentQty = parseFloat(lot.quantity?.toString() || '0');
      if (currentQty <= 0) continue;

      const deductQty = Math.min(remaining, currentQty);
      const newQty = currentQty - deductQty;

      await storage.updateInventoryLot(lot.id, {
        quantity: newQty.toFixed(4),
      });

      await storage.createInventoryMovement({
        lotId: lot.id,
        productId: product.id,
        instanceId,
        movementType: 'consume',
        quantity: deductQty.toFixed(4),
        previousQuantity: currentQty.toFixed(4),
        newQuantity: newQty.toFixed(4),
        sourceType: 'invoice',
        sourceId: item.id,
        lotNumber: lot.lotNumber,
        notes: `Baixa automática - Faturamento ${item.orderNumber || item.salesCardId} - ${product.name}`,
        createdBy: user?.email || null,
      });

      if (lot.lotNumber) {
        consumedLots.push(lot.lotNumber);
      }

      remaining -= deductQty;
      console.log(`📦 [STOCK] Baixa: ${deductQty} un de "${product.name}" do lote ${lot.lotNumber} (${currentQty} → ${newQty})`);
    }

    if (consumedLots.length > 0) {
      lotMap[product.id] = consumedLots;
    }

    if (remaining > 0) {
      console.log(`⚠️ [STOCK] Estoque insuficiente: faltam ${remaining} un de "${product.name}" na instância ${instanceId}`);
    }
  }

  return lotMap;
}

async function createInvoiceFromPipelineItem(item: any, user: any, lotMap?: Record<string, string[]>) {
  const customer = item.customerId ? await storage.getCustomer(item.customerId) : null;

  let issuerName = '', issuerCnpj = '', issuerIe = '', issuerAddress = '', issuerUf = '', issuerCityCode = '', issuerCity = '', issuerPhone = '';

  if (item.omieInstanceId) {
    const instance = await storage.getOmieInstance(item.omieInstanceId);
    if (instance && INSTANCE_COMPANY_DATA[instance.name]) {
      const cd = INSTANCE_COMPANY_DATA[instance.name];
      issuerName = cd.name;
      issuerCnpj = cd.cnpj;
      issuerIe = cd.ie;
      issuerAddress = cd.address;
      issuerUf = cd.uf;
      issuerCityCode = cd.cityCode;
      issuerCity = cd.city;
      issuerPhone = cd.phone;
    }
  }

  if (!issuerName) {
    const cd = INSTANCE_COMPANY_DATA['GYN'];
    issuerName = cd.name;
    issuerCnpj = cd.cnpj;
    issuerIe = cd.ie;
    issuerAddress = cd.address;
    issuerUf = cd.uf;
    issuerCityCode = cd.cityCode;
    issuerCity = cd.city;
    issuerPhone = cd.phone;
  }

  const customerUf = customer?.state || 'GO';
  const isWithinState = issuerUf === customerUf;
  const operationType = item.operationType || 'venda';

  let cfop = isWithinState ? '5102' : '6102';
  let natureOfOperation = 'Venda de mercadoria';
  if (operationType === 'bonificacao') {
    cfop = isWithinState ? '5910' : '6910';
    natureOfOperation = 'Bonificação';
  } else if (operationType === 'troca') {
    cfop = isWithinState ? '5949' : '6949';
    natureOfOperation = 'Troca de mercadoria';
  } else if (operationType === 'amostra') {
    cfop = isWithinState ? '5911' : '6911';
    natureOfOperation = 'Amostra grátis';
  }

  const totalValue = item.saleValue ? parseFloat(item.saleValue) : 0;
  const nextNumber = await storage.getNextInvoiceNumber('1', issuerCnpj);

  // Ambiente de emissao POR CNPJ EMITENTE (system_settings fiscal_env_<instanceId>).
  // ANTES estava fixo 'homologacao' -> NF do pipeline saia SEM VALOR FISCAL mesmo com o CNPJ em producao.
  // Resolve a instancia pelo omieInstanceId do item ou, se vazio, pelo CNPJ do emitente
  // (quando o cliente nao tem instancia, o emitente cai no fallback GYN). Default homologacao.
  let invEnv: 'homologacao' | 'producao' = 'homologacao';
  try {
    const __settings = await storage.getSystemSettings();
    const __instances = await storage.getOmieInstances();
    const __issuerDigits = String(issuerCnpj || '').replace(/\D/g, '');
    let __inst: any = item.omieInstanceId ? __instances.find((i: any) => i.id === item.omieInstanceId) : null;
    if (!__inst) __inst = __instances.find((i: any) => String(i.cnpj || '').replace(/\D/g, '') === __issuerDigits);
    const __v = __inst ? (__settings || []).find((x: any) => x.key === 'fiscal_env_' + __inst.id)?.value : null;
    if (__v && String(__v).replace(/\"/g, '') === 'producao') invEnv = 'producao';
  } catch {}

  const invoice = await storage.createFiscalInvoice({
    invoiceNumber: nextNumber,
    series: '1',
    status: 'draft',
    operationType: 'saida',
    issuerName,
    issuerCnpj,
    issuerIe,
    issuerAddress,
    issuerUf,
    issuerCityCode,
    issuerCity,
    issuerPhone,
    customerId: item.customerId || null,
    customerName: item.customerName || '',
    customerCnpjCpf: item.customerDocument || customer?.cnpj || customer?.cpf || '',
    customerIe: (customer as any)?.stateRegistration || (customer as any)?.state_registration || (customer as any)?.ie || '',
    customerAddress: customer?.address || '',
    customerBairro: customer?.neighborhood || '',
    customerCep: customer?.zipCode || '',
    customerCity: customer?.city || '',
    customerUf: customer?.state || '',
    customerPhone: customer?.phone || '',
    natureOfOperation,
    cfop,
    totalProducts: totalValue.toFixed(2),
    totalInvoice: totalValue.toFixed(2),
    paymentMethod: item.paymentMethod || 'a_vista',
    notes: `Pedido pipeline interno - ${item.orderNumber || item.salesCardId}`,
    emissionDate: nowBrazil(),
    environment: invEnv,
    omieInstanceId: item.omieInstanceId || null,
    createdBy: user?.email || null,
  });

  // CSOSN do cliente (Simples): padrao '102'; '101' se marcado no cadastro. pCredSN (p/ 101) vem de system_settings 'fiscal_pcredsn'.
  const custCsosn = ((customer as any)?.icmsCsosn === '101') ? '101' : '102';
  let custPcred = '0';
  if (custCsosn === '101') {
    try {
      const settings = await storage.getSystemSettings();
      const v = (settings || []).find((x: any) => x.key === 'fiscal_pcredsn')?.value;
      if (v) custPcred = String(v).replace(/"/g, '');
    } catch {}
  }

  const products = item.products as Array<{ id?: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  if (products && products.length > 0) {
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      let productCode = `PROD-${i + 1}`;
      if (p.id) {
        const productData = await storage.getProduct(p.id);
        if (productData) {
          productCode = (productData as any).omieCode || (productData as any).omieCodigo || `PROD-${i + 1}`;
        }
      }
      let productName = p.name;
      if (lotMap && p.id && lotMap[p.id] && lotMap[p.id].length > 0) {
        const lotNumbers = lotMap[p.id].join(', ');
        productName = `${p.name} - Lote: ${lotNumbers}`;
      }
      await storage.createFiscalInvoiceItem({
        invoiceId: invoice.id,
        itemNumber: i + 1,
        productName,
        productCode,
        productId: p.id || null,
        ncm: '22029000',
        cfop,
        unit: 'UN',
        quantity: p.quantity.toString(),
        unitPrice: p.unitPrice.toString(),
        totalPrice: p.totalPrice.toString(),
        discount: '0',
        csosn: custCsosn,
        aliqIcms: custPcred,
      });
    }
  }

  await storage.createFiscalInvoiceEvent({
    invoiceId: invoice.id,
    eventType: 'criacao',
    status: 'success',
    description: `NF-e #${nextNumber} criada automaticamente via pipeline de faturamento interno`,
    createdBy: user?.email || null,
  });

  // AUTO-EMISSAO: transmite a NF-e para a SEFAZ (autoriza) logo apos criar o rascunho.
  // Sem isto a NF fica em 'draft' (Rascunho) e NAO tem valor fiscal. Robusto: falha nao bloqueia
  // o faturamento (a NF fica em rascunho e pode ser transmitida manualmente pelo botao Transmitir).
  try {
    const { sefazService } = await import('./sefaz-service.js');
    const emitRes = await sefazService.emitNfe(invoice.id);
    if (emitRes?.success) {
      console.log(`[NFE-AUTO] NF-e #${nextNumber} AUTORIZADA automaticamente (${invEnv})`);
    } else {
      console.warn(`[NFE-AUTO] NF-e #${nextNumber} nao autorizada (fica em rascunho): ${emitRes?.errorCode || ''} ${emitRes?.errorMessage || ''}`);
    }
  } catch (e: any) {
    console.warn(`[NFE-AUTO] erro ao transmitir NF-e #${nextNumber} (fica em rascunho):`, e?.message);
  }

  return invoice;
}


// Hook boleto BB: gera boleto p/ um recebivel de faturamento.
// Gated por bbBoletoEnabled na conta financeira; default HOMOLOGACAO (BB_BOLETO_SANDBOX).
// Fire-and-forget: nunca lanca, nunca bloqueia o faturamento.
export async function generateBoletoForReceivable(receivable: any, item: any): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  try {
    // [06/jul] SERV (PURO SERVIÇOS, CNPJ ...0105) NÃO emite boleto por decisão — não cair no fallback do IND.
    // GYN e BSB seguem no fallback do IND (intencional). Guard robusto a tag ("SERV") ou UUID da instância.
    try {
      const _ref = String(item.omieInstanceId || '');
      const _nm = String(item.omieInstanceName || '').toUpperCase();
      let _serv = _nm === 'SERV' || _ref.toUpperCase() === 'SERV';
      if (!_serv && _ref && /^[0-9a-f-]{30,}$/i.test(_ref)) {
        const _inst = await storage.getOmieInstance(_ref);
        const _c = String((_inst as any)?.cnpj || '').replace(/\D/g, '');
        if (_c === '52921727000105' || String((_inst as any)?.name || '').toUpperCase() === 'SERV') _serv = true;
      }
      if (_serv) { console.log('[BB-BOLETO] SERV nao emite boleto (decisao 06/jul) - skip'); return { ok: false, skipped: true }; }
    } catch {}
    let accounts = await storage.getFinancialAccounts(item.omieInstanceId || undefined);
    let account = (accounts || []).find((a: any) => a.bbBoletoEnabled && a.bbConvenio);
    if (!account) {
      const all = await storage.getFinancialAccounts();
      account = (all || []).find((a: any) => a.bbBoletoEnabled && a.bbConvenio);
    }
    if (!account) return { ok: false, skipped: true }; // nenhuma conta com boleto BB habilitado -> no-op silencioso
    let customer: any = null;
    try { if (item.customerId) customer = await storage.getCustomer(item.customerId); } catch {}
    const r = await registrarBoleto(account.id, {
      amount: parseFloat(receivable.amount),
      dueDate: receivable.dueDate ? new Date(receivable.dueDate) : new Date(Date.now() + 30 * 864e5),
      debtorName: receivable.customerName || customer?.name || 'Cliente',
      debtorDocument: receivable.customerDocument || customer?.cnpj || customer?.cpf || '',
      debtorAddress: customer?.address,
      debtorCity: customer?.city,
      debtorNeighborhood: customer?.neighborhood,
      debtorState: customer?.state,
      debtorZip: customer?.zipCode,
      receivableId: receivable.id,
      fiscalInvoiceId: receivable.fiscalInvoiceId,
      customerId: receivable.customerId,
      billingPipelineId: item.id,
    });
    if (r.success) console.log(`[BB-BOLETO] hook: boleto gerado p/ receivable ${receivable.id} (${r.sandbox ? 'homolog' : 'PRODUCAO'})`);
    else console.warn(`[BB-BOLETO] hook: nao gerou boleto (${r.error})`);
    return r.success ? { ok: true } : { ok: false, error: r.error };
  } catch (e: any) {
    console.warn('[BB-BOLETO] hook erro (ignorado):', e?.message);
    return { ok: false, error: e?.message || String(e) };
  }
}

// Hook PIX BB: gera cobranca PIX para um recebivel de faturamento (forma pix ou a vista).
// Gated por bbPixEnabled+pixKey na conta; fire-and-forget: nunca lanca, nunca bloqueia o faturamento.
export async function generatePixForReceivable(receivable: any, item: any): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  try {
    // [06/jul] SERV (PURO SERVIÇOS, CNPJ ...0105) NÃO emite PIX por decisão — não cair no fallback do IND.
    // GYN e BSB seguem no fallback do IND (intencional). Guard robusto a tag ("SERV") ou UUID da instância.
    try {
      const _ref = String(item.omieInstanceId || '');
      const _nm = String(item.omieInstanceName || '').toUpperCase();
      let _serv = _nm === 'SERV' || _ref.toUpperCase() === 'SERV';
      if (!_serv && _ref && /^[0-9a-f-]{30,}$/i.test(_ref)) {
        const _inst = await storage.getOmieInstance(_ref);
        const _c = String((_inst as any)?.cnpj || '').replace(/\D/g, '');
        if (_c === '52921727000105' || String((_inst as any)?.name || '').toUpperCase() === 'SERV') _serv = true;
      }
      if (_serv) { console.log('[BB-PIX] SERV nao emite PIX (decisao 06/jul) - skip'); return { ok: false, skipped: true }; }
    } catch {}
    let accounts = await storage.getFinancialAccounts(item.omieInstanceId || undefined);
    let account = (accounts || []).find((a: any) => a.bbPixEnabled && a.pixKey);
    if (!account) {
      const all = await storage.getFinancialAccounts();
      account = (all || []).find((a: any) => a.bbPixEnabled && a.pixKey);
    }
    if (!account) return { ok: false, skipped: true }; // nenhuma conta com PIX BB habilitado -> no-op silencioso
    let customer: any = null;
    try { if (item.customerId) customer = await storage.getCustomer(item.customerId); } catch {}
    const r = await createImmediateCharge(account.id, {
      amount: parseFloat(receivable.amount),
      debtorName: receivable.customerName || customer?.name || 'Cliente',
      debtorDocument: receivable.customerDocument || customer?.cnpj || customer?.cpf || undefined,
      description: `Pedido ${item.orderNumber || item.salesCardId || ''}`.trim(),
      expirationSeconds: Math.max(3600, Math.round((new Date(receivable.dueDate).getTime() - Date.now()) / 1000)), // ate o vencimento
      receivableId: receivable.id,
      customerId: receivable.customerId || undefined,
      createdBy: 'auto-faturamento',
    });
    if (r) console.log(`[BB-PIX] hook: cobranca PIX gerada p/ receivable ${receivable.id} (txid ${r.txid})`);
    return r ? { ok: true } : { ok: false, error: 'sem retorno do PIX' };
  } catch (e: any) {
    console.warn('[BB-PIX] hook erro (ignorado):', e?.message);
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function createReceivableFromPipelineItem(item: any, fiscalInvoiceId: string | null, user: any) {
  const totalValue = item.saleValue ? parseFloat(item.saleValue) : 0;
  if (totalValue <= 0) return null;

  const now = nowBrazil();

  // Vencimento por PRAZO: se o cliente tem condicao cadastrada (forma+prazo), usa AMBOS
  // do cadastro; senao usa a forma da venda + default (pix=5, boleto=7, a vista=0).
  let custCond: any = null;
  try { if (item.customerId) custCond = await storage.getCustomer(item.customerId); } catch {}
  const hasCadastro = !!(custCond && custCond.paymentMethod);
  const effForma = hasCadastro ? String(custCond.paymentMethod) : String(item.paymentMethod || 'a_vista');
  const defaultDays = (fm: string) => (fm === 'pix' ? 5 : fm === 'boleto' ? 7 : 0);
  const prazoDaysRaw = (hasCadastro && custCond.boletoDays != null) ? Number(custCond.boletoDays) : defaultDays(effForma);
  const prazoDays = isNaN(prazoDaysRaw) ? 0 : prazoDaysRaw;
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + prazoDays);

  const methodMap: Record<string, string> = { 'a_vista': 'dinheiro', 'dinheiro': 'dinheiro', 'boleto': 'boleto', 'pix': 'pix' };
  const paymentMethod: string | null = methodMap[effForma] || 'outros';

  const receivable = await storage.createReceivable({
    titleNumber: item.invoiceNumber || `TIT-${item.salesCardId?.substring(0, 8)}`,
    customerId: item.customerId || null,
    customerName: item.customerName || 'Cliente',
    customerDocument: item.customerDocument || null,
    description: `Faturamento pipeline - ${item.orderNumber || item.salesCardId}`,
    issueDate: now,
    dueDate: dueDate,
    amount: totalValue.toFixed(2),
    amountPaid: '0',
    status: 'a_vencer',
    paymentMethod: paymentMethod as any,
    fiscalInvoiceId: fiscalInvoiceId,
    billingPipelineId: item.id,
    salesCardId: item.salesCardId || null,
    omieInstanceId: item.omieInstanceId || null,
    createdBy: user?.email || null,
  });

  if (effForma === 'boleto') {
    void generateBoletoForReceivable(receivable, item);
  } else if (effForma === 'pix' || effForma === 'a_vista' || effForma === 'dinheiro') {
    void generatePixForReceivable(receivable, item);
  }

  return receivable;
}
