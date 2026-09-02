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

/** Padrão único. Ao acrescentar um marcador, mexa SÓ aqui. */
export const FORA_DA_DIVIDA_RE =
  /DEVOLU|\[GYN\]|\[BSB\]|\[IND\]|TROCA|AMOSTRA|OUTRAS?\s+SA[IÍ]DAS?/i;

/** Versão JS: recebe a descrição (ou categoria) já resolvida. */
export function foraDaDivida(descricao: any): boolean {
  return FORA_DA_DIVIDA_RE.test(String(descricao || ""));
}

/**
 * Versão SQL: condição "este título É dívida viva", para o WHERE de qualquer
 * leitura de débito. `alias` é o apelido da tabela `receivables` na query.
 *
 *   FROM receivables r WHERE ... AND ${ehDividaViva('r')}
 *
 * Olha description E category — no Extrato a descrição da nota é
 * `description || category`, e o marcador pode estar em qualquer um dos dois.
 */
export function ehDividaViva(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(COALESCE(${a}.description, '') || ' ' || COALESCE(${a}.category, ''))
    !~* '(DEVOLU|\[GYN\]|\[BSB\]|\[IND\]|TROCA|AMOSTRA|OUTRAS?[[:space:]]+SA[IÍ]DAS?)'`;
}
