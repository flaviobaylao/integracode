// ============================================================================
// DESCONTO EXTRA NO BOLETO, lançado no Pipeline de Faturamento (13/out/2026)
// ----------------------------------------------------------------------------
// Pedido do Flavio: no card do pipeline, lançar um desconto em R$ que vale SÓ
// para o boleto do pedido — a NF-e continua com o valor cheio — e SOMA com o
// "Desconto de Cobrança (%)" do cadastro do cliente, sem conflitar com ele.
//
//   Pedido R$ 1.119,50 · cadastro 6% · desconto do pipeline R$ 100,00
//   6% de 1.119,50 = R$ 67,17 (sempre sobre o valor CHEIO do pedido)
//   Boleto: 1.119,50 − 67,17 − 100,00 = R$ 952,33
//
// Como chega no boleto:
//   1. No faturamento (createReceivableFromPipelineItem), se a cobrança sai em
//      BOLETO, o desconto vira um ABATIMENTO no título — o mesmo mecanismo do
//      "desconto na baixa": linha em receivable_payments com amount 0 e
//      discount = valor, receivables.amount cai para 1.019,50 e
//      receivables.original_amount guarda 1.119,50.
//   2. O boleto é registrado pelo saldo (1.019,50) e o desconto do cadastro é
//      calculado sobre a BASE CHEIA (saldo + desconto do pipeline = 1.119,50),
//      não sobre o saldo já abatido — por isso os dois não se atropelam.
//      Pagando até o vencimento: 1.019,50 − 67,17 = 952,33.
//
// Rastro: cada lançamento/alteração/remoção é uma linha nova na tabela
// billing_pipeline_boleto_descontos (quem, quando, valor, motivo). Só uma linha
// fica ATIVA por pedido; as anteriores ficam com removido_em/removido_por.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

let _ensured: Promise<void> | null = null;
export function ensureBoletoDescontoTable(): Promise<void> {
  if (!_ensured) {
    _ensured = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS billing_pipeline_boleto_descontos (
          id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          billing_pipeline_id varchar NOT NULL,
          sales_card_id varchar,
          valor numeric(12,2) NOT NULL,
          motivo text,
          user_id varchar,
          user_email varchar,
          user_name varchar,
          created_at timestamp NOT NULL DEFAULT now(),
          ativo boolean NOT NULL DEFAULT true,
          removido_em timestamp,
          removido_por varchar,
          aplicado_receivable_id varchar,
          aplicado_em timestamp
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_bpbd_pipeline ON billing_pipeline_boleto_descontos (billing_pipeline_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_bpbd_receivable ON billing_pipeline_boleto_descontos (aplicado_receivable_id)`);
    })().catch((e) => { _ensured = null; throw e; });
  }
  return _ensured;
}

const rowsOf = (r: any): any[] => ((r?.rows ?? r ?? []) as any[]);
const num = (v: any) => { const n = parseFloat(String(v ?? '0')); return isNaN(n) ? 0 : n; };

export interface BoletoDescontoRow {
  id: string; billingPipelineId: string; valor: number; motivo: string | null;
  userId: string | null; userEmail: string | null; userName: string | null; createdAt: string;
  ativo: boolean; removidoEm: string | null; removidoPor: string | null;
  aplicadoReceivableId: string | null; aplicadoEm: string | null;
}
function mapRow(r: any): BoletoDescontoRow {
  return {
    id: r.id, billingPipelineId: r.billing_pipeline_id, valor: num(r.valor), motivo: r.motivo ?? null,
    userId: r.user_id ?? null, userEmail: r.user_email ?? null, userName: r.user_name ?? null,
    createdAt: r.created_at, ativo: !!r.ativo, removidoEm: r.removido_em ?? null, removidoPor: r.removido_por ?? null,
    aplicadoReceivableId: r.aplicado_receivable_id ?? null, aplicadoEm: r.aplicado_em ?? null,
  };
}

/** Desconto ATIVO do pedido (ou null). */
export async function getDescontoBoletoAtivo(billingPipelineId: string): Promise<BoletoDescontoRow | null> {
  if (!billingPipelineId) return null;
  await ensureBoletoDescontoTable();
  const r: any = await db.execute(sql`
    SELECT * FROM billing_pipeline_boleto_descontos
     WHERE billing_pipeline_id = ${billingPipelineId} AND ativo = true
     ORDER BY created_at DESC LIMIT 1`);
  const row = rowsOf(r)[0];
  return row ? mapRow(row) : null;
}

/** Histórico completo (mais recente primeiro). */
export async function getDescontoBoletoHistorico(billingPipelineId: string): Promise<BoletoDescontoRow[]> {
  await ensureBoletoDescontoTable();
  const r: any = await db.execute(sql`
    SELECT * FROM billing_pipeline_boleto_descontos
     WHERE billing_pipeline_id = ${billingPipelineId}
     ORDER BY created_at DESC LIMIT 50`);
  return rowsOf(r).map(mapRow);
}

/**
 * Grava (ou remove, com valor 0) o desconto do pedido. Desativa o anterior e
 * registra quem fez. Devolve o desconto ativo depois da operação.
 */
export async function salvarDescontoBoleto(params: {
  billingPipelineId: string; salesCardId?: string | null; valor: number; motivo?: string | null;
  user: { id?: string | null; email?: string | null; name?: string | null };
}): Promise<BoletoDescontoRow | null> {
  await ensureBoletoDescontoTable();
  const quem = params.user.email || params.user.name || 'usuario';
  await db.execute(sql`
    UPDATE billing_pipeline_boleto_descontos
       SET ativo = false, removido_em = now(), removido_por = ${quem}
     WHERE billing_pipeline_id = ${params.billingPipelineId} AND ativo = true`);
  if (params.valor > 0.004) {
    await db.execute(sql`
      INSERT INTO billing_pipeline_boleto_descontos
        (billing_pipeline_id, sales_card_id, valor, motivo, user_id, user_email, user_name)
      VALUES (${params.billingPipelineId}, ${params.salesCardId ?? null}, ${params.valor.toFixed(2)},
              ${params.motivo ?? null}, ${params.user.id ?? null}, ${params.user.email ?? null}, ${params.user.name ?? null})`);
  }
  return getDescontoBoletoAtivo(params.billingPipelineId);
}

/** Marca o desconto como aplicado no título (ou títulos, no caso de parcelas). */
export async function marcarDescontoAplicado(descontoId: string, receivableId: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE billing_pipeline_boleto_descontos
         SET aplicado_receivable_id = COALESCE(aplicado_receivable_id, ${receivableId}),
             aplicado_em = COALESCE(aplicado_em, now())
       WHERE id = ${descontoId}`);
  } catch (e: any) { console.warn('[DESCONTO-BOLETO] falha ao marcar aplicado:', e?.message); }
}

/**
 * Quanto do desconto do pipeline foi abatido NESTE título. Gravado na própria
 * baixa de desconto (reference = 'desconto-boleto-pipeline'), então funciona
 * também para parcelas (cada uma recebeu a sua fatia).
 */
export async function descontoPipelineNoTitulo(receivableId: string): Promise<number> {
  if (!receivableId) return 0;
  try {
    const r: any = await db.execute(sql`
      SELECT COALESCE(SUM(discount::numeric), 0) AS d FROM receivable_payments
       WHERE receivable_id = ${receivableId} AND reference = 'desconto-boleto-pipeline'`);
    return num(rowsOf(r)[0]?.d);
  } catch { return 0; }
}

/**
 * BASE do "Desconto de Cobrança (%)" do cadastro para o boleto deste título.
 * O % incide sobre o valor CHEIO do pedido, não sobre o saldo já abatido pelo
 * desconto do pipeline. Só vale enquanto o título não teve pagamento: com baixa
 * parcial, o boleto é do saldo e o % volta a incidir sobre o saldo (regra antiga).
 * Retorna undefined quando não há nada a ajustar (registrarBoleto usa o amount).
 */
export async function baseDescontoCadastro(receivableId: string | null | undefined, saldo: number, amountPaid: number): Promise<number | undefined> {
  if (!receivableId || amountPaid > 0.005) return undefined;
  const d = await descontoPipelineNoTitulo(receivableId);
  return d > 0.005 ? Number((saldo + d).toFixed(2)) : undefined;
}

/**
 * O "Desconto de Cobrança (%)" do cadastro já foi ABATIDO neste título no faturamento?
 * (reference = 'desconto-cobranca-cadastro'). Se sim, o boleto vai pelo saldo, sem
 * "desconto até o vencimento" no BB — senão o desconto sairia em dobro.
 */
export async function descontoCadastroJaAbatido(receivableId: string | null | undefined): Promise<boolean> {
  if (!receivableId) return false;
  try {
    const r: any = await db.execute(sql`
      SELECT 1 FROM receivable_payments
       WHERE receivable_id = ${receivableId} AND reference = 'desconto-cobranca-cadastro' LIMIT 1`);
    return rowsOf(r).length > 0;
  } catch { return false; }
}
