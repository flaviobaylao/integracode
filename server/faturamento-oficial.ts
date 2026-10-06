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

import { VIRADA_FUSO_UTC } from '@shared/tempo';

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

/** Data oficial da nota, sempre na hora de parede de Brasilia.
 *
 *  ATE 11/08/2026 emission_date/authorization_date eram gravados por nowBrazil(), ou seja,
 *  ja continham a hora de Brasilia — dai a nota 3 acima mandar NAO usar AT TIME ZONE.
 *  A PARTIR DA VIRADA (ver shared/tempo.ts) esses campos passaram a guardar o INSTANTE em
 *  UTC, que e a regra unica do sistema. Para que o historico continue batendo NUMERO A
 *  NUMERO com o que ja foi apresentado ao Flavio, a conversao UTC->BRT e aplicada SO as
 *  linhas novas: antes da virada le como esta; a partir dela, converte.
 *  Sem esse CASE, toda nota emitida entre 00:00 e 02:59 BRT do passado migraria de mes. */
export function nfData(a = 'fi'): string {
  const bruto = `COALESCE(${a}.emission_date, ${a}.authorization_date, ${a}.created_at)`;
  return `(CASE WHEN ${bruto} >= TIMESTAMP '${VIRADA_FUSO_UTC}'`
    + ` THEN (${bruto} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')`
    + ` ELSE ${bruto} END)`;
}

/** Chave de deduplicacao. COALESCE em tudo: sem isso, linhas com issuer_cnpj/series/
 *  invoice_number nulos cairiam todas na MESMA chave e o DISTINCT ON apagaria notas boas. */
const DEDUP_KEY = `COALESCE(issuer_cnpj,''), COALESCE(series,''), COALESCE(invoice_number::text, 'id:' || id::text)`;

/** FROM deduplicado por (CNPJ emitente, serie, numero), ficando com o registro mais recente.
 *
 *  O filtro de venda roda DENTRO da subquery, ANTES do DISTINCT ON. A ordem importa:
 *  no incidente de 08/07/2026 varias NF-e foram registradas em duplicidade e so UMA copia
 *  de cada foi marcada como devolvida. Deduplicando antes de filtrar, quando a copia
 *  devolvida era a mais recente o grupo INTEIRO sumia e uma venda real ia junto —
 *  R$ 1.655,20 em julho (NF 104588, 104608, 104722, SmartStore e Mais Cafe Aeroporto).
 *  Filtrando primeiro, sobra exatamente uma linha valida por numero de nota, e um numero
 *  cujas linhas foram TODAS canceladas/devolvidas desaparece por si so. */
export function nfVendaFrom(a = 'fi'): string {
  return `(
    SELECT DISTINCT ON (${DEDUP_KEY}) *
    FROM fiscal_invoices
    WHERE ${nfVendaWhere('fiscal_invoices')}
    ORDER BY ${DEDUP_KEY}, created_at DESC
  ) ${a}`;
}

/** Numero da NF (so digitos) gravado em billing_pipeline.invoice_number ("NF-104588" -> 104588).
 *
 *  PERFORMANCE (06/10/2026): esta expressao e INDEXADA em producao
 *  (idx_billing_pipeline_nf_num, migrations/2026-10-06_perf_indices.sql). O texto aqui tem
 *  de ser IDENTICO ao do indice, senao o planejador volta ao seq scan. O CASE com length
 *  BETWEEN 1 AND 18 existe porque o indice precisa de uma expressao que nunca estoure o
 *  bigint (uma chave de acesso de 44 digitos gravada por engano quebraria o INSERT). */
export const BP_NF_NUM =
  `(CASE WHEN length(regexp_replace(COALESCE(invoice_number,''),'[^0-9]','','g')) BETWEEN 1 AND 18`
  + ` THEN regexp_replace(COALESCE(invoice_number,''),'[^0-9]','','g')::bigint END)`;

/** Mesma expressao de BP_NF_NUM com alias de tabela (para subquery correlacionada). */
export function bpNfNum(a: string): string {
  return BP_NF_NUM.replace(/invoice_number/g, `${a}.invoice_number`);
}

/** Pedidos do pipeline, SEM lixeira, um por numero de NF (o mais recente).
 *  Use em JOIN (hash join, roda UMA vez). Para subquery correlacionada por linha de NF,
 *  use `vendedorImplantou()`, que e indexada. */
export const PIPELINE_POR_NF = `(
  SELECT DISTINCT ON (num) num, seller_id FROM (
    SELECT ${BP_NF_NUM} AS num, seller_id, created_at
    FROM billing_pipeline
    WHERE stage <> 'lixeira'
      AND regexp_replace(COALESCE(invoice_number,''),'[^0-9]','','g') <> ''
  ) t WHERE num IS NOT NULL ORDER BY num, created_at DESC
)`;

/** Quem IMPLANTOU o pedido da NF `a` (regra 4): seller_id do billing_pipeline casado pelo
 *  numero da NF (o mais recente, fora lixeira) -> fallback sales_cards.seller_id.
 *
 *  INCIDENTE 06/10/2026: a versao anterior fazia `SELECT ... FROM ${PIPELINE_POR_NF} WHERE num = fi.invoice_number`
 *  por linha — o DISTINCT ON impedia o planejador de empurrar o filtro, entao CADA uma das
 *  ~60 mil NF-e varria billing_pipeline inteira com regexp (183 MILHOES de seq scans,
 *  1,1 TRILHAO de linhas lidas). O Dashboard de vendedor levava >10 min e cada abertura
 *  enfileirava mais uma consulta ate esgotar o pool. Esta forma usa idx_billing_pipeline_nf_num:
 *  0,15 s para o mesmo resultado. */
export function vendedorImplantou(a = 'fi'): string {
  return `COALESCE(NULLIF((SELECT bp_s.seller_id FROM billing_pipeline bp_s`
    + ` WHERE bp_s.stage <> 'lixeira' AND ${bpNfNum('bp_s')} = ${a}.invoice_number`
    + ` ORDER BY bp_s.created_at DESC LIMIT 1),''),`
    + `(SELECT sc_s.seller_id FROM sales_cards sc_s WHERE sc_s.id = ${a}.sales_card_id LIMIT 1))`;
}

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
