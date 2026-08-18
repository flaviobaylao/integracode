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
import { storage } from "./storage";

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

export function registerIndustriaRoutes(app: Express) {

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
    return (po.rows || []).map((o: any) => ({ ...o, items: byOrder[String(o.id)] || [] }));
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
      if (prev.status === 'finalizada') return res.status(400).json({ error: 'ordem finalizada nao pode ser excluida' });
      await db.execute(sql`DELETE FROM production_order_items WHERE production_order_id = ${id}`);
      await db.execute(sql`DELETE FROM production_orders WHERE id = ${id}`);
      console.log('🏭 [OP] excluida', prev.order_number);
      res.json({ ok: true, deleted: { id, order_number: prev.order_number } });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Finalização: baixa insumos (saida_producao), grava qualidade/pasteurização,
  // calcula CMV e dá entrada do produto acabado:
  //  - produto do catálogo → cria lote em inventory_lots (in_use) + movimento 'replenish'
  //  - matéria-prima (ex.: polpa produzida) → soma no estoque de raw_materials
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

      // 0) Pré-carrega os materiais (SÓ leitura) e calcula o CMV ANTES de qualquer escrita
      const materials = (Array.isArray(b.materials) ? b.materials : [])
        .map((m: any) => ({ raw_material_id: str(m?.raw_material_id, 60), quantity_used: num(m?.quantity_used), lot_number: str(m?.lot_number, 60), unit: str(m?.unit, 30) }))
        .filter((m: any) => m.raw_material_id && m.quantity_used != null && m.quantity_used > 0);
      const warnings: string[] = [];
      const matRows: any[] = [];
      let totalCost = 0;
      for (const m of materials) {
        const rm: any = await db.execute(sql`SELECT * FROM raw_materials WHERE id = ${m.raw_material_id} LIMIT 1`);
        const mat = (rm.rows || [])[0];
        if (!mat) { warnings.push(`material ${m.raw_material_id} nao encontrado — ignorado`); continue; }
        totalCost += m.quantity_used! * (Number(mat.unit_cost) || 0);
        matRows.push({ req: m, mat });
      }
      const cmvUnit = produced > 0 ? totalCost / produced : 0;
      const cmvNote = `CMV: R$ ${totalCost.toFixed(2)} (unit. R$ ${cmvUnit.toFixed(4)}) — lote ${lotNumber}, validade ${lotExpiry}`;
      const notes = [str(b.notes, 800) || order.notes || '', cmvNote].filter(Boolean).join(' | ');
      // production_date é coluna DATE — resolve em JS (COALESCE com texto quebrava: bug 18/ago)
      const prodDate = str(b.production_date, 20)
        || (order.production_date ? String(order.production_date).slice(0, 10) : new Date().toISOString().slice(0, 10));

      // 1) "Claim" atômico: finaliza a ordem PRIMEIRO (WHERE status != finalizada).
      //    Blinda contra clique duplo/concorrência e valida os tipos antes de mexer no estoque.
      const up: any = await db.execute(sql`
        UPDATE production_orders SET
          status = 'finalizada',
          quantity = ${produced},
          start_date = COALESCE(start_date, now()),
          end_date = now(),
          production_date = ${prodDate},
          brix_degree = ${num(b.brix_degree)},
          ph = ${num(b.ph)},
          sensory_analysis = ${str(b.sensory_analysis, 30)},
          lot_expiry_date = ${lotExpiry},
          pasteurization_start_time = ${str(b.pasteurization_start_time, 10)},
          pasteurization_end_time = ${str(b.pasteurization_end_time, 10)},
          pasteurization_start_temp = ${num(b.pasteurization_start_temp)},
          pasteurization_end_temp = ${num(b.pasteurization_end_temp)},
          notes = ${notes.slice(0, 1000)},
          updated_at = now()
        WHERE id = ${id} AND status <> 'finalizada'
        RETURNING *`);
      if (!(up.rows || []).length) return res.status(400).json({ error: 'ordem ja finalizada (ou em finalizacao) — recarregue a lista' });

      // 2) Consome matérias-primas (quantidades REAIS informadas na finalização)
      for (const { req: m, mat } of matRows) {
        const prevQty = Number(mat.quantity) || 0;
        const newQty = prevQty - m.quantity_used!;
        await db.execute(sql`UPDATE raw_materials SET quantity = ${newQty}, updated_at = now() WHERE id = ${mat.id}`);
        await db.execute(sql`
          INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, production_order_id, notes, created_by, created_at, unit_cost)
          VALUES (gen_random_uuid()::varchar, ${mat.id}, 'saida_producao', ${m.quantity_used}, ${prevQty}, ${newQty}, ${id}, ${'Consumo na ordem ' + order.order_number + (m.lot_number ? ' (lote insumo ' + m.lot_number + ')' : '')}, ${by}, now(), ${mat.unit_cost})`);
        if (newQty < 0) warnings.push(`estoque de ${mat.name} ficou negativo (${newQty})`);
      }

      // 3) Itens da ordem passam a refletir o consumo REAL (com lote do insumo)
      await db.execute(sql`DELETE FROM production_order_items WHERE production_order_id = ${id}`);
      for (const { req: m, mat } of matRows) {
        await db.execute(sql`
          INSERT INTO production_order_items (id, production_order_id, raw_material_id, raw_material_name, quantity_used, unit, lot_number, lot_expiry_date)
          VALUES (gen_random_uuid()::varchar, ${id}, ${m.raw_material_id}, ${mat?.name || null}, ${m.quantity_used}, ${m.unit || mat?.unit || null}, ${m.lot_number}, NULL)`);
      }

      // 4) Entrada do produto acabado
      let finished: any = null;
      const productId = order.product_id ? String(order.product_id) : null;
      if (productId) {
        const rmDest: any = await db.execute(sql`SELECT * FROM raw_materials WHERE id = ${productId} LIMIT 1`);
        const matDest = (rmDest.rows || [])[0];
        if (matDest) {
          // produto da ordem é uma matéria-prima (ex.: polpa) → entra no estoque de MP
          const prevQty = Number(matDest.quantity) || 0;
          const newQty = prevQty + produced;
          await db.execute(sql`UPDATE raw_materials SET quantity = ${newQty}, updated_at = now() WHERE id = ${matDest.id}`);
          await db.execute(sql`
            INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, production_order_id, notes, created_by, created_at, unit_cost)
            VALUES (gen_random_uuid()::varchar, ${matDest.id}, 'entrada', ${produced}, ${prevQty}, ${newQty}, ${id}, ${'Produção ' + order.order_number + ' — lote ' + lotNumber}, ${by}, now(), ${matDest.unit_cost})`);
          finished = { type: 'raw_material', name: matDest.name, newQuantity: newQty };
        } else {
          // produto do catálogo → lote de produto acabado (inventory_lots)
          try {
            // resolve a instância real do produto (inventory_lots.instance_id)
            let instanceId = String(order.instance_id || '');
            if (!instanceId) {
              const pr: any = await db.execute(sql`SELECT omie_instance_id FROM products WHERE id = ${productId} LIMIT 1`);
              instanceId = String((pr.rows || [])[0]?.omie_instance_id || '') || 'IND';
            }
            const lot = await storage.createInventoryLot({
              productId,
              instanceId,
              stockType: 'in_use',
              lotNumber,
              quantity: String(produced),
              minQuantity: '0',
              notes: `Produzido via ${order.order_number} — validade ${lotExpiry}`,
            } as any);
            await storage.createInventoryMovement({
              lotId: lot.id,
              productId,
              instanceId,
              movementType: 'replenish',
              quantity: String(produced),
              previousQuantity: '0',
              newQuantity: String(produced),
              sourceType: 'order',
              sourceId: id,
              lotNumber,
              notes: `Entrada por finalização da ${order.order_number}`,
              createdBy: by,
            } as any);
            finished = { type: 'inventory_lot', lotId: lot.id, lotNumber, quantity: produced };
          } catch (invErr: any) {
            warnings.push('estoque acabado: ' + String(invErr?.message || invErr).slice(0, 200));
          }
        }
      } else {
        warnings.push('ordem sem product_id — produto acabado nao foi lancado em estoque');
      }

      console.log('🏭 [OP] FINALIZADA', order.order_number, 'produzido', produced, 'lote', lotNumber, 'CMV', totalCost.toFixed(2), 'por', by);
      res.json({ ok: true, order: (up.rows || [])[0], cmv: { total: totalCost, unit: cmvUnit }, finished, warnings });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  console.log('✅ Industria routes (modulo completo) registradas');
}
