// ============================================================================
// MÓDULO INDÚSTRIA 2.0 — paridade com o 1.0 + integrações (18/ago/2026)
// Matéria-Prima (CRUD + movimentações), Ordens de Produção (fluxo completo com
// finalização/qualidade/CMV) e integração do produto acabado com inventory_lots.
//
// CUTOVER: raw_materials, raw_material_movements, production_orders e
// production_order_items são de propriedade do 2.0 (fora do backfill do 1.0),
// junto com recipes/recipe_items (cutover de 17/ago).
//
// Tabelas SEM schema drizzle (criadas via create-missing-tables) → SQL
// parametrizado (drizzle sql``). Auth: prefixo /api/industria já protegido por
// app.use('/api/industria', authenticateUser, requireRole(['admin'])) no index.ts
// (perfil "industria" é promovido a admin no authenticateUser).
// ============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { getProductionOrderTransferLock, getProductionOrderTransferLocks } from "./lot-lock";

const num = (v: any): number | null => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  return isFinite(n) ? n : null;
};
const str = (v: any, max = 300): string | null => {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s === '' ? null : s;
};
const userOf = (req: any): string =>
  str(req.currentUser?.email || req.currentUser?.id, 120) || 'admin-2.0';

// Tipos de movimentação de matéria-prima (valores reais já usados na tabela:
// ajuste, entrada, entrada_compra, saida_producao — + perda/devolucao/saida do 1.0)
const MOV_IN = new Set(['entrada', 'entrada_compra', 'devolucao']);
const MOV_OUT = new Set(['saida', 'saida_producao', 'perda']);
const MOV_TYPES = new Set(Array.from(MOV_IN).concat(Array.from(MOV_OUT)).concat(['ajuste']));

// Estorno da finalização (Flavio 29/ago): reabrir ou excluir uma ordem JÁ
// finalizada tem que desfazer TUDO que a finalização escreveu no estoque —
// senão a próxima finalização baixa a matéria-prima duas vezes.
// Idempotência: cada movimento estornado recebe o marcador '[estornado]' nas
// notes, e o filtro ignora quem já tem o marcador. Reabrir → finalizar →
// reabrir de novo funciona sem estornar duas vezes o mesmo movimento.
const EST_MARK = '[estornado]';

async function reverseFinalization(id: string, order: any, by: string) {
  const undone: string[] = [];
  const warnings: string[] = [];

  // 1) Matéria-prima: desfaz consumo (saida_producao) e entrada de polpa produzida
  const movs: any = await db.execute(sql`
    SELECT * FROM raw_material_movements
    WHERE production_order_id = ${id}
      AND movement_type IN ('saida_producao', 'entrada')
      AND COALESCE(notes, '') NOT LIKE ${'%' + EST_MARK + '%'}
    ORDER BY created_at ASC`);
  for (const mv of (movs.rows || [])) {
    const rm: any = await db.execute(sql`SELECT * FROM raw_materials WHERE id = ${mv.raw_material_id} LIMIT 1`);
    const mat = (rm.rows || [])[0];
    if (!mat) { warnings.push(`material ${mv.raw_material_id} nao existe mais — movimento nao estornado`); continue; }
    const qty = Number(mv.quantity) || 0;
    const prevQty = Number(mat.quantity) || 0;
    const isOut = String(mv.movement_type) === 'saida_producao';
    const newQty = isOut ? prevQty + qty : prevQty - qty;
    await db.execute(sql`UPDATE raw_materials SET quantity = ${newQty}, updated_at = now() WHERE id = ${mat.id}`);
    await db.execute(sql`
      INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, production_order_id, notes, created_by, created_at, unit_cost)
      VALUES (gen_random_uuid()::varchar, ${mat.id}, ${isOut ? 'entrada' : 'saida'}, ${qty}, ${prevQty}, ${newQty}, ${id}, ${'Estorno da finalizacao da ordem ' + order.order_number + ' ' + EST_MARK}, ${by}, now(), ${mat.unit_cost})`);
    await db.execute(sql`UPDATE raw_material_movements SET notes = COALESCE(notes, '') || ${' ' + EST_MARK} WHERE id = ${mv.id}`);
    undone.push(`${mat.name}: ${isOut ? '+' : '-'}${qty}`);
    if (newQty < 0) warnings.push(`estoque de ${mat.name} ficou negativo (${newQty}) apos o estorno`);
  }

  // 2) Produto acabado: desfaz a entrada do lote criado pela finalização
  const inv: any = await db.execute(sql`
    SELECT * FROM inventory_movements
    WHERE source_type = 'order' AND source_id = ${id} AND movement_type = 'replenish'
      AND COALESCE(notes, '') NOT LIKE ${'%' + EST_MARK + '%'}
    ORDER BY created_at ASC`);
  for (const mv of (inv.rows || [])) {
    const lq: any = await db.execute(sql`SELECT * FROM inventory_lots WHERE id = ${mv.lot_id} LIMIT 1`);
    const lot = (lq.rows || [])[0];
    if (!lot) { warnings.push(`lote ${mv.lot_number} nao encontrado — entrada de produto acabado nao estornada`); continue; }
    const qty = Number(mv.quantity) || 0;
    const prevQty = Number(lot.quantity) || 0;
    const newQty = prevQty - qty;
    if (newQty < 0) warnings.push(`lote ${lot.lot_number} ja teve saida (restam ${prevQty} de ${qty}) — zerado e inativado`);
    const finalQty = Math.max(0, newQty);
    await db.execute(sql`
      UPDATE inventory_lots SET quantity = ${String(finalQty)}, is_active = ${finalQty > 0},
        notes = COALESCE(notes, '') || ${' | estornado pela reabertura da ' + order.order_number},
        updated_at = now()
      WHERE id = ${lot.id}`);
    await db.execute(sql`
      INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
      VALUES (gen_random_uuid()::varchar, ${lot.id}, ${lot.product_id}, ${lot.instance_id}, 'cancel_reversal', ${String(qty)}, ${String(prevQty)}, ${String(finalQty)}, 'order', ${id}, ${lot.lot_number}, ${'Estorno da finalizacao da ordem ' + order.order_number + ' ' + EST_MARK}, ${by}, now())`);
    await db.execute(sql`UPDATE inventory_movements SET notes = COALESCE(notes, '') || ${' ' + EST_MARK} WHERE id = ${mv.id}`);
    undone.push(`lote ${lot.lot_number}: -${qty}`);
  }

  return { undone, warnings };
}

// Tira o rodapé "CMV: ..." que a finalização anexa em notes, para a ordem
// reaberta não carregar o CMV da tentativa anterior.
const stripCmvNote = (notes: any) => String(notes || '')
  .split(' | ').filter((p) => !/^CMV:\s/.test(p.trim())).join(' | ').trim() || null;

export function registerIndustriaRoutes(app: Express) {

  // Ordem reaberta precisa lembrar o lote que gerou (para o estorno e para
  // reexibir no formulário). A tabela vem do 1.0 e pode não ter a coluna.
  db.execute(sql`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS lot_number varchar`).catch(() => {});

  // ========================== MATÉRIA-PRIMA ==========================

  app.get('/api/industria/raw-materials', async (_req, res) => {
    try {
      const r: any = await db.execute(sql`SELECT * FROM raw_materials ORDER BY name`);
      res.json({ total: (r.rows || []).length, materials: r.rows || [] });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/industria/raw-materials', async (req: any, res) => {
    try {
      const b = req.body || {};
      const name = str(b.name, 200);
      if (!name) return res.status(400).json({ error: 'nome do material e obrigatorio' });
      const qty = num(b.quantity) ?? 0;
      const by = userOf(req);
      const ins: any = await db.execute(sql`
        INSERT INTO raw_materials (id, name, code, category, unit, quantity, min_quantity, unit_cost, supplier, instance_id, instance_name, description, is_active, created_at, updated_at)
        VALUES (gen_random_uuid()::varchar, ${name}, ${str(b.code, 60)}, ${str(b.category, 40) || 'outros'}, ${str(b.unit, 30) || 'unidade'},
                ${qty}, ${num(b.min_quantity) ?? 0}, ${num(b.unit_cost) ?? 0}, ${str(b.supplier, 200)},
                ${str(b.instance_id, 60)}, ${str(b.instance_name, 30) || 'IND'}, ${str(b.description, 1000)}, true, now(), now())
        RETURNING *`);
      const mat = (ins.rows || [])[0];
      if (mat && qty > 0) {
        await db.execute(sql`
          INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, production_order_id, notes, created_by, created_at, unit_cost)
          VALUES (gen_random_uuid()::varchar, ${mat.id}, 'entrada', ${qty}, 0, ${qty}, NULL, 'Estoque inicial (cadastro)', ${by}, now(), ${num(b.unit_cost) ?? 0})`);
      }
      console.log('🏭 [MP] material criado', name, 'por', by);
      res.json({ ok: true, material: mat });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.patch('/api/industria/raw-materials/:id', async (req: any, res) => {
    try {
      const id = str(req.params.id, 60);
      if (!id) return res.status(400).json({ error: 'id invalido' });
      const b = req.body || {};
      const cur: any = await db.execute(sql`SELECT * FROM raw_materials WHERE id = ${id} LIMIT 1`);
      const prev = (cur.rows || [])[0];
      if (!prev) return res.status(404).json({ error: 'material nao encontrado', id });
      const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
      const name = has('name') ? str(b.name, 200) : prev.name;
      if (!name) return res.status(400).json({ error: 'nome do material e obrigatorio' });
      const up: any = await db.execute(sql`
        UPDATE raw_materials SET
          name = ${name},
          code = ${has('code') ? str(b.code, 60) : prev.code},
          category = ${has('category') ? (str(b.category, 40) || 'outros') : prev.category},
          unit = ${has('unit') ? (str(b.unit, 30) || 'unidade') : prev.unit},
          min_quantity = ${has('min_quantity') ? (num(b.min_quantity) ?? 0) : prev.min_quantity},
          unit_cost = ${has('unit_cost') ? (num(b.unit_cost) ?? 0) : prev.unit_cost},
          supplier = ${has('supplier') ? str(b.supplier, 200) : prev.supplier},
          instance_name = ${has('instance_name') ? (str(b.instance_name, 30) || 'IND') : prev.instance_name},
          description = ${has('description') ? str(b.description, 1000) : prev.description},
          is_active = ${has('is_active') ? b.is_active === true : prev.is_active},
          updated_at = now()
        WHERE id = ${id}
        RETURNING *`);
      res.json({ ok: true, material: (up.rows || [])[0] });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.delete('/api/industria/raw-materials/:id', async (req, res) => {
    try {
      const id = str(req.params.id, 60);
      if (!id) return res.status(400).json({ error: 'id invalido' });
      const refRec: any = await db.execute(sql`
        SELECT DISTINCT r.name FROM recipe_items ri JOIN recipes r ON r.id = ri.recipe_id
        WHERE ri.raw_material_id = ${id} LIMIT 10`);
      if ((refRec.rows || []).length) {
        return res.status(400).json({ error: 'material usado em receitas — remova dos ingredientes antes de excluir', recipes: (refRec.rows || []).map((r: any) => r.name) });
      }
      const refPo: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM production_order_items WHERE raw_material_id = ${id}`);
      if ((refPo.rows?.[0]?.n ?? 0) > 0) {
        return res.status(400).json({ error: 'material usado em ordens de producao — nao pode ser excluido (inative-o)' });
      }
      await db.execute(sql`DELETE FROM raw_material_movements WHERE raw_material_id = ${id}`);
      const del: any = await db.execute(sql`DELETE FROM raw_materials WHERE id = ${id} RETURNING id, name`);
      const row = (del.rows || [])[0];
      if (!row) return res.status(404).json({ error: 'material nao encontrado', id });
      console.log('🏭 [MP] material excluido', row.name);
      res.json({ ok: true, deleted: row });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Movimentação de estoque de matéria-prima.
  // entrada/entrada_compra/devolucao somam; saida/saida_producao/perda subtraem;
  // ajuste: "quantity" é o ESTOQUE FINAL desejado (grava o delta no histórico).
  app.post('/api/industria/raw-materials/:id/movement', async (req: any, res) => {
    try {
      const id = str(req.params.id, 60);
      if (!id) return res.status(400).json({ error: 'id invalido' });
      const b = req.body || {};
      const type = String(b.type || '').toLowerCase();
      if (!MOV_TYPES.has(type)) return res.status(400).json({ error: 'tipo invalido', tipos: Array.from(MOV_TYPES) });
      const q = num(b.quantity);
      if (q == null || q < 0) return res.status(400).json({ error: 'quantidade invalida' });
      const cur: any = await db.execute(sql`SELECT * FROM raw_materials WHERE id = ${id} LIMIT 1`);
      const mat = (cur.rows || [])[0];
      if (!mat) return res.status(404).json({ error: 'material nao encontrado', id });
      const prevQty = Number(mat.quantity) || 0;
      let newQty: number; let delta: number;
      if (type === 'ajuste') { newQty = q; delta = q - prevQty; }
      else if (MOV_IN.has(type)) { delta = q; newQty = prevQty + q; }
      else { delta = q; newQty = prevQty - q; }
      const unitCost = num(b.unit_cost);
      const by = userOf(req);
      await db.execute(sql`UPDATE raw_materials SET quantity = ${newQty}, unit_cost = ${unitCost != null ? unitCost : mat.unit_cost}, updated_at = now() WHERE id = ${id}`);
      const mov: any = await db.execute(sql`
        INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, production_order_id, notes, created_by, created_at, unit_cost)
        VALUES (gen_random_uuid()::varchar, ${id}, ${type}, ${Math.abs(delta)}, ${prevQty}, ${newQty}, NULL, ${str(b.notes, 500)}, ${by}, now(), ${unitCost != null ? unitCost : mat.unit_cost})
        RETURNING *`);
      console.log('🏭 [MP] movimentacao', mat.name, type, q, 'por', by);
      res.json({ ok: true, movement: (mov.rows || [])[0], material: { ...mat, quantity: newQty, unit_cost: unitCost != null ? unitCost : mat.unit_cost }, negativo: newQty < 0 });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/industria/raw-materials/:id/movements', async (req, res) => {
    try {
      const id = str(req.params.id, 60);
      const r: any = await db.execute(sql`
        SELECT m.*, rm.name AS material_name, rm.unit AS material_unit, po.order_number
        FROM raw_material_movements m
        LEFT JOIN raw_materials rm ON rm.id = m.raw_material_id
        LEFT JOIN production_orders po ON po.id = m.production_order_id
        WHERE m.raw_material_id = ${id}
        ORDER BY m.created_at DESC LIMIT 500`);
      res.json({ total: (r.rows || []).length, movements: r.rows || [] });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/industria/movements', async (_req, res) => {
    try {
      const r: any = await db.execute(sql`
        SELECT m.*, rm.name AS material_name, rm.unit AS material_unit, po.order_number
        FROM raw_material_movements m
        LEFT JOIN raw_materials rm ON rm.id = m.raw_material_id
        LEFT JOIN production_orders po ON po.id = m.production_order_id
        ORDER BY m.created_at DESC LIMIT 500`);
      res.json({ total: (r.rows || []).length, movements: r.rows || [] });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ========================== ORDENS DE PRODUÇÃO ==========================

  const loadOrders = async (): Promise<any[]> => {
    const po: any = await db.execute(sql`SELECT * FROM production_orders ORDER BY order_number DESC`);
    const its: any = await db.execute(sql`SELECT * FROM production_order_items`);
    const byOrder: Record<string, any[]> = {};
    for (const it of (its.rows || [])) {
      const k = String(it.production_order_id || '');
      (byOrder[k] = byOrder[k] || []).push(it);
    }
    // transfer_lock (Flavio 05/set): OP cujo lote esta numa NF/pedido de
    // transferencia nao pode ser reaberta nem excluida ate a nota ser
    // cancelada/devolvida. A tela esconde os botoes e mostra o motivo.
    let locks = new Map<string, any>();
    try { locks = await getProductionOrderTransferLocks(); } catch (e: any) { console.warn('[OP] travas de transferencia indisponiveis:', e?.message); }
    return (po.rows || []).map((o: any) => ({ ...o, items: byOrder[String(o.id)] || [], transfer_lock: locks.get(String(o.id)) || null }));
  };

  const nextOrderNumber = async (): Promise<string> => {
    const r: any = await db.execute(sql`SELECT order_number FROM production_orders WHERE order_number LIKE 'OP-%' ORDER BY order_number DESC LIMIT 1`);
    const last = (r.rows || [])[0]?.order_number || 'OP-00000';
    const n = (parseInt(String(last).replace(/\D/g, ''), 10) || 0) + 1;
    return 'OP-' + String(n).padStart(5, '0');
  };

  const replaceOrderItems = async (orderId: string, itemsIn: any[]): Promise<any[]> => {
    const clean = (Array.isArray(itemsIn) ? itemsIn : [])
      .map((it: any) => ({
        raw_material_id: str(it?.raw_material_id, 60),
        quantity_used: num(it?.quantity_used ?? it?.quantity),
        unit: str(it?.unit, 30),
        lot_number: str(it?.lot_number, 60),
      }))
      .filter((it) => it.raw_material_id && it.quantity_used != null && it.quantity_used > 0);
    await db.execute(sql`DELETE FROM production_order_items WHERE production_order_id = ${orderId}`);
    const out: any[] = [];
    for (const it of clean) {
      const rm: any = await db.execute(sql`SELECT name, unit FROM raw_materials WHERE id = ${it.raw_material_id} LIMIT 1`);
      const mat = (rm.rows || [])[0];
      const ins: any = await db.execute(sql`
        INSERT INTO production_order_items (id, production_order_id, raw_material_id, raw_material_name, quantity_used, unit, lot_number, lot_expiry_date)
        VALUES (gen_random_uuid()::varchar, ${orderId}, ${it.raw_material_id}, ${mat?.name || null}, ${it.quantity_used}, ${it.unit || mat?.unit || null}, ${it.lot_number}, NULL)
        RETURNING *`);
      out.push((ins.rows || [])[0]);
    }
    return out;
  };

  app.get('/api/industria/production-orders', async (_req, res) => {
    try {
      const orders = await loadOrders();
      res.json({ total: orders.length, orders });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/industria/production-orders', async (req: any, res) => {
    try {
      const b = req.body || {};
      const productName = str(b.product_name, 300);
      if (!productName) return res.status(400).json({ error: 'produto e obrigatorio' });
      const qty = num(b.quantity);
      if (qty == null || qty <= 0) return res.status(400).json({ error: 'quantidade invalida' });
      const status = ['planejada', 'em_producao'].includes(String(b.status)) ? String(b.status) : 'planejada';
      const orderNumber = await nextOrderNumber();
      const by = userOf(req);
      const ins: any = await db.execute(sql`
        INSERT INTO production_orders (id, order_number, product_id, product_name, quantity, instance_id, instance_name, status, start_date, end_date, notes, created_by, created_at, updated_at, production_date)
        VALUES (gen_random_uuid()::varchar, ${orderNumber}, ${str(b.product_id, 60)}, ${productName}, ${qty},
                ${str(b.instance_id, 60)}, ${str(b.instance_name, 30) || 'IND'}, ${status},
                ${status === 'em_producao' ? sql`now()` : sql`NULL`}, NULL, ${str(b.notes, 1000)}, ${by}, now(), now(),
                ${str(b.production_date, 20)})
        RETURNING *`);
      const order = (ins.rows || [])[0];
      let items: any[] = [];
      if (order && Array.isArray(b.items) && b.items.length) {
        items = await replaceOrderItems(String(order.id), b.items);
      }
      console.log('🏭 [OP] criada', orderNumber, productName, 'x', qty, 'por', by);
      res.json({ ok: true, order: { ...order, items } });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.patch('/api/industria/production-orders/:id', async (req: any, res) => {
    try {
      const id = str(req.params.id, 60);
      if (!id) return res.status(400).json({ error: 'id invalido' });
      const b = req.body || {};
      const cur: any = await db.execute(sql`SELECT * FROM production_orders WHERE id = ${id} LIMIT 1`);
      const prev = (cur.rows || [])[0];
      if (!prev) return res.status(404).json({ error: 'ordem nao encontrada', id });
      if (prev.status === 'finalizada') return res.status(400).json({ error: 'ordem finalizada nao pode ser editada' });
      const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
      const status = has('status') && ['planejada', 'em_producao', 'cancelada'].includes(String(b.status)) ? String(b.status) : prev.status;
      const startDate = (status === 'em_producao' && !prev.start_date) ? sql`now()` : sql`${prev.start_date}`;
      const up: any = await db.execute(sql`
        UPDATE production_orders SET
          product_id = ${has('product_id') ? str(b.product_id, 60) : prev.product_id},
          product_name = ${has('product_name') ? (str(b.product_name, 300) || prev.product_name) : prev.product_name},
          quantity = ${has('quantity') ? (num(b.quantity) ?? prev.quantity) : prev.quantity},
          instance_name = ${has('instance_name') ? (str(b.instance_name, 30) || 'IND') : prev.instance_name},
          status = ${status},
          start_date = ${startDate},
          production_date = ${has('production_date') ? str(b.production_date, 20) : prev.production_date},
          notes = ${has('notes') ? str(b.notes, 1000) : prev.notes},
          updated_at = now()
        WHERE id = ${id}
        RETURNING *`);
      let items: any[] | undefined;
      if (Array.isArray(b.items)) items = await replaceOrderItems(id, b.items);
      console.log('🏭 [OP] editada', prev.order_number, '→ status', status);
      res.json({ ok: true, order: { ...(up.rows || [])[0], ...(items ? { items } : {}) } });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.delete('/api/industria/production-orders/:id', async (req, res) => {
    try {
      const id = str(req.params.id, 60);
      if (!id) return res.status(400).json({ error: 'id invalido' });
      const cur: any = await db.execute(sql`SELECT * FROM production_orders WHERE id = ${id} LIMIT 1`);
      const prev = (cur.rows || [])[0];
      if (!prev) return res.status(404).json({ error: 'ordem nao encontrada', id });
      // Ordem finalizada PODE ser excluida (Flavio 29/ago) — mas só depois de
      // estornar o estoque que a finalização mexeu.
      let estorno: any = null;
      if (prev.status === 'finalizada') {
        // TRAVA: lote da OP em pedido/NF de transferencia -> primeiro cancela ou
        // devolve a nota (o estorno do estoque acontece la), so depois exclui.
        const lock = await getProductionOrderTransferLock(id);
        if (lock) return res.status(409).json({ error: `Ordem ${prev.order_number} travada — ${lock.reason}`, transfer_lock: lock });
        estorno = await reverseFinalization(id, prev, userOf(req as any));
        console.log('🏭 [OP] estorno antes de excluir', prev.order_number, estorno.undone);
      }
      // Os movimentos apontam para a ordem que vai sumir — solta a FK/referência
      // mas preserva o histórico de estoque (não se apaga movimentação).
      await db.execute(sql`UPDATE raw_material_movements SET production_order_id = NULL, notes = COALESCE(notes, '') || ${' (ordem ' + prev.order_number + ' excluida)'} WHERE production_order_id = ${id}`);
      await db.execute(sql`DELETE FROM production_order_items WHERE production_order_id = ${id}`);
      await db.execute(sql`DELETE FROM production_orders WHERE id = ${id}`);
      console.log('🏭 [OP] excluida', prev.order_number);
      res.json({ ok: true, deleted: { id, order_number: prev.order_number }, estorno, warnings: estorno?.warnings || [] });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ==========================================================================
  // BAIXA DE INSUMOS — regra unica (Flavio 05/set/2026)
  //
  // Historico: ja houve OP finalizada SEM baixa de materia-prima. As tres portas
  // por onde isso entrava:
  //   1) o cliente mandava `materials` vazio (OP criada sem itens, ou lista
  //      limpa na tela) e o servidor aceitava em silencio — zero baixa, zero aviso;
  //   2) material da lista nao encontrado (id antigo, material recriado) virava
  //      so um "warning" num toast e a linha era PULADA;
  //   3) a ordem era marcada 'finalizada' ANTES de mexer no estoque, fora de
  //      transacao: qualquer erro no meio deixava a OP finalizada sem baixa.
  // Agora: (1) sem insumos so com confirmacao explicita, e os itens gravados na
  // OP servem de fallback; (2) material inexistente e ERRO (400), nao aviso;
  // (3) tudo roda numa unica transacao — ou baixa tudo e finaliza, ou nada.
  // ==========================================================================
  type Insumo = { raw_material_id: string; quantity_used: number; lot_number: string | null; unit: string | null };

  const parseInsumos = (arr: any): Insumo[] => (Array.isArray(arr) ? arr : [])
    .map((m: any) => ({
      raw_material_id: str(m?.raw_material_id, 60) || '',
      quantity_used: num(m?.quantity_used ?? m?.quantity) ?? 0,
      lot_number: str(m?.lot_number, 60),
      unit: str(m?.unit, 30),
    }))
    .filter((m: Insumo) => m.raw_material_id && m.quantity_used > 0);

  // Insumos da OP a partir dos itens gravados nela (quando o cliente nao manda).
  const insumosDosItens = async (ex: any, orderId: string): Promise<Insumo[]> => {
    const r: any = await ex.execute(sql`SELECT raw_material_id, quantity_used, lot_number, unit FROM production_order_items WHERE production_order_id = ${orderId}`);
    return parseInsumos(r.rows || []);
  };

  // Insumos pela RECEITA do produto (quantidade da receita e por unidade produzida —
  // e assim que a tela "Usar Receita" preenche a OP). Ultimo recurso do reparo.
  const insumosDaReceita = async (ex: any, order: any, produced: number): Promise<{ insumos: Insumo[]; recipe: any | null }> => {
    const byId = order.product_id ? await ex.execute(sql`SELECT * FROM recipes WHERE product_id = ${String(order.product_id)} AND COALESCE(is_active, true) ORDER BY updated_at DESC NULLS LAST LIMIT 1`) : { rows: [] };
    let recipe = ((byId as any).rows || [])[0] || null;
    if (!recipe && order.product_name) {
      const byName: any = await ex.execute(sql`SELECT * FROM recipes WHERE (UPPER(TRIM(product_name)) = UPPER(${String(order.product_name).trim()}) OR UPPER(TRIM(name)) = UPPER(${String(order.product_name).trim()})) AND COALESCE(is_active, true) ORDER BY updated_at DESC NULLS LAST LIMIT 1`);
      recipe = (byName.rows || [])[0] || null;
    }
    if (!recipe) return { insumos: [], recipe: null };
    const its: any = await ex.execute(sql`SELECT raw_material_id, quantity, unit FROM recipe_items WHERE recipe_id = ${String(recipe.id)}`);
    const insumos = (its.rows || []).map((it: any) => ({
      raw_material_id: String(it.raw_material_id || ''),
      quantity_used: +(((num(it.quantity) ?? 0) * produced).toFixed(4)),
      lot_number: null,
      unit: str(it.unit, 30),
    })).filter((m: Insumo) => m.raw_material_id && m.quantity_used > 0);
    return { insumos, recipe };
  };

  // Executa a baixa (dentro da transacao do chamador). Lanca erro se algum
  // material nao existir — o chamador decide o que fazer (rollback).
  const baixarInsumos = async (ex: any, order: any, insumos: Insumo[], by: string, rotulo: string) => {
    const matRows: any[] = [];
    const faltando: string[] = [];
    for (const m of insumos) {
      const rm: any = await ex.execute(sql`SELECT * FROM raw_materials WHERE id = ${m.raw_material_id} LIMIT 1`);
      const mat = (rm.rows || [])[0];
      if (!mat) { faltando.push(m.raw_material_id); continue; }
      matRows.push({ req: m, mat });
    }
    if (faltando.length) {
      const e: any = new Error(`materia-prima nao encontrada no cadastro: ${faltando.join(', ')} — corrija a lista de insumos antes de finalizar`);
      e.code = 'MATERIAL_INEXISTENTE'; e.faltando = faltando; throw e;
    }
    const warnings: string[] = [];
    let totalCost = 0;
    const consumed: any[] = [];
    for (const { req: m, mat } of matRows) {
      const prevQty = Number(mat.quantity) || 0;
      const newQty = prevQty - m.quantity_used;
      const unitCost = Number(mat.unit_cost) || 0;
      totalCost += m.quantity_used * unitCost;
      await ex.execute(sql`UPDATE raw_materials SET quantity = ${newQty}, updated_at = now() WHERE id = ${mat.id}`);
      await ex.execute(sql`
        INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, production_order_id, notes, created_by, created_at, unit_cost)
        VALUES (gen_random_uuid()::varchar, ${mat.id}, 'saida_producao', ${m.quantity_used}, ${prevQty}, ${newQty}, ${String(order.id)}, ${rotulo + ' ' + order.order_number + (m.lot_number ? ' (lote insumo ' + m.lot_number + ')' : '')}, ${by}, now(), ${mat.unit_cost})`);
      if (newQty < 0) warnings.push(`estoque de ${mat.name} ficou negativo (${newQty})`);
      consumed.push({ raw_material_id: mat.id, name: mat.name, quantity_used: m.quantity_used, previous: prevQty, new: newQty, unit_cost: unitCost });
    }
    // Itens da ordem passam a refletir o consumo REAL (com lote do insumo)
    await ex.execute(sql`DELETE FROM production_order_items WHERE production_order_id = ${String(order.id)}`);
    for (const { req: m, mat } of matRows) {
      await ex.execute(sql`
        INSERT INTO production_order_items (id, production_order_id, raw_material_id, raw_material_name, quantity_used, unit, lot_number, lot_expiry_date)
        VALUES (gen_random_uuid()::varchar, ${String(order.id)}, ${m.raw_material_id}, ${mat?.name || null}, ${m.quantity_used}, ${m.unit || mat?.unit || null}, ${m.lot_number}, NULL)`);
    }
    return { totalCost, warnings, consumed };
  };

  // Ja existe baixa (saida_producao nao estornada) para a ordem?
  const temBaixa = async (ex: any, orderId: string): Promise<number> => {
    const r: any = await ex.execute(sql`
      SELECT COUNT(*)::int AS n FROM raw_material_movements
      WHERE production_order_id = ${orderId} AND movement_type = 'saida_producao'
        AND COALESCE(notes, '') NOT LIKE ${'%' + EST_MARK + '%'}`);
    return Number((r.rows || [])[0]?.n || 0);
  };

  // Finalização: baixa insumos (saida_producao), grava qualidade/pasteurização,
  // calcula CMV e dá entrada do produto acabado:
  //  - produto do catálogo → cria lote em inventory_lots (in_use) + movimento 'replenish'
  //  - matéria-prima (ex.: polpa produzida) → soma no estoque de raw_materials
  // TUDO numa transacao: se qualquer passo falhar, a ordem NAO fica finalizada.
  app.post('/api/industria/production-orders/:id/finalize', async (req: any, res) => {
    try {
      const id = str(req.params.id, 60);
      if (!id) return res.status(400).json({ error: 'id invalido' });
      const b = req.body || {};
      const cur: any = await db.execute(sql`SELECT * FROM production_orders WHERE id = ${id} LIMIT 1`);
      const order = (cur.rows || [])[0];
      if (!order) return res.status(404).json({ error: 'ordem nao encontrada', id });
      if (order.status === 'finalizada') return res.status(400).json({ error: 'ordem ja finalizada' });
      const produced = num(b.quantity_produced);
      if (produced == null || produced <= 0) return res.status(400).json({ error: 'quantidade produzida invalida' });
      const lotNumber = str(b.lot_number, 60);
      if (!lotNumber) return res.status(400).json({ error: 'numero do lote do produto acabado e obrigatorio' });
      const lotExpiry = str(b.lot_expiry_date, 20);
      if (!lotExpiry) return res.status(400).json({ error: 'validade do lote produzido e obrigatoria' });
      const by = userOf(req);

      // 0) Insumos: o que a tela mandou; se nao mandou nada, os itens gravados na
      //    OP. Sem nenhum dos dois, so finaliza com confirmacao explicita — e fica
      //    registrado em notes quem confirmou.
      let insumos = parseInsumos(b.materials);
      let origemInsumos: 'tela' | 'itens_da_op' | 'nenhum' = insumos.length ? 'tela' : 'nenhum';
      if (!insumos.length) {
        insumos = await insumosDosItens(db, id);
        if (insumos.length) origemInsumos = 'itens_da_op';
      }
      if (!insumos.length && b.confirm_sem_insumos !== true) {
        return res.status(400).json({
          error: 'Nenhuma materia-prima informada: a finalizacao NAO daria baixa em insumo nenhum. Informe os insumos consumidos (ou confirme explicitamente a finalizacao sem baixa).',
          code: 'SEM_INSUMOS',
        });
      }

      const lotExpiryBR = /^\d{4}-\d{2}-\d{2}$/.test(lotExpiry) ? lotExpiry.split('-').reverse().join('/') : lotExpiry;
      const prodDate = str(b.production_date, 20)
        || (order.production_date ? String(order.production_date).slice(0, 10) : new Date().toISOString().slice(0, 10));

      const result = await db.transaction(async (tx: any) => {
        // 1) Claim atomico (blinda clique duplo). Dentro da transacao: se algo
        //    falhar depois, o UPDATE e desfeito junto.
        const claim: any = await tx.execute(sql`UPDATE production_orders SET status = 'finalizada', updated_at = now() WHERE id = ${id} AND status <> 'finalizada' RETURNING id`);
        if (!(claim.rows || []).length) { const e: any = new Error('ordem ja finalizada (ou em finalizacao) — recarregue a lista'); e.status = 400; throw e; }

        // 2) Baixa de insumos (materiais inexistentes -> erro -> rollback)
        const baixa = insumos.length
          ? await baixarInsumos(tx, { ...order, id }, insumos, by, 'Consumo na ordem')
          : { totalCost: 0, warnings: [] as string[], consumed: [] as any[] };
        const warnings = [...baixa.warnings];
        const totalCost = baixa.totalCost;
        const cmvUnit = produced > 0 ? totalCost / produced : 0;
        const cmvNote = `CMV: R$ ${totalCost.toFixed(2)} (unit. R$ ${cmvUnit.toFixed(4)}) — lote ${lotNumber}, validade ${lotExpiryBR}`;
        const baixaNote = insumos.length
          ? `Baixa de insumos: ${baixa.consumed.length} item(ns)${origemInsumos === 'itens_da_op' ? ' (itens da OP)' : ''}`
          : `SEM BAIXA DE INSUMOS (confirmado por ${by})`;
        if (!insumos.length) warnings.push('finalizada SEM baixa de materia-prima (confirmado)');
        const notes = [str(b.notes, 800) || order.notes || '', baixaNote, cmvNote].filter(Boolean).join(' | ');

        // 3) Dados da finalizacao
        const up: any = await tx.execute(sql`
          UPDATE production_orders SET
            quantity = ${produced},
            start_date = COALESCE(start_date, now()),
            end_date = now(),
            production_date = ${prodDate},
            brix_degree = ${num(b.brix_degree)},
            ph = ${num(b.ph)},
            sensory_analysis = ${str(b.sensory_analysis, 30)},
            lot_expiry_date = ${lotExpiry},
            lot_number = ${lotNumber},
            pasteurization_start_time = ${str(b.pasteurization_start_time, 10)},
            pasteurization_end_time = ${str(b.pasteurization_end_time, 10)},
            pasteurization_start_temp = ${num(b.pasteurization_start_temp)},
            pasteurization_end_temp = ${num(b.pasteurization_end_temp)},
            notes = ${notes.slice(0, 1000)},
            updated_at = now()
          WHERE id = ${id}
          RETURNING *`);

        // 4) Entrada do produto acabado
        let finished: any = null;
        const productId = order.product_id ? String(order.product_id) : null;
        const productName = String(order.product_name || '').trim();

        let matDest: any = null;
        if (productId) {
          const r1: any = await tx.execute(sql`SELECT * FROM raw_materials WHERE id = ${productId} LIMIT 1`);
          matDest = (r1.rows || [])[0] || null;
        }
        if (!matDest && productName) {
          const r2: any = await tx.execute(sql`SELECT * FROM raw_materials WHERE UPPER(TRIM(name)) = UPPER(${productName}) LIMIT 1`);
          matDest = (r2.rows || [])[0] || null;
        }

        if (matDest) {
          const prevQty = Number(matDest.quantity) || 0;
          const newQty = prevQty + produced;
          await tx.execute(sql`UPDATE raw_materials SET quantity = ${newQty}, updated_at = now() WHERE id = ${matDest.id}`);
          await tx.execute(sql`
            INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, production_order_id, notes, created_by, created_at, unit_cost)
            VALUES (gen_random_uuid()::varchar, ${matDest.id}, 'entrada', ${produced}, ${prevQty}, ${newQty}, ${id}, ${'Produção ' + order.order_number + ' — lote ' + lotNumber}, ${by}, now(), ${matDest.unit_cost})`);
          finished = { type: 'raw_material', name: matDest.name, newQuantity: newQty };
        } else {
          let prodId = productId;
          if (prodId) {
            const chk: any = await tx.execute(sql`SELECT id FROM products WHERE id = ${prodId} LIMIT 1`);
            if (!(chk.rows || []).length) prodId = null;
          }
          if (!prodId && productName) {
            const rp: any = await tx.execute(sql`SELECT id FROM products WHERE UPPER(TRIM(name)) = UPPER(${productName}) LIMIT 1`);
            prodId = String((rp.rows || [])[0]?.id || '') || null;
          }
          if (prodId) {
            // Lote de produto acabado SEMPRE na instância IND (Indústria)
            const indQ: any = await tx.execute(sql`SELECT id FROM omie_instances WHERE UPPER(name) = 'IND' LIMIT 1`);
            let instanceId = String((indQ.rows || [])[0]?.id || '');
            if (!instanceId) {
              warnings.push("instancia IND nao encontrada em omie_instances — usando instance_id da ordem");
              instanceId = String(order.instance_id || '') || 'IND';
            }
            // CMV congelado no lote (Flavio, 01/set) — inline (sem storage) para
            // ficar na MESMA transacao da baixa.
            const lotIns: any = await tx.execute(sql`
              INSERT INTO inventory_lots (product_id, instance_id, stock_type, lot_number, quantity, min_quantity, unit_cost, total_cost, production_order_id, notes, is_active)
              VALUES (${prodId}, ${instanceId}, 'in_use', ${lotNumber}, ${String(produced)}, '0',
                      ${cmvUnit > 0 ? cmvUnit.toFixed(4) : null}, ${totalCost > 0 ? totalCost.toFixed(2) : null}, ${id},
                      ${'Produzido via ' + order.order_number + ' — validade ' + lotExpiry}, true)
              RETURNING id`);
            const lotId = String((lotIns.rows || [])[0]?.id || '');
            await tx.execute(sql`
              INSERT INTO inventory_movements (lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by)
              VALUES (${lotId}, ${prodId}, ${instanceId}, 'replenish', ${String(produced)}, '0', ${String(produced)}, 'order', ${id}, ${lotNumber}, ${'Entrada por finalização da ' + order.order_number}, ${by})`);
            finished = { type: 'inventory_lot', lotId, lotNumber, quantity: produced, instanceId };
          } else {
            warnings.push('produto da ordem nao encontrado nem em materias-primas nem no catalogo — produzido NAO foi lancado em estoque');
          }
        }

        return { order: (up.rows || [])[0], cmv: { total: totalCost, unit: cmvUnit }, finished, warnings, consumed: baixa.consumed, origemInsumos };
      });

      console.log('🏭 [OP] FINALIZADA', order.order_number, 'produzido', produced, 'lote', lotNumber, 'insumos', result.consumed.length, `(${result.origemInsumos})`, 'CMV', result.cmv.total.toFixed(2), 'por', by);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      const status = e?.status || (e?.code === 'MATERIAL_INEXISTENTE' ? 400 : 500);
      if (status !== 500) return res.status(status).json({ error: e?.message || String(e), code: e?.code, faltando: e?.faltando });
      console.error('❌ [OP] finalizacao falhou (nada foi gravado):', e?.message || e);
      res.status(500).json({ error: 'Finalizacao NAO concluida (nada foi gravado): ' + (e?.message || String(e)) });
    }
  });

  // --------------------------------------------------------------------------
  // AUDITORIA: ordens finalizadas SEM baixa de insumo (os casos que ja
  // aconteceram). Lista o que falta e de onde o reparo pode tirar as quantidades.
  // --------------------------------------------------------------------------
  app.get('/api/industria/production-orders/auditoria-baixa', async (_req, res) => {
    try {
      const r: any = await db.execute(sql`
        SELECT po.*,
               (SELECT COUNT(*)::int FROM production_order_items i WHERE i.production_order_id = po.id) AS itens,
               (SELECT COUNT(*)::int FROM raw_material_movements m WHERE m.production_order_id = po.id AND m.movement_type = 'saida_producao'
                  AND COALESCE(m.notes, '') NOT LIKE ${'%' + EST_MARK + '%'}) AS baixas
        FROM production_orders po
        WHERE po.status = 'finalizada'
        ORDER BY po.order_number DESC`);
      const semBaixa: any[] = [];
      for (const o of (r.rows || [])) {
        if (Number(o.baixas) > 0) continue;
        const confirmada = /SEM BAIXA DE INSUMOS/.test(String(o.notes || ''));
        let fonte: 'itens_da_op' | 'receita' | 'nenhuma' = 'nenhuma';
        let previa: Insumo[] = [];
        if (Number(o.itens) > 0) { fonte = 'itens_da_op'; previa = await insumosDosItens(db, String(o.id)); }
        if (!previa.length) {
          const { insumos } = await insumosDaReceita(db, o, Number(o.quantity) || 0);
          if (insumos.length) { fonte = 'receita'; previa = insumos; }
        }
        const nomes: any = previa.length
          ? await db.execute(sql`SELECT id, name, unit, quantity, unit_cost FROM raw_materials WHERE id IN (${sql.join(previa.map((p) => sql`${p.raw_material_id}`), sql`, `)})`)
          : { rows: [] };
        const nomeMap = new Map<string, any>((nomes.rows || []).map((x: any) => [String(x.id), x]));
        semBaixa.push({
          id: o.id, order_number: o.order_number, product_name: o.product_name, quantity: o.quantity,
          production_date: o.production_date, end_date: o.end_date, lot_number: o.lot_number, notes: o.notes,
          confirmada_sem_baixa: confirmada, fonte,
          previa: previa.map((p) => ({ ...p, name: nomeMap.get(p.raw_material_id)?.name || null, estoque: nomeMap.get(p.raw_material_id)?.quantity ?? null, existe: nomeMap.has(p.raw_material_id) })),
        });
      }
      res.json({ total: semBaixa.length, orders: semBaixa });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // --------------------------------------------------------------------------
  // REPARO: baixa retroativa dos insumos de uma OP finalizada sem baixa.
  // Fonte (nesta ordem): body.materials -> itens da OP -> receita do produto.
  // Idempotente (recusa se ja houver saida_producao viva) e transacional.
  // Tambem grava o CMV no lote produzido, que nasceu zerado.
  // --------------------------------------------------------------------------
  app.post('/api/industria/production-orders/:id/baixar-insumos', async (req: any, res) => {
    try {
      const id = str(req.params.id, 60);
      if (!id) return res.status(400).json({ error: 'id invalido' });
      const b = req.body || {};
      const cur: any = await db.execute(sql`SELECT * FROM production_orders WHERE id = ${id} LIMIT 1`);
      const order = (cur.rows || [])[0];
      if (!order) return res.status(404).json({ error: 'ordem nao encontrada', id });
      if (order.status !== 'finalizada') return res.status(400).json({ error: 'so ordem finalizada recebe baixa retroativa', status: order.status });
      if (await temBaixa(db, id) > 0) return res.status(409).json({ error: `ordem ${order.order_number} ja tem baixa de insumos registrada` });
      const by = userOf(req);
      const produced = Number(order.quantity) || 0;

      let insumos = parseInsumos(b.materials); let fonte = 'informado';
      if (!insumos.length) { insumos = await insumosDosItens(db, id); fonte = 'itens_da_op'; }
      let recipeName: string | null = null;
      if (!insumos.length) { const rr = await insumosDaReceita(db, order, produced); insumos = rr.insumos; fonte = 'receita'; recipeName = rr.recipe?.name || null; }
      if (!insumos.length) return res.status(400).json({ error: 'sem fonte para a baixa: a OP nao tem itens e o produto nao tem receita — informe os insumos', code: 'SEM_FONTE' });

      const result = await db.transaction(async (tx: any) => {
        // trava a linha para dois reparos simultaneos nao baixarem duas vezes
        await tx.execute(sql`SELECT id FROM production_orders WHERE id = ${id} FOR UPDATE`);
        if (await temBaixa(tx, id) > 0) { const e: any = new Error('baixa ja registrada por outra requisicao'); e.status = 409; throw e; }
        const baixa = await baixarInsumos(tx, { ...order, id }, insumos, by, 'Baixa retroativa (reparo) na ordem');
        const cmvUnit = produced > 0 ? baixa.totalCost / produced : 0;
        // CMV no lote produzido (so se ainda nao tiver custo — nao atropela ajuste manual)
        await tx.execute(sql`UPDATE inventory_lots SET unit_cost = ${cmvUnit > 0 ? cmvUnit.toFixed(4) : null}, total_cost = ${baixa.totalCost > 0 ? baixa.totalCost.toFixed(2) : null}, updated_at = now()
          WHERE production_order_id = ${id} AND unit_cost IS NULL`);
        const nota = `Baixa retroativa de insumos em ${new Date().toISOString().slice(0, 10)} por ${by} (fonte: ${fonte}${recipeName ? ' ' + recipeName : ''}, ${baixa.consumed.length} item(ns)) | CMV: R$ ${baixa.totalCost.toFixed(2)} (unit. R$ ${cmvUnit.toFixed(4)})`;
        await tx.execute(sql`UPDATE production_orders SET notes = ${[stripCmvNote(order.notes), nota].filter(Boolean).join(' | ').slice(0, 1000)}, updated_at = now() WHERE id = ${id}`);
        return { ...baixa, cmv: { total: baixa.totalCost, unit: cmvUnit }, fonte, recipeName };
      });
      console.log('🏭 [OP] BAIXA RETROATIVA', order.order_number, result.consumed.length, 'insumo(s), fonte', fonte, 'por', by);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      const status = e?.status || (e?.code === 'MATERIAL_INEXISTENTE' ? 400 : 500);
      res.status(status).json({ error: e?.message || String(e), code: e?.code, faltando: e?.faltando });
    }
  });

  // Reabertura (Flavio 29/ago): ordem finalizada volta para 'em_producao' para
  // correção. Estorna TODO o estoque da finalização antes — matéria-prima
  // consumida volta, lote de produto acabado é baixado — para que a nova
  // finalização não baixe nada duas vezes. Mantém brix/pH/pasteurização e o
  // lote/validade preenchidos, para o operador só corrigir o que errou.
  app.post('/api/industria/production-orders/:id/reopen', async (req: any, res) => {
    try {
      const id = str(req.params.id, 60);
      if (!id) return res.status(400).json({ error: 'id invalido' });
      const cur: any = await db.execute(sql`SELECT * FROM production_orders WHERE id = ${id} LIMIT 1`);
      const order = (cur.rows || [])[0];
      if (!order) return res.status(404).json({ error: 'ordem nao encontrada', id });
      if (order.status !== 'finalizada') return res.status(400).json({ error: 'so ordem finalizada pode ser reaberta', status: order.status });
      const by = userOf(req);

      // TRAVA (Flavio 05/set): o lote produzido esta numa NF de transferencia.
      // Reabrir agora zeraria um lote que a NF diz ter saido. Cancelar/devolver a
      // nota estorna o estoque (origem e destino) e ai a ordem pode ser reaberta.
      const lock = await getProductionOrderTransferLock(id);
      if (lock) return res.status(409).json({ error: `Ordem ${order.order_number} travada — ${lock.reason}`, transfer_lock: lock });

      const { undone, warnings } = await reverseFinalization(id, order, by);

      // Claim atômico: só reabre quem ainda está finalizada (blinda clique duplo)
      const up: any = await db.execute(sql`
        UPDATE production_orders SET
          status = 'em_producao',
          end_date = NULL,
          notes = ${stripCmvNote(order.notes)},
          updated_at = now()
        WHERE id = ${id} AND status = 'finalizada'
        RETURNING *`);
      if (!(up.rows || []).length) return res.status(400).json({ error: 'ordem ja foi reaberta — recarregue a lista' });

      console.log('🏭 [OP] REABERTA', order.order_number, 'estorno:', undone, 'por', by);
      res.json({ ok: true, order: (up.rows || [])[0], estorno: undone, warnings });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  console.log('✅ Industria routes (modulo completo) registradas');
}
