import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { z } from "zod";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { ensureCmvLoteColumns } from "./ensure-cmv-lote";
import { attachTransferLocks, getLotTransferLock, getTransferLocks } from "./lot-lock";
import { normalizarNumeroLote } from "./estoque-em-uso";

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
  // Tipos de movimento 'block'/'unblock' (bloquear/desbloquear estoque, 05/out/2026).
  // ADD VALUE nao roda dentro de transacao — por isso fica aqui, fora, e idempotente.
  void (async () => {
    try {
      await db.execute(sql`ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'block'`);
      await db.execute(sql`ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'unblock'`);
    } catch (e: any) {
      console.error('⚠️ [ESTOQUE] nao conseguiu adicionar block/unblock ao enum movement_type:', e?.message || e);
    }
  })();

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
      // Numero de lote canonico (maiusculo, sem espacos): "h180626" e "H180626"
      // viravam dois lotes do mesmo produto na mesma filial (auditoria 04/out).
      const lotNumber = normalizarNumeroLote(parsed.data.lotNumber);
      const dup: any = await db.execute(sql`
        SELECT id FROM inventory_lots
        WHERE product_id = ${parsed.data.productId} AND instance_id = ${parsed.data.instanceId}
          AND stock_type = ${parsed.data.stockType} AND UPPER(REPLACE(TRIM(lot_number), ' ', '')) = ${lotNumber}
        LIMIT 1`);
      if ((dup.rows || []).length) {
        return res.status(409).json({ message: `O lote ${lotNumber} já existe para este produto nesta filial — ajuste o saldo do lote existente em vez de criar outro.`, existingLotId: dup.rows[0].id });
      }
      if (parseFloat(parsed.data.quantity) < 0) return res.status(400).json({ message: 'Saldo do lote não pode ser negativo.' });
      const lot = await storage.createInventoryLot({ ...parsed.data, lotNumber });

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
        createdBy: req.currentUser?.email || req.currentUser?.id || null,
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
      if (parsed.data.lotNumber !== undefined) {
        parsed.data.lotNumber = normalizarNumeroLote(parsed.data.lotNumber);
        const dup: any = await db.execute(sql`
          SELECT id FROM inventory_lots
          WHERE id <> ${existing.id} AND product_id = ${existing.productId} AND instance_id = ${existing.instanceId}
            AND stock_type = ${existing.stockType} AND UPPER(REPLACE(TRIM(lot_number), ' ', '')) = ${parsed.data.lotNumber}
          LIMIT 1`);
        if ((dup.rows || []).length) {
          return res.status(409).json({ message: `Já existe o lote ${parsed.data.lotNumber} deste produto nesta filial.` });
        }
      }
      // Ajuste de saldo exige MOTIVO (auditoria 04/out: 49 ajustes da GYN em 30/09
      // sem autor e sem motivo). O motivo vai no movimento — e o unico registro do
      // porque o estoque mudou.
      if (parsed.data.quantity !== undefined && Math.abs(parseFloat(parsed.data.quantity) - parseFloat(prevQty)) > 1e-9) {
        if (!(req.body?.motivo && String(req.body.motivo).trim().length >= 3)) {
          return res.status(400).json({ message: 'Informe o motivo do ajuste de saldo.' });
        }
        if (parseFloat(parsed.data.quantity) < 0) {
          return res.status(400).json({ message: 'Saldo do lote não pode ser negativo.' });
        }
      }
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
          notes: `Ajuste manual de estoque: ${prevQty} → ${parsed.data.quantity}${req.body?.motivo ? ' — ' + String(req.body.motivo).slice(0, 300) : ''}`,
          createdBy: req.currentUser?.email || req.currentUser?.id || null,
        });
      }

      res.json(lot);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao atualizar lote', error: error.message });
    }
  });

  // BLOQUEAR / DESBLOQUEAR (Flavio, 05/out/2026): move saldo (total ou parcial)
  // de um lote entre 'blocked' e 'in_use'. O saldo vai para o lote de MESMO
  // NUMERO do tipo de destino (mesma regra da entrada por transferencia:
  // mescla se existe, cria se nao existe). O lote de origem fica com o que
  // sobrou — zerado, vai para "Estoques Finalizados". Nunca troca o stock_type
  // da linha em si: o historico de movimentos de cada lote continua coerente
  // com o tipo em que foi lancado (contabilidade.ts agrupa por l.stock_type).
  const moverTipoSchema = z.object({
    stockType: z.enum(['in_use', 'blocked']),
    quantity: z.string().or(z.number()).transform(v => String(v)).optional(),
    motivo: z.string().optional(),
  });

  app.post('/api/inventory/lots/:id/mover-tipo', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const existing = await storage.getInventoryLot(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Lote não encontrado' });

      const parsed = moverTipoSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }
      const destino = parsed.data.stockType;
      if (destino === existing.stockType) {
        return res.status(400).json({ message: `O lote já está ${destino === 'in_use' ? 'em uso' : 'bloqueado'}.` });
      }
      const motivo = String(parsed.data.motivo || '').trim();
      if (motivo.length < 3) return res.status(400).json({ message: 'Informe o motivo do bloqueio/desbloqueio.' });

      const lock = await getLotTransferLock(req.params.id);
      if (lock) {
        return res.status(409).json({ message: `Lote ${existing.lotNumber} travado: ${lock.reason}`, transferLock: lock });
      }

      const saldo = parseFloat(existing.quantity) || 0;
      const qty = parsed.data.quantity !== undefined && String(parsed.data.quantity).trim() !== '' ? parseFloat(parsed.data.quantity) : saldo;
      if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'Quantidade a mover deve ser maior que zero.' });
      if (qty - saldo > 1e-9) return res.status(400).json({ message: `Quantidade a mover (${qty}) maior que o saldo do lote (${saldo}).` });

      const numLote = normalizarNumeroLote(existing.lotNumber) || 'SEM-LOTE';
      const acao = destino === 'in_use' ? 'unblock' : 'block';
      const rotulo = destino === 'in_use' ? 'Desbloqueio' : 'Bloqueio';
      const quem = req.currentUser?.email || req.currentUser?.id || null;
      const unit = lotUnitCost(existing);

      const resultado = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'estoque-mover-tipo:' + existing.productId + ':' + existing.instanceId + ':' + numLote}))`);
        const origem: any = ((await tx.execute(sql`SELECT * FROM inventory_lots WHERE id = ${existing.id} FOR UPDATE`)) as any).rows?.[0];
        if (!origem) throw new Error('Lote não encontrado');
        const prevOrigem = parseFloat(origem.quantity) || 0;
        if (qty - prevOrigem > 1e-9) throw new Error(`Saldo do lote mudou (${prevOrigem}); tente de novo.`);
        const novoOrigem = Math.max(0, prevOrigem - qty);

        await tx.execute(sql`
          UPDATE inventory_lots SET quantity = ${novoOrigem.toFixed(4)},
            total_cost = ${unit != null ? (unit * novoOrigem).toFixed(2) : null},
            updated_at = now()
          WHERE id = ${origem.id}`);

        const exist: any = ((await tx.execute(sql`
          SELECT * FROM inventory_lots
          WHERE product_id = ${origem.product_id} AND instance_id = ${origem.instance_id} AND stock_type = ${destino}
            AND UPPER(REPLACE(TRIM(lot_number), ' ', '')) = ${numLote}
          ORDER BY is_active DESC, created_at ASC LIMIT 1 FOR UPDATE`)) as any).rows?.[0];
        let destinoId: string; let prevDestino = 0; let criado = false;
        if (exist) {
          destinoId = exist.id; prevDestino = parseFloat(exist.quantity) || 0;
          const novo = prevDestino + qty;
          await tx.execute(sql`
            UPDATE inventory_lots SET quantity = ${novo.toFixed(4)}, is_active = true,
              unit_cost = COALESCE(unit_cost, ${unit != null ? unit.toFixed(4) : null}),
              total_cost = CASE WHEN COALESCE(unit_cost, ${unit != null ? unit.toFixed(4) : null}) IS NOT NULL
                                THEN (COALESCE(unit_cost, ${unit != null ? unit.toFixed(4) : null})::numeric * ${novo.toFixed(4)}::numeric)::text ELSE total_cost END,
              production_order_id = COALESCE(production_order_id, ${origem.production_order_id || null}),
              updated_at = now()
            WHERE id = ${destinoId}`);
        } else {
          criado = true;
          const ins: any = await tx.execute(sql`
            INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, min_quantity, unit_cost, total_cost, production_order_id, notes, is_active, created_at, updated_at)
            VALUES (gen_random_uuid()::varchar, ${origem.product_id}, ${origem.instance_id}, ${destino}, ${numLote}, ${qty.toFixed(4)}, ${origem.min_quantity || '0'},
                    ${unit != null ? unit.toFixed(4) : null}, ${unit != null ? (unit * qty).toFixed(2) : null}, ${origem.production_order_id || null},
                    ${`${rotulo} do lote ${numLote} (${existing.stockType === 'in_use' ? 'em uso' : 'bloqueado'} → ${destino === 'in_use' ? 'em uso' : 'bloqueado'}) — ${motivo.slice(0, 200)}`}, true, now(), now())
            RETURNING id`);
          destinoId = ins.rows[0].id;
        }

        const nota = `${rotulo} de estoque: ${qty} un. ${existing.stockType === 'in_use' ? 'Em Uso' : 'Bloqueado'} → ${destino === 'in_use' ? 'Em Uso' : 'Bloqueado'} — ${motivo.slice(0, 300)}`;
        await tx.execute(sql`
          INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
          VALUES (gen_random_uuid()::varchar, ${origem.id}, ${origem.product_id}, ${origem.instance_id}, ${acao}, ${(-qty).toFixed(4)}, ${prevOrigem.toFixed(4)}, ${novoOrigem.toFixed(4)},
                  'manual', ${destinoId}, ${numLote}, ${nota + ' (saída)'}, ${quem}, now())`);
        await tx.execute(sql`
          INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
          VALUES (gen_random_uuid()::varchar, ${destinoId}, ${origem.product_id}, ${origem.instance_id}, ${acao}, ${qty.toFixed(4)}, ${prevDestino.toFixed(4)}, ${(prevDestino + qty).toFixed(4)},
                  'manual', ${origem.id}, ${numLote}, ${nota + ' (entrada)'}, ${quem}, now())`);
        return { origemId: origem.id, origemSaldo: novoOrigem, destinoId, destinoSaldo: prevDestino + qty, criado };
      });

      console.log(`🔒 [ESTOQUE] ${rotulo} ${numLote}: ${qty} (${existing.stockType} → ${destino}) por ${quem || 'system'} — ${motivo}`);
      res.json({ success: true, quantidade: qty, ...resultado });
    } catch (error: any) {
      res.status(500).json({ message: error?.message || 'Erro ao mover estoque entre tipos' });
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
          createdBy: req.currentUser?.email || req.currentUser?.id || null,
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
          // true = o CMV deste lote e estimado (media ponderada do produto), nao o
          // custo real daquele lote. A tela marca; a valorizacao conta a parte.
          cmvEstimado: unit != null ? !!(lot as any).cmvEstimado : false,
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
        // Quanto da valorizacao acima repousa em estimativa, e nao em custo apurado.
        lotesCmvEstimado: summary.filter((l: any) => l.cmvEstimado).length,
        valorEstimado: Number(summary.reduce((s2: number, l: any) => s2 + (l.cmvEstimado ? (l.cmvStock || 0) : 0), 0).toFixed(2)),
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

// Baixa avulsa (rota /api/inventory/consume). Mesma regra do faturamento:
// SOMENTE lotes em uso, tudo-ou-nada. Nao existe mais a "transferencia
// automatica" de lote bloqueado para em uso — lote bloqueado nao e faturado
// (Flavio, 04/out/2026); liberar um lote bloqueado e decisao manual no estoque.
export async function consumeStock(
  productId: string,
  instanceId: string,
  quantity: number,
  sourceType: 'invoice' | 'order' | 'manual',
  sourceId: string | null,
  createdBy: string | null,
): Promise<{ success: boolean; lotNumber: string; consumed: number; transferred: boolean; message?: string }> {
  const { baixarEstoqueEmUso, ehBloqueioEstoque } = await import('./estoque-em-uso.js');
  try {
    const mapa = await baixarEstoqueEmUso({
      instanceId,
      products: [{ id: productId, name: productId, quantity }],
      sourceId: sourceId || `${sourceType}-avulso`,
      rotulo: `Baixa ${sourceType}${sourceId ? ' ' + sourceId : ''}`,
      createdBy,
      sourceType,
    });
    const lotes = mapa[productId] || [];
    return { success: true, lotNumber: lotes.map((l) => l.lotNumber).join(', '), consumed: quantity, transferred: false };
  } catch (e: any) {
    if (ehBloqueioEstoque(e)) {
      return { success: false, lotNumber: '', consumed: 0, transferred: false, message: e.details || e.message };
    }
    throw e;
  }
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
