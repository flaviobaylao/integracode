// ============================================================================
// TRAVA DE LOTE EM NF DE TRANSFERENCIA (Flavio, 05/set/2026)
//
// Regra: um lote de produto acabado que entrou num pedido/NF de transferencia
// entre filiais NAO pode mais ser editado (quantidade, numero, exclusao) nem ter
// a ordem de producao que o gerou reaberta/excluida. A trava so cai quando:
//   - o pedido de transferencia e mandado para a Lixeira ANTES de virar NF
//     (nenhum estoque se mexeu, nada a estornar), ou
//   - a NF-e e CANCELADA ou DEVOLVIDA — e nesse momento o estoque tem de ser
//     movimentado de volta (origem recebe o lote exato, destino perde o espelho).
//     So depois disso a ordem de producao volta a ser editavel.
//
// A trava e CALCULADA na leitura, a partir de billing_pipeline.products[].lotId
// (gravado pelo POST /api/inventory/transfer-order) e da NF-e ligada ao card.
// Nao ha coluna "locked" para ficar dessincronizada: se a NF for cancelada por
// qualquer caminho, a trava cai sozinha.
// ============================================================================
import { db } from "./db";
import { sql } from "drizzle-orm";

export interface LotTransferLock {
  lotId: string;
  lotNumber: string | null;
  quantity: number;
  pipelineItemId: string;
  salesCardId: string | null;
  orderNumber: string | null;      // TRF-XXXXXXXX
  stage: string;                   // etapa atual do card no pipeline
  destino: string | null;          // nome da instancia de destino (GYN)
  invoiceId: string | null;
  invoiceNumber: number | null;
  invoiceStatus: string | null;
  // Como destravar, em texto para a tela e para a mensagem de erro.
  reason: string;
}

// Status de NF que LIBERAM o lote. Qualquer outro (draft, processing, authorized,
// error, rejected) mantem a trava: se a nota falhou, o card continua 'faturado' e
// a baixa de estoque JA aconteceu — o operador vai reemitir ou cancelar, e ate la
// o lote nao pode ser mexido por fora.
const STATUS_QUE_LIBERAM = new Set(['cancelled', 'returned']);
const STAGES_LIVRES = new Set(['lixeira']);

function descreve(row: any): string {
  const trf = row.order_number || 'pedido de transferencia';
  if (row.invoice_id) {
    const nf = row.nf_numero ? `NF-e ${row.nf_numero}` : 'NF-e';
    return `Lote na ${nf} de transferencia (${trf}, ${row.destino || 'filial'}). So e liberado com o CANCELAMENTO ou a DEVOLUCAO da nota.`;
  }
  return `Lote reservado no ${trf} (${row.destino || 'filial'}), aguardando faturamento. Para liberar, envie o pedido para a Lixeira no pipeline de faturamento.`;
}

// Todas as travas vigentes, indexadas por lotId. Um lote pode aparecer em mais
// de um pedido (segunda remessa do saldo): vale a trava mais recente/mais forte
// (com NF ganha de sem NF).
export async function getTransferLocks(lotIds?: string[]): Promise<Map<string, LotTransferLock>> {
  const out = new Map<string, LotTransferLock>();
  if (lotIds && lotIds.length === 0) return out;

  const filtro = lotIds && lotIds.length
    ? sql`AND (p->>'lotId') IN (${sql.join(lotIds.map((i) => sql`${i}`), sql`, `)})`
    : sql``;

  const r: any = await db.execute(sql`
    SELECT bp.id AS pipeline_item_id, bp.order_number, bp.stage::text AS stage, bp.sales_card_id,
           p->>'lotId' AS lot_id, p->>'lotNumber' AS lot_number,
           COALESCE((p->>'quantity')::numeric, 0) AS qty,
           p->>'transferToInstanceName' AS destino,
           fi.id AS invoice_id, fi.status AS invoice_status, fi.invoice_number AS nf_numero,
           bp.created_at
    FROM billing_pipeline bp
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(bp.products, '[]'::jsonb)) p
    LEFT JOIN LATERAL (
      SELECT id, status, invoice_number FROM fiscal_invoices
      WHERE sales_card_id = bp.sales_card_id AND COALESCE(fin_nfe, '1') <> '4'
      ORDER BY created_at DESC LIMIT 1
    ) fi ON true
    WHERE bp.operation_type = 'transferencia'
      AND jsonb_typeof(bp.products) = 'array'
      AND (p ? 'lotId')
      ${filtro}
    ORDER BY bp.created_at ASC`);

  for (const row of (r.rows || [])) {
    const lotId = String(row.lot_id || '');
    if (!lotId) continue;
    const temNf = !!row.invoice_id;
    const nfLibera = temNf && STATUS_QUE_LIBERAM.has(String(row.invoice_status || '').toLowerCase());
    const cardLivre = STAGES_LIVRES.has(String(row.stage || '').toLowerCase());
    // Sem NF: trava enquanto o card estiver vivo. Com NF: trava ate cancelar/devolver,
    // mesmo que alguem tenha jogado o card na Lixeira sem cancelar a nota.
    const travado = temNf ? !nfLibera : !cardLivre;
    if (!travado) continue;

    const lock: LotTransferLock = {
      lotId,
      lotNumber: row.lot_number || null,
      quantity: Number(row.qty) || 0,
      pipelineItemId: String(row.pipeline_item_id),
      salesCardId: row.sales_card_id || null,
      orderNumber: row.order_number || null,
      stage: String(row.stage || ''),
      destino: row.destino || null,
      invoiceId: row.invoice_id || null,
      invoiceNumber: row.nf_numero != null ? Number(row.nf_numero) : null,
      invoiceStatus: row.invoice_status || null,
      reason: descreve(row),
    };
    const atual = out.get(lotId);
    // Com NF prevalece sobre sem NF; entre iguais, o mais recente (ORDER BY asc).
    if (!atual || (!atual.invoiceId && lock.invoiceId) || (!!atual.invoiceId === !!lock.invoiceId)) out.set(lotId, lock);
  }
  return out;
}

export async function getLotTransferLock(lotId: string): Promise<LotTransferLock | null> {
  const m = await getTransferLocks([lotId]);
  return m.get(lotId) || null;
}

// Ordem de producao: travada se QUALQUER lote gerado por ela estiver travado.
// O vinculo lote->OP vem de inventory_lots.production_order_id (coluna gravada
// na finalizacao) e, como rede, de inventory_movements(source_type='order').
export async function getProductionOrderTransferLock(orderId: string): Promise<LotTransferLock | null> {
  const r: any = await db.execute(sql`
    SELECT id FROM inventory_lots WHERE production_order_id = ${orderId}
    UNION
    SELECT lot_id AS id FROM inventory_movements WHERE source_type = 'order' AND source_id = ${orderId}`);
  const ids: string[] = Array.from(new Set<string>((r.rows || []).map((x: any) => String(x.id)).filter(Boolean)));
  if (!ids.length) return null;
  const m = await getTransferLocks(ids);
  for (const id of ids) { const l = m.get(id); if (l) return l; }
  return null;
}

// Travas por ordem de producao, em lote (para a listagem de OPs nao fazer N queries).
export async function getProductionOrderTransferLocks(): Promise<Map<string, LotTransferLock>> {
  const locks = await getTransferLocks();
  const out = new Map<string, LotTransferLock>();
  if (!locks.size) return out;
  const lotIds = Array.from(locks.keys());
  const r: any = await db.execute(sql`
    SELECT id AS lot_id, production_order_id AS op FROM inventory_lots
    WHERE production_order_id IS NOT NULL AND id IN (${sql.join(lotIds.map((i) => sql`${i}`), sql`, `)})
    UNION
    SELECT lot_id, source_id AS op FROM inventory_movements
    WHERE source_type = 'order' AND lot_id IN (${sql.join(lotIds.map((i) => sql`${i}`), sql`, `)})`);
  for (const row of (r.rows || [])) {
    const op = String(row.op || ''); const lot = String(row.lot_id || '');
    const l = locks.get(lot);
    if (op && l && !out.get(op)?.invoiceId) out.set(op, l);
  }
  return out;
}

// ============================================================================
// ESTORNO EXATO DA TRANSFERENCIA (cancelamento / devolucao da NF-e)
//
// O estorno generico (reverseStockConsumption) devolve a quantidade "no primeiro
// lote em uso do produto" — para uma transferencia isso e errado duas vezes: o
// lote certo e o que saiu na NF, e a filial de destino recebeu um espelho que
// precisa ser retirado. Aqui o estorno e feito pelos MOVIMENTOS que o
// faturamento gravou (source_type='invoice', source_id = id do card):
//   consume   na origem  -> devolve ao MESMO lote (reativa se estava inativo)
//   replenish no destino -> retira do lote espelho
// Idempotente: cada movimento estornado recebe a marca abaixo e nao e
// estornado de novo (cancelar duas vezes, ou cancelar e depois devolver).
// ============================================================================
export const TRF_EST_MARK = '[estorno-transferencia]';

export async function reverseTransferStockExact(
  invoice: any,
  by: string | null,
): Promise<{ handled: boolean; undone: string[]; warnings: string[]; pipelineItemId?: string }> {
  const undone: string[] = [];
  const warnings: string[] = [];
  const scId = invoice?.salesCardId;
  if (!scId) return { handled: false, undone, warnings };

  const q: any = await db.execute(sql`
    SELECT id, order_number FROM billing_pipeline
    WHERE sales_card_id = ${String(scId)} AND operation_type = 'transferencia'
    ORDER BY created_at DESC LIMIT 1`);
  const card = (q.rows || [])[0];
  if (!card) return { handled: false, undone, warnings };

  const movs: any = await db.execute(sql`
    SELECT * FROM inventory_movements
    WHERE source_type = 'invoice' AND source_id = ${String(card.id)}
      AND movement_type IN ('consume', 'replenish')
      AND COALESCE(notes, '') NOT LIKE ${'%' + TRF_EST_MARK + '%'}
    ORDER BY created_at ASC`);

  const rotulo = `${invoice.invoiceNumber ? 'NF-e ' + invoice.invoiceNumber : 'NF-e'} (${card.order_number || card.id})`;

  for (const mv of (movs.rows || [])) {
    const lq: any = await db.execute(sql`SELECT * FROM inventory_lots WHERE id = ${mv.lot_id} LIMIT 1`);
    const lot = (lq.rows || [])[0];
    if (!lot) { warnings.push(`lote ${mv.lot_number} do movimento ${mv.id} nao existe mais — nao estornado`); continue; }

    // deductStockForBilling grava o consume POSITIVO; consumeStock grava NEGATIVO.
    // O sinal do movimento nao e confiavel; a direcao vem do movement_type.
    const qty = Math.abs(Number(mv.quantity) || 0);
    if (qty <= 0) continue;
    const isConsume = String(mv.movement_type) === 'consume';
    const prev = Number(lot.quantity) || 0;
    const novo = isConsume ? prev + qty : prev - qty;

    if (!isConsume && novo < 0) {
      warnings.push(`lote espelho ${lot.lot_number} no destino ja tinha saida (${prev} de ${qty}) — saldo ficou negativo (${novo}); conferir estoque da filial`);
    }

    await db.execute(sql`
      UPDATE inventory_lots SET
        quantity = ${novo.toFixed(4)},
        is_active = ${novo > 0 ? true : (isConsume ? lot.is_active : false)},
        notes = COALESCE(notes, '') || ${' | ' + (isConsume ? 'estoque devolvido pelo estorno da ' : 'entrada espelho retirada pelo estorno da ') + rotulo},
        updated_at = now()
      WHERE id = ${lot.id}`);
    await db.execute(sql`
      INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
      VALUES (gen_random_uuid()::varchar, ${lot.id}, ${lot.product_id}, ${lot.instance_id}, 'cancel_reversal',
              ${(isConsume ? qty : -qty).toFixed(4)}, ${prev.toFixed(4)}, ${novo.toFixed(4)},
              'invoice', ${String(invoice.id)}, ${lot.lot_number},
              ${(isConsume ? 'Devolucao ao lote de origem' : 'Retirada da entrada espelho no destino') + ' — estorno da ' + rotulo + ' ' + TRF_EST_MARK},
              ${by}, now())`);
    await db.execute(sql`UPDATE inventory_movements SET notes = COALESCE(notes, '') || ${' ' + TRF_EST_MARK} WHERE id = ${mv.id}`);
    undone.push(`${isConsume ? 'origem' : 'destino'} ${lot.lot_number}: ${isConsume ? '+' : '-'}${qty}`);
  }

  if (!(movs.rows || []).length) warnings.push('nenhum movimento de estoque pendente de estorno para esta transferencia (ja estornada?)');
  console.log(`🔁 [TRANSFER] estorno exato ${rotulo}: ${undone.join(', ') || 'nada'}${warnings.length ? ' | avisos: ' + warnings.join('; ') : ''}`);
  return { handled: true, undone, warnings, pipelineItemId: String(card.id) };
}

// Enriquecimento de listas de lotes com a trava (tela de estoque).
export async function attachTransferLocks<T extends { id: string }>(lots: T[]): Promise<Array<T & { transferLock: LotTransferLock | null }>> {
  const locks = await getTransferLocks(lots.map((l) => l.id));
  return lots.map((l) => ({ ...l, transferLock: locks.get(l.id) || null }));
}
