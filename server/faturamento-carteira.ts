// server/faturamento-carteira.ts
// -----------------------------------------------------------------------------
// FATURAMENTO DA GESTAO DE CARTEIRAS — a regua unica das duas abas (Carteira e
// Rede de Cliente).
//
// A DECISAO (Flavio, 24/09/2026): faturamento e' a NF-e AUTORIZADA emitida pelo
// INTEGRA, nao o titulo do Contas a Receber. Nota e' VENDA; titulo e' COBRANCA.
// Enquanto a tela media por titulo, toda vez que alguem cancelava o titulo por
// razao de cobranca — "boleto emitido via omie", "pago no omie" — o faturamento
// do cliente sumia. So de jun a set/2026 eram 23 titulos, R$ 35.836,60 de venda
// real invisivel, e foi assim que a rede Tatico amanheceu zerada em set/26.
//
// A COSTURA. A NF-e do INTEGRA so existe a partir de abr/2026 (marco e' parcial:
// R$ 15 mil contra R$ 321 mil em titulos — o sistema comecou a emitir no meio do
// mes). Antes disso as notas sairam pelo Omie e nao estao em `fiscal_invoices`.
// Entao:
//   • ate 2026-03  -> titulo emitido nao cancelado (unica base que existe);
//   • de 2026-04   -> NF-e autorizada de venda, pelo valor da propria nota.
// Venda com titulo mas SEM NF-e no INTEGRA fica de fora do periodo novo: a regua
// e' "faturamento real da NF-e", e misturar as duas fontes no mesmo mes contaria
// a mesma venda duas vezes quando o casamento falhasse.
//
// Isto tambem encerra, por construcao, o problema do titulo repetido: a nota
// entra UMA vez, pelo seu total, nao importa quantos titulos ela tenha gerado.
// -----------------------------------------------------------------------------
import { nfVendaFrom, nfVendaWhere, nfData } from "./faturamento-oficial";

/** Primeiro mes em que o faturamento sai da NF-e do INTEGRA. */
export const MES_NFE_INTEGRA = "2026-04";

/** CNPJs que nunca sao cliente de venda: as 4 empresas do grupo + BARUC. */
export const DOCS_FORA = [
  "28295493000153", "28295493000234", "28295493000315", "52921727000105",
  "14877972000173",
];
const LISTA_DOCS_FORA = DOCS_FORA.map((c) => `'${c}'`).join(",");

/**
 * CTE `fat` com o faturamento por cliente e mes, na regua acima.
 * Colunas: doc, nome, mes ('YYYY-MM'), v (valor), n (documentos contados).
 *
 * @param iniDate    'YYYY-MM-DD' — inicio do periodo (inclusive)
 * @param fimDateExcl 'YYYY-MM-DD' — fim EXCLUSIVO
 * @param filtroVendaTitulos  o bloco `AND NOT (...)` que ja filtra os titulos
 *                            (grupo, categoria, NF invalida, lixeira)
 */
export function cteFaturamento(iniDate: string, fimDateExcl: string, filtroVendaTitulos: string): string {
  // Destinatario da nota: e' dele o faturamento (o local de entrega vai em
  // <entrega> e nao muda quem comprou) — mesma regra do titulo, que nasce no
  // CNPJ do destinatario.
  const docNf = `NULLIF(regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g'),'')`;
  const nomeNf = `NULLIF(UPPER(TRIM(COALESCE(fi.customer_name,''))),'')`;
  // Grupo/BARUC tambem fora pelo lado da NF-e: venda para a propria casa nao e
  // faturamento de carteira.
  const grupoNf = `(COALESCE(regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g'),'') IN (${LISTA_DOCS_FORA})
                    OR UPPER(COALESCE(fi.customer_name,'')) ~ '(^|[^A-Z])(PURO|BARUC)([^A-Z]|$)')`;
  // Pedido na lixeira nunca entra em relatorio (regra 5 do faturamento oficial).
  const lixeiraNf = `EXISTS (
      SELECT 1 FROM billing_pipeline bpx
      WHERE bpx.stage = 'lixeira'
        AND NULLIF(regexp_replace(COALESCE(bpx.invoice_number,''),'[^0-9]','','g'),'')::bigint = fi.invoice_number)`;

  return `
        fat AS (
          -- ATE ${MES_NFE_INTEGRA}: titulo emitido (a NF-e do INTEGRA ainda nao existia)
          SELECT
            NULLIF(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),'') AS doc,
            NULLIF(UPPER(TRIM(COALESCE(customer_name,''))),'')                        AS nome,
            to_char(issue_date,'YYYY-MM')                                             AS mes,
            COALESCE(NULLIF(amount::text,'')::numeric,0)                              AS v,
            1                                                                         AS n
          FROM receivables
          WHERE issue_date >= '${iniDate}'
            AND issue_date <  '${fimDateExcl}'
            AND to_char(issue_date,'YYYY-MM') < '${MES_NFE_INTEGRA}'
            AND deleted_at IS NULL
            AND COALESCE(status::text,'') NOT IN ('cancelada','cancelado','cancelled','canceled')
            AND COALESCE(NULLIF(amount::text,'')::numeric,0) > 0
            ${filtroVendaTitulos}
          UNION ALL
          -- DE ${MES_NFE_INTEGRA} EM DIANTE: faturamento real = NF-e autorizada de venda,
          -- pelo total da propria nota (ja deduplicada por emitente/serie/numero).
          SELECT ${docNf} AS doc, ${nomeNf} AS nome,
                 to_char(${nfData("fi")},'YYYY-MM')                    AS mes,
                 COALESCE(NULLIF(fi.total_invoice::text,'')::numeric,0) AS v,
                 1                                                      AS n
          FROM ${nfVendaFrom("fi")}
          WHERE ${nfVendaWhere("fi")}
            AND ${nfData("fi")}::date >= '${iniDate}'
            AND ${nfData("fi")}::date <  '${fimDateExcl}'
            AND to_char(${nfData("fi")},'YYYY-MM') >= '${MES_NFE_INTEGRA}'
            AND COALESCE(NULLIF(fi.total_invoice::text,'')::numeric,0) > 0
            AND NOT ${grupoNf}
            AND NOT ${lixeiraNf}
        )`;
}

/** 'YYYY-MM' -> 'abr/2026', para a tela. */
function rotuloMes(m: string): string {
  const N = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  const [a, b] = m.split("-");
  return `${N[Number(b) - 1] || b}/${a}`;
}

/** Texto curto da regua, para a tela explicar de onde vem o numero. */
export function descricaoFonte(): string {
  return `faturamento real — NF-e de venda autorizada emitida pelo INTEGRA, de `
    + `${rotuloMes(MES_NFE_INTEGRA)} em diante; antes disso, títulos emitidos `
    + `(o INTEGRA ainda não emitia NF-e)`;
}
