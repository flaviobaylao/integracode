// server/faturamento-oficial.ts
// -----------------------------------------------------------------------------
// FONTE UNICA DE "FATURAMENTO" — INTEGRA 2.0
// Regras aprovadas por Flavio em 03/08/2026:
//  1. NF-e AUTORIZADA em PRODUCAO, de VENDA (fora: amostra, troca, transferencia,
//     remessa, bonificacao, devolucao, cancelada, rejeitada, rascunho).
//  2. Uma linha por (CNPJ emitente, serie, numero) — mata NF-e registrada em duplicidade.
//  3. Data = COALESCE(emission_date, authorization_date, created_at), SEM conversao de
//     fuso: as datas ja estao gravadas no horario de Brasilia (comprovado pelo histograma
//     de hora de emissao: pico 14h-18h). O antigo AT TIME ZONE empurrava tudo +3h e jogava
//     as notas do fim da tarde do ultimo dia do mes para o mes seguinte.
//  4. A venda e de QUEM IMPLANTOU O PEDIDO (billing_pipeline.seller_id casado pelo numero
//     da NF), nunca do dono atual da carteira. Fallback: sales_cards.seller_id.
//  5. billing_pipeline com stage = 'lixeira' NUNCA entra em relatorio.
//  6. VIGENCIA: a regra vale de 01/07/2026 em diante. Periodos anteriores continuam
//     com o calculo legado (nao reprocessamos o passado). Use `dentroDaVigencia()`.
// -----------------------------------------------------------------------------

/** CFOPs de VENDA. Ampla de proposito: ate mar/2026 a operacao saia em 5101/6101
 *  (venda de producao propria) e a partir de abr/2026 passou a sair em 5102 (revenda).
 *  Uma lista curta zeraria jan-mar. */
export const CFOP_VENDA = [
  '5101','5102','5103','5104','5105','5106','5401','5402','5403','5405',
  '6101','6102','6103','6104','6105','6106','6107','6108',
  '6401','6402','6403','6404','6405',
] as const;

const CFOP_LIST = CFOP_VENDA.map(c => `'${c}'`).join(',');

/** Data em que a regra oficial passa a valer. Antes disso, calculo legado. */
export const VIGENCIA_REGRA_OFICIAL = '2026-07-01';

/** true se o periodo [inicio, fim) esta inteiramente sob a regra nova. */
export function dentroDaVigencia(inicio: string): boolean {
  return inicio >= VIGENCIA_REGRA_OFICIAL;
}

/** Naturezas que NUNCA sao faturamento, mesmo com CFOP de venda. */
const NATUREZA_FORA = ['DEVOL','TROCA','TRANSFER','REMESSA','BONIFICA','AMOSTRA'];

/** WHERE de venda. `a` = alias da tabela fiscal_invoices (ex.: 'fi'). */
export function nfVendaWhere(a = 'fi'): string {
  const nat = NATUREZA_FORA
    .map(t => `UPPER(COALESCE(${a}.nature_of_operation,'')) NOT LIKE '%${t}%'`)
    .join(' AND ');
  return [
    `${a}.status = 'authorized'`,
    `${a}.environment = 'producao'`,
    `COALESCE(${a}.operation_type,'saida') <> 'entrada'`,
    `COALESCE(${a}.fin_nfe,'1') <> '4'`,
    `(${a}.cfop IN (${CFOP_LIST})`
      + ` OR (${a}.cfop IS NULL AND UPPER(COALESCE(${a}.nature_of_operation,'')) LIKE '%VENDA%'))`,
    nat,
  ].join(' AND ');
}

/** Data oficial da nota. SEM AT TIME ZONE — ver nota 3 acima. */
export function nfData(a = 'fi'): string {
  return `COALESCE(${a}.emission_date, ${a}.authorization_date, ${a}.created_at)`;
}

/** FROM deduplicado por (CNPJ emitente, serie, numero), ficando com o registro mais recente. */
export function nfVendaFrom(a = 'fi'): string {
  return `(
    SELECT DISTINCT ON (issuer_cnpj, series, invoice_number) *
    FROM fiscal_invoices
    ORDER BY issuer_cnpj, series, invoice_number, created_at DESC
  ) ${a}`;
}

/** Pedidos do pipeline, SEM lixeira, um por numero de NF (o mais recente). */
export const PIPELINE_POR_NF = `(
  SELECT DISTINCT ON (num) num, seller_id FROM (
    SELECT NULLIF(regexp_replace(COALESCE(invoice_number,''),'[^0-9]','','g'),'')::bigint AS num,
           seller_id, created_at
    FROM billing_pipeline
    WHERE stage <> 'lixeira'
      AND regexp_replace(COALESCE(invoice_number,''),'[^0-9]','','g') <> ''
  ) t ORDER BY num, created_at DESC
)`;

/** Nome do vendedor = quem implantou o pedido -> fallback vendedor do sales_card.
 *  Requer os joins `bp` (PIPELINE_POR_NF) e `sc` (sales_cards) no escopo. */
export const VENDEDOR_JOIN = `
  LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id
  LEFT JOIN ${PIPELINE_POR_NF} bp ON bp.num = fi.invoice_number
  LEFT JOIN LATERAL (
    SELECT u.id, NULLIF(TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),'') AS nome
    FROM users u
    WHERE u.id = COALESCE(NULLIF(bp.seller_id,''), sc.seller_id)
       OR u.omie_vendor_code = COALESCE(NULLIF(bp.seller_id,''), sc.seller_id)
       OR u.omie_vendor_code = REPLACE(COALESCE(NULLIF(bp.seller_id,''), sc.seller_id, ''),'omie-vendor-','')
    LIMIT 1
  ) v ON true`;

/** Total faturado no periodo [inicio, fim). Datas em 'YYYY-MM-DD'. */
export function sqlFaturamentoPeriodo(inicio: string, fim: string): string {
  return `SELECT COALESCE(SUM(fi.total_invoice),0) AS v, COUNT(*) AS n
          FROM ${nfVendaFrom('fi')}
          WHERE ${nfVendaWhere('fi')}
            AND ${nfData('fi')}::date >= '${inicio}'
            AND ${nfData('fi')}::date <  '${fim}'`;
}

/** Faturamento por vendedor no periodo — quem implantou o pedido. */
export function sqlFaturamentoPorVendedor(inicio: string, fim: string): string {
  return `SELECT COALESCE(v.id,'sem-vendedor') AS vendedor_id,
                 COALESCE(v.nome,'Sem vendedor') AS vendedor,
                 COUNT(*) AS notas,
                 COALESCE(SUM(fi.total_invoice),0) AS faturamento
          FROM ${nfVendaFrom('fi')}
          ${VENDEDOR_JOIN}
          WHERE ${nfVendaWhere('fi')}
            AND ${nfData('fi')}::date >= '${inicio}'
            AND ${nfData('fi')}::date <  '${fim}'
          GROUP BY 1,2
          ORDER BY faturamento DESC`;
}

/** Serie mensal do ano corrente. */
export function sqlFaturamentoMensal(ano: number): string {
  return `SELECT to_char(date_trunc('month', ${nfData('fi')}),'YYYY-MM') AS m,
                 COALESCE(SUM(fi.total_invoice),0) AS v
          FROM ${nfVendaFrom('fi')}
          WHERE ${nfVendaWhere('fi')}
            AND ${nfData('fi')}::date >= '${ano}-01-01'
            AND ${nfData('fi')}::date <  '${ano + 1}-01-01'
          GROUP BY m ORDER BY m`;
}

/** Serie diaria do mes. */
export function sqlFaturamentoDiario(inicio: string, fim: string): string {
  return `SELECT ${nfData('fi')}::date::text AS d, COALESCE(SUM(fi.total_invoice),0) AS v
          FROM ${nfVendaFrom('fi')}
          WHERE ${nfVendaWhere('fi')}
            AND ${nfData('fi')}::date >= '${inicio}'
            AND ${nfData('fi')}::date <  '${fim}'
          GROUP BY d ORDER BY d`;
}
