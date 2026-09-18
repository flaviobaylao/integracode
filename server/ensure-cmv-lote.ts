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
export async function ensureCmvLoteColumns(): Promise<{ ok: boolean; backfilled?: number; repaired?: number; herdados?: number; estimados?: number; error?: string }> {
  try {
    await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,4)`);
    await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14,2)`);
    await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS production_order_id VARCHAR`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_inventory_lots_prod_order ON inventory_lots (production_order_id)`);
    // true = unit_cost e uma ESTIMATIVA (media do produto), nao o custo daquele lote.
    await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS cmv_estimado BOOLEAN NOT NULL DEFAULT false`);

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
    // ⚠️ SO O ULTIMO MOVIMENTO DE CADA MATERIA-PRIMA (bug pego em producao, 01/set).
    // A 1a versao somava TODOS os 'saida_producao' da ordem. Ordem reaberta e
    // refinalizada — ou vitima do bug de consumo duplo de 18/ago — acumula varios
    // conjuntos de movimentos, e a soma cega dobrava o CMV: a OP-00017 saiu com
    // R$ 8,2667/un contra os R$ 4,1334 que a propria finalizacao registrou, e a
    // OP-00008 (30 movimentos, com estorno) ficou 5x. Uma refinalizacao REESCREVE o
    // consumo daquele material; as tentativas anteriores sao historico de erro, nao
    // custo. Com DISTINCT ON, os 8 lotes com CMV batem com o rodape das ordens.
    const fill: any = await db.execute(sql`
      UPDATE inventory_lots l
         SET total_cost = c.total,
             unit_cost  = CASE WHEN po.quantity > 0 THEN c.total / po.quantity ELSE NULL END
        FROM production_orders po
        JOIN (
          SELECT production_order_id, SUM(quantity * COALESCE(unit_cost, 0)) AS total
            FROM (
              SELECT DISTINCT ON (production_order_id, raw_material_id)
                     production_order_id, raw_material_id, quantity, unit_cost
                FROM raw_material_movements
               WHERE movement_type = 'saida_producao' AND production_order_id IS NOT NULL
               ORDER BY production_order_id, raw_material_id, created_at DESC
            ) ult
           GROUP BY production_order_id
          HAVING SUM(COALESCE(unit_cost, 0)) > 0
        ) c ON c.production_order_id = po.id
       WHERE l.production_order_id = po.id
         AND l.unit_cost IS NULL
      RETURNING l.id`);

    // Reparo unico dos lotes que a 1a versao ja gravou inflados. Roda so uma vez
    // (marca em system_settings) para nunca sobrescrever uma correcao manual futura.
    let repaired = 0;
    try {
      const marca: any = await db.execute(
        sql`SELECT 1 FROM system_settings WHERE key = 'cmv_lote_repair_ultimo_movimento' LIMIT 1`);
      if (!(marca.rows || []).length) {
        const rep: any = await db.execute(sql`
          UPDATE inventory_lots l
             SET total_cost = c.total,
                 unit_cost  = CASE WHEN po.quantity > 0 THEN c.total / po.quantity ELSE NULL END
            FROM production_orders po
            JOIN (
              SELECT production_order_id, SUM(quantity * COALESCE(unit_cost, 0)) AS total
                FROM (
                  SELECT DISTINCT ON (production_order_id, raw_material_id)
                         production_order_id, raw_material_id, quantity, unit_cost
                    FROM raw_material_movements
                   WHERE movement_type = 'saida_producao' AND production_order_id IS NOT NULL
                   ORDER BY production_order_id, raw_material_id, created_at DESC
                ) ult
               GROUP BY production_order_id
              HAVING SUM(COALESCE(unit_cost, 0)) > 0
            ) c ON c.production_order_id = po.id
           WHERE l.production_order_id = po.id
             AND l.unit_cost IS DISTINCT FROM (CASE WHEN po.quantity > 0 THEN c.total / po.quantity ELSE NULL END)
          RETURNING l.id`);
        repaired = (rep.rows || []).length;
        await db.execute(sql`
          INSERT INTO system_settings (key, value, description, updated_by)
          VALUES ('cmv_lote_repair_ultimo_movimento', ${String(repaired)},
                  'Reparo unico do CMV de lotes de ordens reabertas/refinalizadas (01/set/2026)', 'system')
          ON CONFLICT (key) DO NOTHING`);
      }
    } catch (e: any) {
      console.warn('⚠️ [CMV-LOTE] reparo unico nao aplicado:', e?.message || e);
    }

    // ── CMV DA FILIAL = CMV DA IND (Flavio, 18/set/2026) ────────────────────
    // Lotes que chegaram nas filiais por transferencia antes de 18/set nasceram sem
    // custo, porque a entrada espelho so copiava o CMV quando a linha do pedido o
    // trazia. Resultado: BSB e GYN com estoque subavaliado e vendendo sem saber a
    // margem.
    //
    // Mesmo numero de lote = mesma mercadoria, mesma OP, mesmo custo. Entao aqui o
    // lote sem custo herda o custo de um lote IRMAO (mesmo produto, mesmo numero de
    // lote, em outra instancia) que tenha CMV.
    //
    // Roda sempre, mas SO onde unit_cost IS NULL: nunca sobrescreve um custo ja
    // gravado, seja ele da producao ou uma correcao feita a mao. Por isso e seguro
    // em todo boot, e nao precisa de marca em system_settings.
    // A comparacao normaliza MAIUSCULAS e espacos: em producao convivem "H180626" e
    // "h180626" para o mesmo lote, e sem LOWER() eles nao casavam.
    let herdados = 0;
    try {
      const her: any = await db.execute(sql`
        UPDATE inventory_lots destino
           SET unit_cost  = origem.unit_cost,
               total_cost = ROUND(origem.unit_cost * COALESCE(destino.quantity, 0), 2),
               cmv_estimado = false,
               updated_at = now()
          FROM (
            SELECT DISTINCT ON (product_id, LOWER(REPLACE(TRIM(lot_number), ' ', '')))
                   product_id,
                   LOWER(REPLACE(TRIM(lot_number), ' ', '')) AS lote,
                   instance_id, unit_cost
              FROM inventory_lots
             WHERE unit_cost IS NOT NULL AND unit_cost > 0
               AND lot_number IS NOT NULL AND TRIM(lot_number) <> ''
             ORDER BY product_id, LOWER(REPLACE(TRIM(lot_number), ' ', '')),
                      production_order_id NULLS LAST, updated_at DESC
          ) origem
         WHERE destino.unit_cost IS NULL
           AND destino.product_id = origem.product_id
           AND LOWER(REPLACE(TRIM(destino.lot_number), ' ', '')) = origem.lote
           AND destino.instance_id IS DISTINCT FROM origem.instance_id
        RETURNING destino.id`);
      herdados = (her.rows || []).length;
      if (herdados) console.log(`✅ [CMV-LOTE] ${herdados} lote(s) de filial herdaram o CMV do lote de origem`);
    } catch (e: any) {
      console.warn('⚠️ [CMV-LOTE] heranca de CMV entre filiais nao aplicada:', e?.message || e);
    }

    // ── CMV ESTIMADO (Flavio, 18/set/2026, opcao "b") ───────────────────────
    // A heranca acima resolve o lote que ainda tem irmao na origem. Mas os lotes
    // antigos das filiais (maio/junho) nao tem: a linha correspondente na IND ja
    // sumiu. Conferido em producao: 23 lotes com saldo, 7.368 unidades, NENHUM com
    // irmao — nem com as ordens de producao.
    //
    // Entao esses recebem uma ESTIMATIVA: o custo medio ponderado daquele produto,
    // calculado sobre os lotes que TEM custo conhecido. A ponderacao usa a
    // quantidade produzida de cada lote, que se recupera de total_cost / unit_cost
    // (unit_cost foi definido como total_cost / quantidade produzida). E a mesma
    // media ponderada que o modulo contabil usa para CMV.
    //
    // ⚠️ Estimativa NAO e custo. Por isso grava cmv_estimado = true, e a tela mostra
    // esses lotes marcados. Quem quiser o numero real informa o custo do lote na mao,
    // e a partir dai cmv_estimado vira false e esta rotina nunca mais toca nele
    // (so mexe onde unit_cost IS NULL).
    let estimados = 0;
    try {
      const est: any = await db.execute(sql`
        UPDATE inventory_lots destino
           SET unit_cost    = media.custo,
               total_cost   = ROUND(media.custo * COALESCE(destino.quantity, 0), 2),
               cmv_estimado = true,
               updated_at   = now()
          FROM (
            SELECT product_id,
                   SUM(total_cost) / NULLIF(SUM(total_cost / unit_cost), 0) AS custo
              FROM inventory_lots
             WHERE unit_cost IS NOT NULL AND unit_cost > 0
               AND total_cost IS NOT NULL AND total_cost > 0
               AND COALESCE(cmv_estimado, false) = false
             GROUP BY product_id
          ) media
         WHERE destino.unit_cost IS NULL
           AND destino.product_id = media.product_id
           AND media.custo IS NOT NULL AND media.custo > 0
        RETURNING destino.id`);
      estimados = (est.rows || []).length;
      if (estimados) console.log(`✅ [CMV-LOTE] ${estimados} lote(s) receberam CMV ESTIMADO (media ponderada do produto)`);
    } catch (e: any) {
      console.warn('⚠️ [CMV-LOTE] estimativa de CMV nao aplicada:', e?.message || e);
    }

    const backfilled = (fill.rows || []).length;
    console.log(`✅ [CMV-LOTE] colunas ok — vinculados ${(link.rows || []).length} lote(s) a ordens, `
      + `CMV preenchido em ${backfilled}, reparados ${repaired}, herdados por filial ${herdados}, estimados ${estimados}`);
    return { ok: true, backfilled, repaired, herdados, estimados };
  } catch (e: any) {
    console.warn('⚠️ [CMV-LOTE] ensureCmvLoteColumns falhou:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
