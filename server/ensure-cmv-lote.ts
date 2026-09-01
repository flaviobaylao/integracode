import { db } from "./db";
import { sql } from "drizzle-orm";

/**
 * CMV por lote de produto acabado (Flavio, 01/set/2026).
 *
 * Ate aqui o CMV existia SO como texto no rodape de `production_orders.notes`
 * ("CMV: R$ 1.234,56 (unit. R$ 0,4115) — lote H280826, validade 28/02/2027"),
 * o que serve para leitura humana e para mais nada: nao da para somar, ordenar,
 * nem precificar um pedido de transferencia com ele.
 *
 * Aqui o custo passa a viver em colunas do proprio lote, CONGELADO no momento da
 * producao. Recalcular na leitura (lote -> movimento -> ordem -> itens x
 * raw_materials.unit_cost) faria o CMV historico mudar toda vez que o custo de uma
 * materia-prima fosse atualizado — o lote de agosto seria reprecificado pelo preco
 * da polpa de setembro. O CMV de um lote e um fato do dia em que ele foi produzido.
 *
 * Idempotente: roda no boot, so cria o que falta e so preenche linha com custo nulo.
 */
export async function ensureCmvLoteColumns(): Promise<{ ok: boolean; backfilled?: number; error?: string }> {
  try {
    await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,4)`);
    await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14,2)`);
    await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS production_order_id VARCHAR`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_inventory_lots_prod_order ON inventory_lots (production_order_id)`);

    // ── Backfill dos lotes que ja existem ────────────────────────────────────
    // O vinculo lote -> ordem NAO vem do texto de notes (fragil: "Produzido via
    // OP-00016 — validade ..."), e sim de inventory_movements, onde a finalizacao
    // gravou source_type='order' + source_id=<id da ordem>. Esse par ja e indexado
    // (idx_inventory_movements_source) e e o registro canonico do evento.
    const link: any = await db.execute(sql`
      UPDATE inventory_lots l
         SET production_order_id = m.source_id
        FROM (
          SELECT DISTINCT ON (lot_id) lot_id, source_id
            FROM inventory_movements
           WHERE source_type = 'order' AND source_id IS NOT NULL
           ORDER BY lot_id, created_at ASC
        ) m
       WHERE m.lot_id = l.id
         AND l.production_order_id IS NULL
      RETURNING l.id`);

    // Custo historico = soma de (quantidade consumida x custo unitario GRAVADO NO
    // MOVIMENTO). raw_material_movements.unit_cost guarda o custo vigente no dia da
    // baixa; usar raw_materials.unit_cost aqui traria o preco de hoje e falsearia o
    // CMV dos lotes antigos — exatamente o que estas colunas existem para evitar.
    // Lotes cujo movimento nao registrou custo ficam NULL de proposito: a tela
    // mostra "—" em vez de um zero que parece custo real.
    const fill: any = await db.execute(sql`
      UPDATE inventory_lots l
         SET total_cost = c.total,
             unit_cost  = CASE WHEN po.quantity > 0 THEN c.total / po.quantity ELSE NULL END
        FROM production_orders po
        JOIN (
          SELECT production_order_id, SUM(quantity * COALESCE(unit_cost, 0)) AS total
            FROM raw_material_movements
           WHERE movement_type = 'saida_producao' AND production_order_id IS NOT NULL
           GROUP BY production_order_id
          HAVING SUM(COALESCE(unit_cost, 0)) > 0
        ) c ON c.production_order_id = po.id
       WHERE l.production_order_id = po.id
         AND l.unit_cost IS NULL
      RETURNING l.id`);

    const backfilled = (fill.rows || []).length;
    console.log(`✅ [CMV-LOTE] colunas ok — vinculados ${(link.rows || []).length} lote(s) a ordens, CMV preenchido em ${backfilled}`);
    return { ok: true, backfilled };
  } catch (e: any) {
    console.warn('⚠️ [CMV-LOTE] ensureCmvLoteColumns falhou:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
