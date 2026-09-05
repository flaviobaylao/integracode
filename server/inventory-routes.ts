import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { z } from "zod";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { ensureCmvLoteColumns } from "./ensure-cmv-lote";
import { attachTransferLocks, getLotTransferLock, getTransferLocks } from "./lot-lock";

// Custo de um lote: numero ou null. NUNCA 0 por omissao — um lote sem custo
// conhecido (entrada manual, remanejamento entre filiais) precisa aparecer como
// "sem CMV" na tela, e nao como se tivesse custado nada.
function lotUnitCost(lot: any): number | null {
  const v = lot?.unitCost;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function registerInventoryRoutes(app: Express) {
  // Colunas de CMV do lote + backfill dos lotes ja produzidos (idempotente).
  void ensureCmvLoteColumns();

  // ============================================================================
  // INVENTORY LOTS CRUD
  // ============================================================================

  app.get('/api/inventory/lots', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { productId, instanceId, stockType, isActive } = req.query;
      const lots = await storage.getInventoryLots({
        productId: productId as string,
        instanceId: instanceId as string,
        stockType: stockType as string,
        isActive: isActive !== undefined ? isActive === 'true' : undefined,
      });
      // transferLock: lote preso numa NF/pedido de transferencia (ver lot-lock.ts).
      // A tela usa para esconder Editar/Excluir e explicar o porque.
      res.json(await attachTransferLocks(lots));
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar lotes de estoque', error: error.message });
    }
  });

  app.get('/api/inventory/lots/:id', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const lot = await storage.getInventoryLot(req.params.id);
      if (!lot) return res.status(404).json({ message: 'Lote não encontrado' });
      res.json(lot);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar lote', error: error.message });
    }
  });

  const createLotSchema = z.object({
    productId: z.string().min(1),
    instanceId: z.string().min(1),
    stockType: z.enum(['in_use', 'blocked']),
    lotNumber: z.string().min(1, 'Número do lote obrigatório'),
    quantity: z.string().or(z.number()).transform(v => String(v)),
    minQuantity: z.string().or(z.number()).transform(v => String(v)).optional(),
    notes: z.string().optional(),
  });

  app.post('/api/inventory/lots', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const parsed = createLotSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }
      const lot = await storage.createInventoryLot(parsed.data);

      await storage.createInventoryMovement({
        lotId: lot.id,
        productId: lot.productId,
        instanceId: lot.instanceId,
        movementType: 'adjust',
        quantity: lot.quantity,
        previousQuantity: '0',
        newQuantity: lot.quantity,
        sourceType: 'manual',
        lotNumber: lot.lotNumber,
        notes: `Lote criado com quantidade inicial: ${lot.quantity}`,
        createdBy: req.user?.id || req.userId || null,
      });

      res.status(201).json(lot);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao criar lote', error: error.message });
    }
  });

  const updateLotSchema = z.object({
    lotNumber: z.string().min(1).optional(),
    quantity: z.string().or(z.number()).transform(v => String(v)).optional(),
    minQuantity: z.string().or(z.number()).transform(v => String(v)).optional(),
    isActive: z.boolean().optional(),
    notes: z.string().optional(),
  });

  app.put('/api/inventory/lots/:id', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const existing = await storage.getInventoryLot(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Lote não encontrado' });

      const parsed = updateLotSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }

      // TRAVA (Flavio 05/set): lote em pedido/NF de transferencia nao se edita.
      // Libera so com o cancelamento/devolucao da NF (que estorna o estoque) ou,
      // antes da nota, mandando o pedido para a Lixeira.
      const lock = await getLotTransferLock(req.params.id);
      if (lock) {
        return res.status(409).json({ message: `Lote ${existing.lotNumber} travado: ${lock.reason}`, transferLock: lock });
      }

      const prevQty = existing.quantity;
      const lot = await storage.updateInventoryLot(req.params.id, parsed.data);

      if (parsed.data.quantity && parsed.data.quantity !== prevQty) {
        await storage.createInventoryMovement({
          lotId: lot.id,
          productId: lot.productId,
          instanceId: lot.instanceId,
          movementType: 'adjust',
          quantity: (parseFloat(parsed.data.quantity) - parseFloat(prevQty)).toString(),
          previousQuantity: prevQty,
          newQuantity: parsed.data.quantity,
          sourceType: 'manual',
          lotNumber: lot.lotNumber,
          notes: `Ajuste manual de estoque: ${prevQty} → ${parsed.data.quantity}`,
          createdBy: req.user?.id || req.userId || null,
        });
      }

      res.json(lot);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao atualizar lote', error: error.message });
    }
  });

  app.delete('/api/inventory/lots/:id', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const existing = await storage.getInventoryLot(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Lote não encontrado' });

      const lock = await getLotTransferLock(req.params.id);
      if (lock) {
        return res.status(409).json({ message: `Lote ${existing.lotNumber} travado: ${lock.reason}`, transferLock: lock });
      }

      if (parseFloat(existing.quantity) > 0) {
        await storage.createInventoryMovement({
          lotId: existing.id,
          productId: existing.productId,
          instanceId: existing.instanceId,
          movementType: 'adjust',
          quantity: (-parseFloat(existing.quantity)).toString(),
          previousQuantity: existing.quantity,
          newQuantity: '0',
          sourceType: 'manual',
          lotNumber: existing.lotNumber,
          notes: `Lote excluído manualmente (tinha ${existing.quantity} em estoque)`,
          createdBy: req.user?.id || req.userId || null,
        });
      }

      await storage.deleteInventoryLot(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao excluir lote', error: error.message });
    }
  });

  // ============================================================================
  // INVENTORY MOVEMENTS
  // ============================================================================

  app.get('/api/inventory/movements', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { lotId, productId, instanceId, sourceType, sourceId } = req.query;
      const movements = await storage.getInventoryMovements({
        lotId: lotId as string,
        productId: productId as string,
        instanceId: instanceId as string,
        sourceType: sourceType as string,
        sourceId: sourceId as string,
      });
      res.json(movements);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar movimentações', error: error.message });
    }
  });

  // ============================================================================
  // INVENTORY SUMMARY
  // ============================================================================

  app.get('/api/inventory/summary', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const lots = await storage.getInventoryLots({ isActive: true });
      const products = await storage.getProducts();
      const instances = await storage.getOmieInstances();

      const productMap = new Map(products.map(p => [p.id, p]));
      const instanceMap = new Map(instances.map(i => [i.id, i]));

      // Numero da OP que gerou o lote — para a tela mostrar a origem do CMV
      // ("R$ 0,4115 · OP-00033") em vez de um numero sem procedencia.
      const opIds = Array.from(new Set(lots.map((l: any) => l.productionOrderId).filter(Boolean)));
      const opMap = new Map<string, string>();
      if (opIds.length) {
        // sql`... = ANY(${array})` NAO funciona: o driver manda o array como um unico
        // parametro de texto e o Postgres responde 'malformed array literal'. O build e
        // o tsc passam; so estoura em runtime, com a tela de estoque em 500. Lista de
        // placeholders explicita (pego no harness contra Postgres real, 01/set).
        const r: any = await db.execute(
          sql`SELECT id, order_number FROM production_orders WHERE id IN (${sql.join(opIds.map((i) => sql`${i}`), sql`, `)})`);
        for (const row of (r.rows || [])) opMap.set(String(row.id), String(row.order_number || ''));
      }

      const locks = await getTransferLocks(lots.map((l: any) => l.id));

      const summary = lots.map(lot => {
        const unit = lotUnitCost(lot);
        const qty = parseFloat(lot.quantity as any) || 0;
        return {
          ...lot,
          product: productMap.get(lot.productId) || null,
          instance: instanceMap.get(lot.instanceId) || null,
          // cmvUnit e o custo unitario congelado; cmvStock e quanto o saldo ATUAL
          // do lote vale hoje (unit x saldo), que e o numero que interessa para
          // dimensionar a transferencia. totalCost e o custo da producao inteira e
          // nao acompanha o consumo — os tres sao coisas diferentes de proposito.
          cmvUnit: unit,
          cmvTotalProduzido: lot.totalCost != null ? Number(lot.totalCost) : null,
          cmvStock: unit != null ? Number((unit * qty).toFixed(2)) : null,
          productionOrderNumber: lot.productionOrderId ? (opMap.get(String(lot.productionOrderId)) || null) : null,
          // Trava de transferencia: preenchida quando o lote esta num pedido TRF
          // vivo ou numa NF de transferencia nao cancelada/devolvida.
          transferLock: locks.get(lot.id) || null,
        };
      });

      const valorEmEstoque = summary.reduce((sum, l: any) => sum + (l.cmvStock || 0), 0);

      res.json({
        lots: summary,
        totalProducts: new Set(lots.map(l => l.productId)).size,
        totalInstances: new Set(lots.map(l => l.instanceId)).size,
        totalInUse: lots.filter(l => l.stockType === 'in_use').reduce((sum, l) => sum + parseFloat(l.quantity), 0),
        totalBlocked: lots.filter(l => l.stockType === 'blocked').reduce((sum, l) => sum + parseFloat(l.quantity), 0),
        // Valorizacao do estoque a CMV. Lotes sem custo conhecido entram como 0 na
        // soma mas sao contados a parte, para a tela poder dizer "de 8 lotes, 2 sem CMV"
        // em vez de apresentar um total que finge estar completo.
        valorEmEstoque: Number(valorEmEstoque.toFixed(2)),
        lotesSemCmv: summary.filter((l: any) => l.cmvUnit == null).length,
        lotesTravados: summary.filter((l: any) => l.transferLock).length,
      });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar resumo de estoque', error: error.message });
    }
  });

  // ============================================================================
  // STOCK CONSUMPTION (called from NF-e emission)
  // ============================================================================

  app.post('/api/inventory/consume', authenticateUser, requireRole(['admin', 'coordinator']), async (req: any, res) => {
    try {
      const schema = z.object({
        productId: z.string().min(1),
        instanceId: z.string().min(1),
        quantity: z.number().positive(),
        sourceType: z.enum(['invoice', 'order', 'manual']),
        sourceId: z.string().optional(),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }

      const result = await consumeStock(
        parsed.data.productId,
        parsed.data.instanceId,
        parsed.data.quantity,
        parsed.data.sourceType,
        parsed.data.sourceId || null,
        req.user?.id || req.userId || null,
      );

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao consumir estoque', error: error.message });
    }
  });


  // ==========================================================================
  // PEDIDO DE TRANSFERENCIA ENTRE FILIAIS (Flavio, 01/set/2026)
  //
  // Seleciona N lotes produzidos na IND e emite UM pedido de transferencia para a
  // filial de destino (GYN), precificado pelo CMV congelado de cada lote. O pedido
  // nasce direto na etapa 'a_faturar' do pipeline de faturamento e dali segue o
  // caminho normal de emissao de NF-e (cenario fiscal de operacao 'transferencia').
  //
  // O estoque NAO se mexe aqui. A baixa acontece no faturamento, pelo consumeStock
  // que a emissao da NF ja chama — um pedido que nunca vira nota nao pode deixar
  // saldo preso, e ter uma unica rotina de baixa evita os dois caminhos divergirem.
  // ==========================================================================

  // Sugestao de destino: o cadastro de cliente que representa a filial. Casa por
  // CNPJ da instancia (forte) e, so entao, por nome (fraco) — a tela deixa escolher
  // outro. Nunca inventa cliente: sem candidato, o usuario busca manualmente.
  app.get('/api/inventory/transfer-order/destinations', authenticateUser, requireRole(['admin', 'coordinator']), async (req: any, res) => {
    try {
      const instances = await storage.getOmieInstances();
      const customers = await storage.getCustomers();
      const soDigito = (v: any) => String(v || '').replace(/\D/g, '');

      const out = instances
        .filter((i: any) => i.isActive && String(i.name || '').toUpperCase() !== 'IND')
        .map((inst: any) => {
          const cnpj = soDigito(inst.cnpj);
          let match: any = null;
          let matchBy: 'cnpj' | 'nome' | null = null;
          if (cnpj.length >= 14) {
            match = customers.find((c: any) => soDigito(c.cnpj) === cnpj) || null;
            if (match) matchBy = 'cnpj';
          }
          if (!match) {
            const alvo = String(inst.displayName || inst.name || '').toUpperCase();
            match = customers.find((c: any) =>
              String(c.name || '').toUpperCase().includes(alvo) ||
              String(c.fantasyName || '').toUpperCase().includes(alvo)) || null;
            if (match) matchBy = 'nome';
          }
          return {
            instanceId: inst.id,
            instanceName: inst.name,
            instanceDisplayName: inst.displayName,
            instanceCnpj: inst.cnpj || null,
            customerId: match?.id || null,
            customerName: match ? (match.fantasyName || match.name) : null,
            customerDocument: match?.cnpj || match?.cpf || null,
            matchBy,
          };
        });

      res.json({ destinations: out });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao listar destinos de transferencia', error: error.message });
    }
  });

  const transferOrderSchema = z.object({
    lots: z.array(z.object({
      lotId: z.string().min(1),
      quantity: z.number().positive(),
    })).min(1, 'Selecione ao menos um lote'),
    destinationInstanceId: z.string().min(1),
    customerId: z.string().min(1, 'Informe o cliente/filial de destino'),
    scheduledBillingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    notes: z.string().max(600).optional(),
  });

  app.post('/api/inventory/transfer-order', authenticateUser, requireRole(['admin', 'coordinator']), async (req: any, res) => {
    try {
      const parsed = transferOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados invalidos', errors: parsed.error.flatten().fieldErrors });
      }
      const { lots: pedidos, destinationInstanceId, customerId, scheduledBillingDate, notes } = parsed.data;

      const destino = await storage.getOmieInstance(destinationInstanceId);
      if (!destino) return res.status(404).json({ message: 'Instancia de destino nao encontrada' });

      const customer: any = await storage.getCustomer(customerId);
      if (!customer) return res.status(404).json({ message: 'Cliente de destino nao encontrado' });

      // Um lote so pode ser pedido uma vez na mesma requisicao — dois cliques na
      // mesma linha nao podem virar duas linhas somando mais do que existe.
      const vistos = new Set<string>();
      for (const p of pedidos) {
        if (vistos.has(p.lotId)) return res.status(400).json({ message: 'Lote repetido na selecao' });
        vistos.add(p.lotId);
      }

      const produtos: any[] = [];
      const erros: string[] = [];
      let origemInstanceId: string | null = null;
      let total = 0;

      for (const p of pedidos) {
        const lot: any = await storage.getInventoryLot(p.lotId);
        if (!lot) { erros.push(`lote ${p.lotId} nao encontrado`); continue; }
        if (!lot.isActive) { erros.push(`lote ${lot.lotNumber} esta inativo`); continue; }

        const saldo = parseFloat(lot.quantity) || 0;
        if (p.quantity > saldo) {
          erros.push(`lote ${lot.lotNumber}: pedido ${p.quantity}, saldo ${saldo}`);
          continue;
        }

        // Sem CMV nao ha preco. Transferir a zero mandaria uma NF com valor zerado
        // para a SEFAZ e destruiria a valorizacao do estoque da filial — melhor
        // recusar e dizer qual lote falta custar.
        const unit = lotUnitCost(lot);
        if (unit == null) {
          erros.push(`lote ${lot.lotNumber} nao tem CMV — nao da para precificar a transferencia`);
          continue;
        }

        // Todos os lotes tem de sair da MESMA instancia: o pipeline valida estoque e
        // emite a NF contra um unico omie_instance_id.
        if (origemInstanceId && origemInstanceId !== lot.instanceId) {
          return res.status(400).json({ message: 'Todos os lotes selecionados devem ser da mesma instancia de origem' });
        }
        origemInstanceId = lot.instanceId;

        if (lot.instanceId === destinationInstanceId) {
          return res.status(400).json({ message: 'Origem e destino sao a mesma instancia' });
        }

        const product: any = await storage.getProduct(lot.productId);
        const totalPrice = Number((unit * p.quantity).toFixed(2));
        total += totalPrice;
        produtos.push({
          id: lot.productId,
          name: product?.name || lot.productId,
          quantity: p.quantity,
          unitPrice: Number(unit.toFixed(4)),
          totalPrice,
          // Rastreabilidade: o lote viaja no proprio item do pedido, para a NF-e
          // sair com o lote certo em vez de deixar o FIFO escolher outro.
          lotId: lot.id,
          lotNumber: lot.lotNumber,
          cmvUnit: Number(unit.toFixed(4)),
          productionOrderId: lot.productionOrderId || null,
          // Destino viaja no item porque o pipeline so tem UM omie_instance_id e ele
          // ja e a ORIGEM (e contra a origem que estoque e NF-e sao validados). Sem
          // isso, o faturamento nao teria como saber onde dar a entrada espelho.
          transferToInstanceId: destinationInstanceId,
          transferToInstanceName: destino.name,
        });
      }

      if (!produtos.length) {
        return res.status(400).json({ message: 'Nenhum lote pode ser transferido', errors: erros });
      }

      const origem = origemInstanceId ? await storage.getOmieInstance(origemInstanceId) : null;
      const salesCardId = randomUUID();
      const orderNumber = `TRF-${salesCardId.substring(0, 8).toUpperCase()}`;
      const user = req.currentUser || req.user;
      const quem = user?.email || 'system';
      const agoraISO = new Date().toISOString();

      const resumo = produtos.map(pr => `${pr.lotNumber} x${pr.quantity}`).join(', ');
      const cabecalho = `Transferencia ${origem?.name || 'origem'} -> ${destino.name} `
        + `(${produtos.length} lote(s), precificada a CMV): ${resumo}`;

      const item = await storage.createBillingPipelineItem({
        salesCardId,
        customerId: customer.id,
        customerName: customer.fantasyName || customer.name || destino.displayName,
        customerDocument: customer.cnpj || customer.cpf || destino.cnpj || null,
        sellerId: user?.id || null,
        sellerName: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email : null,
        // Entra direto em 'a_faturar': transferencia entre filiais nao passa por
        // visita de vendedor nem por aprovacao comercial — o que existe para faturar
        // ja esta decidido no momento em que os lotes foram escolhidos.
        stage: 'a_faturar',
        scheduledBillingDate: scheduledBillingDate ? new Date(`${scheduledBillingDate}T12:00:00-03:00`) : null,
        orderNumber,
        saleValue: total.toFixed(2),
        paymentMethod: null,
        operationType: 'transferencia',
        products: produtos as any,
        notes: [cabecalho, notes].filter(Boolean).join(' | ').slice(0, 1000),
        // Instancia do PEDIDO = origem do estoque. E contra ela que o pipeline
        // valida saldo e que a NF-e sai; o destino vai no cliente/destinatario.
        omieInstanceId: origemInstanceId,
        omieInstanceName: origem?.displayName || origem?.name || null,
        stageHistory: [{ stage: 'a_faturar', changedAt: agoraISO, changedBy: quem }],
        createdBy: quem,
      } as any);

      console.log(`🔁 [TRANSFER] ${orderNumber} ${origem?.name} -> ${destino.name} `
        + `${produtos.length} lote(s) R$ ${total.toFixed(2)} por ${quem}`);

      res.status(201).json({ success: true, item, orderNumber, total, warnings: erros });
    } catch (error: any) {
      console.error('❌ [TRANSFER] erro:', error);
      res.status(500).json({ message: 'Erro ao criar pedido de transferencia', error: error.message });
    }
  });

  console.log('✅ Inventory routes registered successfully');
}

// ============================================================================
// STOCK CONSUMPTION LOGIC (exported for use by NF-e flows)
// ============================================================================

export async function consumeStock(
  productId: string,
  instanceId: string,
  quantity: number,
  sourceType: 'invoice' | 'order' | 'manual',
  sourceId: string | null,
  createdBy: string | null,
): Promise<{ success: boolean; lotNumber: string; consumed: number; transferred: boolean; message?: string }> {
  const inUseLots = await storage.getInventoryLots({
    productId,
    instanceId,
    stockType: 'in_use',
    isActive: true,
  });

  const inUseLot = inUseLots[0];
  if (!inUseLot) {
    return { success: false, lotNumber: '', consumed: 0, transferred: false, message: 'Nenhum lote em uso encontrado para este produto/instância' };
  }

  let currentQty = parseFloat(inUseLot.quantity);
  let remaining = quantity;
  let usedLotNumber = inUseLot.lotNumber;
  let transferred = false;

  if (currentQty >= remaining) {
    const newQty = currentQty - remaining;
    await storage.updateInventoryLot(inUseLot.id, { quantity: newQty.toString() });
    await storage.createInventoryMovement({
      lotId: inUseLot.id,
      productId,
      instanceId,
      movementType: 'consume',
      quantity: (-remaining).toString(),
      previousQuantity: currentQty.toString(),
      newQuantity: newQty.toString(),
      sourceType,
      sourceId,
      lotNumber: inUseLot.lotNumber,
      notes: `Consumo de ${remaining} unidades`,
      createdBy,
    });
    return { success: true, lotNumber: usedLotNumber, consumed: quantity, transferred: false };
  }

  if (currentQty > 0) {
    await storage.updateInventoryLot(inUseLot.id, { quantity: '0' });
    await storage.createInventoryMovement({
      lotId: inUseLot.id,
      productId,
      instanceId,
      movementType: 'consume',
      quantity: (-currentQty).toString(),
      previousQuantity: currentQty.toString(),
      newQuantity: '0',
      sourceType,
      sourceId,
      lotNumber: inUseLot.lotNumber,
      notes: `Consumo de ${currentQty} unidades (esgotou lote em uso)`,
      createdBy,
    });
    remaining -= currentQty;
  }

  const blockedLots = await storage.getInventoryLots({
    productId,
    instanceId,
    stockType: 'blocked',
    isActive: true,
  });

  const blockedLot = blockedLots.find(l => parseFloat(l.quantity) > 0);
  if (!blockedLot) {
    return {
      success: false,
      lotNumber: usedLotNumber,
      consumed: quantity - remaining,
      transferred: false,
      message: `Estoque insuficiente. Consumido: ${quantity - remaining}, Faltam: ${remaining}`,
    };
  }

  const blockedQty = parseFloat(blockedLot.quantity);
  await storage.updateInventoryLot(inUseLot.id, {
    lotNumber: blockedLot.lotNumber,
    quantity: blockedQty.toString(),
  });
  await storage.createInventoryMovement({
    lotId: inUseLot.id,
    productId,
    instanceId,
    movementType: 'transfer',
    quantity: blockedQty.toString(),
    previousQuantity: '0',
    newQuantity: blockedQty.toString(),
    sourceType: 'manual',
    lotNumber: blockedLot.lotNumber,
    notes: `Transferência automática: lote bloqueado ${blockedLot.lotNumber} → lote em uso`,
    createdBy,
  });

  await storage.updateInventoryLot(blockedLot.id, { quantity: '0', isActive: false });
  await storage.createInventoryMovement({
    lotId: blockedLot.id,
    productId,
    instanceId,
    movementType: 'transfer',
    quantity: (-blockedQty).toString(),
    previousQuantity: blockedQty.toString(),
    newQuantity: '0',
    sourceType: 'manual',
    lotNumber: blockedLot.lotNumber,
    notes: `Lote bloqueado ${blockedLot.lotNumber} transferido para estoque em uso`,
    createdBy,
  });

  transferred = true;
  usedLotNumber = blockedLot.lotNumber;

  if (blockedQty >= remaining) {
    const newQty = blockedQty - remaining;
    await storage.updateInventoryLot(inUseLot.id, { quantity: newQty.toString() });
    await storage.createInventoryMovement({
      lotId: inUseLot.id,
      productId,
      instanceId,
      movementType: 'consume',
      quantity: (-remaining).toString(),
      previousQuantity: blockedQty.toString(),
      newQuantity: newQty.toString(),
      sourceType,
      sourceId,
      lotNumber: usedLotNumber,
      notes: `Consumo de ${remaining} unidades (após transferência de lote)`,
      createdBy,
    });
    return { success: true, lotNumber: usedLotNumber, consumed: quantity, transferred };
  }

  return {
    success: false,
    lotNumber: usedLotNumber,
    consumed: quantity - remaining + blockedQty,
    transferred,
    message: `Estoque insuficiente mesmo após transferência. Consumido parcial.`,
  };
}

export async function reverseStockConsumption(
  productId: string,
  instanceId: string,
  quantity: number,
  sourceType: 'invoice' | 'order' | 'manual',
  sourceId: string | null,
  createdBy: string | null,
): Promise<{ success: boolean; message?: string }> {
  const inUseLots = await storage.getInventoryLots({
    productId,
    instanceId,
    stockType: 'in_use',
    isActive: true,
  });

  const inUseLot = inUseLots[0];
  if (!inUseLot) {
    return { success: false, message: 'Nenhum lote em uso encontrado para devolução' };
  }

  const currentQty = parseFloat(inUseLot.quantity);
  const newQty = currentQty + quantity;

  await storage.updateInventoryLot(inUseLot.id, { quantity: newQty.toString() });
  await storage.createInventoryMovement({
    lotId: inUseLot.id,
    productId,
    instanceId,
    movementType: 'cancel_reversal',
    quantity: quantity.toString(),
    previousQuantity: currentQty.toString(),
    newQuantity: newQty.toString(),
    sourceType,
    sourceId,
    lotNumber: inUseLot.lotNumber,
    notes: `Devolução de ${quantity} unidades (cancelamento)`,
    createdBy,
  });

  return { success: true };
}
