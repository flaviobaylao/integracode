import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { z } from "zod";

export function registerInventoryRoutes(app: Express) {

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
      res.json(lots);
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
      if (parseFloat(existing.quantity) > 0) {
        return res.status(400).json({ message: 'Não é possível excluir um lote com estoque. Zere o estoque antes.' });
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

      const summary = lots.map(lot => ({
        ...lot,
        product: productMap.get(lot.productId) || null,
        instance: instanceMap.get(lot.instanceId) || null,
      }));

      res.json({
        lots: summary,
        totalProducts: new Set(lots.map(l => l.productId)).size,
        totalInstances: new Set(lots.map(l => l.instanceId)).size,
        totalInUse: lots.filter(l => l.stockType === 'in_use').reduce((sum, l) => sum + parseFloat(l.quantity), 0),
        totalBlocked: lots.filter(l => l.stockType === 'blocked').reduce((sum, l) => sum + parseFloat(l.quantity), 0),
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
