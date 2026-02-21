import { Express } from 'express';
import { storage } from './storage';
import { nowBrazil } from './brazilTimezone';
import { authenticateUser } from './authMiddleware';
import { INSTANCE_COMPANY_DATA } from './nfe-routes';

const BILLING_STAGES = ['pedido', 'a_faturar', 'faturado', 'impresso', 'aguardando_rota', 'em_rota', 'entregue'] as const;

let internalBillingModeActive = false;
let internalBillingActivatedBy: string | null = null;

export function isInternalBillingModeActive() {
  return internalBillingModeActive;
}

export async function autoSendToBillingPipeline(salesCard: any, createdByEmail: string) {
  if (!internalBillingModeActive) return null;

  try {
    const existing = await storage.getBillingPipelineItems();
    if (existing.find(i => i.salesCardId === salesCard.id)) return null;

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
        changedAt: nowBrazil().toISOString(),
        changedBy: `auto (${internalBillingActivatedBy || createdByEmail})`
      }],
      createdBy: `auto (${internalBillingActivatedBy || createdByEmail})`,
    });

    console.log(`✅ [BILLING-PIPELINE] Pedido ${salesCard.id} auto-enviado para faturamento interno (modo ativo)`);
    return item;
  } catch (error) {
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

      // AUTO-FATURAMENTO: ao mover para "faturado", criar NF-e automaticamente
      if (stage === 'faturado' && item.stage !== 'faturado') {
        try {
          const invoiceResult = await createInvoiceFromPipelineItem(item, user);
          if (invoiceResult) {
            invoiceNumber = `NF-${invoiceResult.invoiceNumber}`;
            fiscalInvoiceId = invoiceResult.id;
            console.log(`📄 [BILLING-PIPELINE] NF-e #${invoiceResult.invoiceNumber} criada automaticamente para item ${req.params.id}`);
          }
        } catch (invoiceError: any) {
          console.error(`❌ [BILLING-PIPELINE] Erro ao criar NF-e automática:`, invoiceError.message);
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
            try {
              const invoiceResult = await createInvoiceFromPipelineItem(item, user);
              if (invoiceResult) {
                invoiceNumber = `NF-${invoiceResult.invoiceNumber}`;
                fiscalInvoiceId = invoiceResult.id;
              }
            } catch (invoiceError: any) {
              console.error(`❌ [BATCH] Erro NF-e para ${id}:`, invoiceError.message);
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

async function createInvoiceFromPipelineItem(item: any, user: any) {
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
  const nextNumber = await storage.getNextInvoiceNumber('1');

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
    customerIe: (customer as any)?.ie || '',
    customerAddress: [customer?.address, customer?.city, customer?.state].filter(Boolean).join(', ') || '',
    natureOfOperation,
    cfop,
    totalProducts: totalValue.toFixed(2),
    totalInvoice: totalValue.toFixed(2),
    paymentMethod: item.paymentMethod || 'a_vista',
    notes: `Pedido pipeline interno - ${item.orderNumber || item.salesCardId}`,
    emissionDate: nowBrazil(),
    environment: 'homologacao',
    omieInstanceId: item.omieInstanceId || null,
    createdBy: user?.email || null,
  });

  const products = item.products as Array<{ id?: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  if (products && products.length > 0) {
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      await storage.createFiscalInvoiceItem({
        invoiceId: invoice.id,
        itemNumber: i + 1,
        productName: p.name,
        productCode: p.id || `PROD-${i + 1}`,
        productId: p.id || null,
        ncm: '22029000',
        cfop,
        unit: 'UN',
        quantity: p.quantity.toString(),
        unitPrice: p.unitPrice.toString(),
        totalPrice: p.totalPrice.toString(),
        discount: '0',
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

  return invoice;
}
