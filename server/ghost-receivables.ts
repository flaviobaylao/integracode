// ============================================================================
// TÍTULOS FANTASMAS — duplicatas criadas por rotina de reparo de órfãos
// ----------------------------------------------------------------------------
// Causa-raiz documentada em Titulo_Fantasma_NF102004_CausaRaiz_2026-08-04.md.
//
// Resumo: a Recuperação de Faturamento cria um SEGUNDO card no pipeline para uma
// NF que já tem card — e esse card nasce SEM `sales_card_id`. Quando o reparo de
// órfãos (`/api/admin/pipeline/backfill-missing-receivables`) roda, ele enxerga
// esse card como "faturado sem conta a receber", não acha a NF-e (que é buscada
// pelo `sales_card_id`, nulo) e cria um SEGUNDO título para a mesma nota — com o
// número cru da NF, vencimento novo e cobrança (boleto/PIX) emitida.
//
// O resultado é dívida que não existe: o cliente aparece devendo o que já pagou,
// no badge da Rota do Dia, no bloqueio de crédito e no alerta de cobrança.
//
// REGRA (a mesma do Extrato do Cliente): é fantasma o título que, para a MESMA NF
// e a MESMA instância Omie,
//   1. tem outro título ANCORADO na NF-e (`fiscal_invoice_id` preenchido);
//   2. não tem NF-e nem card de venda;
//   3. nasceu mais de 1 dia DEPOIS do ancorado;
//   4. não recebeu nenhum centavo.
//
// A condição 4 é deliberada: título com baixa NUNCA é escondido — dinheiro que
// entrou tem de continuar visível, senão o sistema passa a divergir do banco.
// ============================================================================

import { sql, type SQL } from "drizzle-orm";

/** Número da NF normalizado a partir do title_number: só dígitos, sem zeros à esquerda. */
function nfNormalizado(expr: string): string {
  return `LTRIM(REGEXP_REPLACE(COALESCE(${expr}, ''), '[^0-9]', '', 'g'), '0')`;
}

/**
 * Versão TEXTO (SQL puro, sem parâmetros) da condição "este título NÃO é
 * fantasma". Existe porque há leitores que montam a query como string
 * (reportEngine, mkt-recompra) e não como template `sql`. A versão `sql`
 * abaixo é só um `sql.raw` desta — regra única.
 */
export function naoEFantasmaText(alias: string): string {
  const a = alias;
  const nfDeste = nfNormalizado(`${a}.title_number`);
  return `NOT (
    ${a}.fiscal_invoice_id IS NULL
    AND ${a}.sales_card_id IS NULL
    AND COALESCE(${a}.amount_paid, 0) = 0
    AND NULLIF(${nfDeste}, '') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM receivables anc
      WHERE anc.deleted_at IS NULL
        AND anc.id <> ${a}.id
        AND anc.fiscal_invoice_id IS NOT NULL
        AND COALESCE(anc.omie_instance_id::text, '') = COALESCE(${a}.omie_instance_id::text, '')
        AND ${nfNormalizado('anc.title_number')} = ${nfDeste}
        AND anc.created_at < ${a}.created_at - INTERVAL '1 day'
    )
  )`;
}

/**
 * Condição "este título NÃO é fantasma", para entrar no WHERE de qualquer leitura
 * de débito. `alias` é o apelido da tabela `receivables` na query de fora.
 *
 *   FROM receivables r WHERE ... AND ${naoEFantasma('r')}
 */
export function naoEFantasma(alias: string): SQL {
  return sql.raw(naoEFantasmaText(alias));
}

/**
 * SELECT dos ids de todos os títulos fantasmas. Para quem filtra em JS em vez de
 * SQL (ex.: o alerta de débitos vencidos, que parte de storage.getReceivables).
 */
export function sqlIdsFantasmas(): SQL {
  return sql`SELECT r.id FROM receivables r WHERE r.deleted_at IS NULL AND NOT (${naoEFantasma("r")})`;
}
