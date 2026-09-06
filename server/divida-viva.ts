// ============================================================================
// OPERAÇÕES INFORMATIVAS — o que NÃO é dívida do cliente
// ----------------------------------------------------------------------------
// Nem toda nota emitida para um cliente é cobrança. Estas operações existem no
// financeiro por rastreabilidade, mas NÃO são débito dele:
//
//   DEVOLUÇÃO DE VENDA .............. entrada, não saída a receber
//   [GYN] / [BSB] / [IND] ........... faturamento de OUTRA PRAÇA / filial do grupo
//   TROCA DE MERCADORIA ............. substituição, sem novo valor a receber
//   REMESSA DE AMOSTRA GRÁTIS ....... brinde
//   "Outra saída de mercadoria ou prestação de serviço não especificado"
//                                     (CFOP 5949/6949 — bonificação, remessa)
//
// Onde isto vale (decisão do Flavio, 02/set/2026 — antes a regra existia SÓ no
// Extrato, e o mesmo título seguia bloqueando venda e indo para cobrança):
//   • Extrato do Cliente ....... fora do saldo devedor / vencido / a vencer
//   • Badge da Rota do Dia ..... não entra no valor de débito do card
//   • Bloqueio de crédito ...... não trava pedido novo
//   • Alerta de WhatsApp ....... não vira cobrança para o vendedor
//
// A regra é uma só, aqui, para não voltar a existir em cópias divergentes —
// mesma lição de ghost-receivables.ts.
// ============================================================================

import { sql, type SQL } from "drizzle-orm";
import { naoEFantasmaText } from "./ghost-receivables";

/** Padrão único. Ao acrescentar um marcador, mexa SÓ aqui. */
export const FORA_DA_DIVIDA_RE =
  /DEVOLU|\[GYN\]|\[BSB\]|\[IND\]|TROCA|AMOSTRA|OUTRAS?\s+SA[IÍ]DAS?/i;

/** Versão JS: recebe a descrição (ou categoria) já resolvida. */
export function foraDaDivida(descricao: any): boolean {
  return FORA_DA_DIVIDA_RE.test(String(descricao || ""));
}

/**
 * Versão TEXTO (SQL puro, sem parâmetro) de "este título É dívida viva" (não é
 * devolução / outra praça / troca / amostra / CFOP 5949). `alias` é o apelido da
 * tabela `receivables`. Olha description E category — no Extrato a descrição da
 * nota é `description || category`, e o marcador pode estar em qualquer um dos dois.
 */
export function ehDividaVivaText(alias: string): string {
  // ATENCAO: isto e um TEMPLATE LITERAL. `\[` dentro dele vira `[` na string final,
  // e ai `[GYN]` deixaria de ser texto literal para virar CLASSE DE CARACTERES —
  // casando qualquer G, Y ou N e derrubando praticamente todo titulo. Por isso o
  // escape e DUPLO (`\\[`), para chegar ao Postgres como `\[`. Regressao real em
  // 02/set/2026: o badge e o bloqueio de credito zeraram por causa disto.
  // O literal vai entre aspas simples (standard_conforming_strings): a barra chega intacta.
  const marcadores = "(DEVOLU|\\[GYN\\]|\\[BSB\\]|\\[IND\\]|TROCA|AMOSTRA|OUTRAS?[[:space:]]+SA[IÍ]DAS?)";
  return `(COALESCE(${alias}.description, '') || ' ' || COALESCE(${alias}.category, '')) !~* '${marcadores}'`;
}

/**
 * Versão SQL (drizzle) da mesma condição, para o WHERE de qualquer leitura de débito:
 *
 *   FROM receivables r WHERE ... AND ${ehDividaViva('r')}
 */
export function ehDividaViva(alias: string): SQL {
  return sql.raw(ehDividaVivaText(alias));
}

// ============================================================================
// REGRA ÚNICA DE "DÉBITO VENCIDO VIVO" (E4, 06/set/2026)
// ----------------------------------------------------------------------------
// Depois do desligamento do Omie, a tabela `overdue_debts` (sync do ERP) ficou
// congelada em 26/ago e NÃO pode mais ser lida como fonte de débito. A fonte é a
// Contas a Receber (`receivables`), com ESTA condição — a mesma que bloqueia venda
// (storage.getOverdueDebtByDocument), lista a tela de Débitos Vencidos, alimenta o
// alerta de WhatsApp, a régua de recompra e os relatórios. Um título é débito vivo se:
//
//   1. não está excluído (deleted_at IS NULL)
//   2. tem saldo em aberto (amount - amount_paid > 0)
//   3. NÃO é fantasma (duplicata de reparo de órfãos — ghost-receivables.ts)
//   4. NÃO é operação informativa (devolução/outra praça/troca/amostra — acima)
//   5. NÃO é histórico migrado do Omie (import_origin <> 'omie_historico')
//   6. está EM ABERTO (status a_vencer/vencida) E venceu ANTES de hoje (dia-calendário
//      no fuso Brasil). A régua é a DATA, nunca o flag gravado: vencimento repostergado
//      para hoje/futuro NÃO é débito vivo. Vence HOJE não é vencida.
//
// O piso de tolerância (PISO_DEBITO_BLOQUEIO) é regra do BLOQUEIO DE CRÉDITO, aplicada
// sobre o TOTAL do cliente, não sobre o título — por isso fica fora do WHERE.
// ============================================================================

/** Débitos vencidos totais de até R$ 50,00 NÃO bloqueiam a venda (centavos / 1 dia). */
export const PISO_DEBITO_BLOQUEIO = 50;

export interface OpcoesDebitoVivo {
  /** SÓ para conferência (ex.: ?incluirHistorico=1 na tela): mantém a dívida migrada do Omie. */
  incluirHistoricoOmie?: boolean;
}

/** Versão TEXTO (SQL puro) da regra única. Para quem monta a query como string. */
export function whereDebitoVivoText(alias: string, opts: OpcoesDebitoVivo = {}): string {
  const a = alias;
  const semHistorico = opts.incluirHistoricoOmie ? '' : `AND COALESCE(${a}.import_origin, '') <> 'omie_historico'`;
  return `(
    ${a}.deleted_at IS NULL
    AND (${a}.amount - COALESCE(${a}.amount_paid, 0)) > 0
    AND ${naoEFantasmaText(a)}
    AND ${ehDividaVivaText(a)}
    ${semHistorico}
    AND ${a}.status IN ('a_vencer', 'vencida')
    AND (${a}.due_date)::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
  )`;
}

/**
 * Versão SQL (drizzle) da regra única:
 *
 *   FROM receivables r WHERE ${whereDebitoVivoSql('r')} AND <filtro do cliente>
 */
export function whereDebitoVivoSql(alias: string, opts: OpcoesDebitoVivo = {}): SQL {
  return sql.raw(whereDebitoVivoText(alias, opts));
}

/** Dias em atraso do título (hoje no fuso Brasil − vencimento), como expressão SQL. */
export function diasAtrasoText(alias: string): string {
  return `((now() AT TIME ZONE 'America/Sao_Paulo')::date - (${alias}.due_date)::date)`;
}
